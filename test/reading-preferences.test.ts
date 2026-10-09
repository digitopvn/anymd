import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, Principal } from '../src/env';
import { conversionDatabase, d1 } from './helpers/sqlite-d1';
import { ConversionBudget } from '../src/convert/enrichment-types';
import {
  applyPreferencesPatch,
  normalizeStoredPreferences,
  ReadingPreferencesError,
  resolveReadingOptions,
  type RequestReadingOptions,
} from '../src/convert/reading-preferences';
import { reservationCredits, runConversion } from '../src/convert/service';
import type { ConvertContext, ConvertResult } from '../src/convert/types';
import { boundedThread, enrichX, type Tweet } from '../src/convert/x-thread';
import { creditEstimateText, DEFAULT_READING_PREFERENCES, maxEnrichmentCredits, type ReadingPreferences } from '../src/lib/reading-options';

const prefs = (overrides: Partial<ReadingPreferences> = {}): ReadingPreferences => Object.freeze({ ...DEFAULT_READING_PREFERENCES, ...overrides });

describe('reading option precedence: request > saved preference > safe default', () => {
  const toggles = ['expandThread', 'includeComments', 'analyzeImages'] as const;

  for (const key of toggles) {
    it.each([
      // [request, saved preference (null = none saved), expected value, expected source]
      [undefined, null, false, 'default'],
      [undefined, false, false, 'preference'],
      [undefined, true, true, 'preference'],
      [true, null, true, 'request'],
      [true, false, true, 'request'],
      [false, true, false, 'request'],
      [false, null, false, 'request'],
    ] as const)(`${key}: request %s, saved %s -> %s (%s)`, (request, saved, expected, source) => {
      const resolved = resolveReadingOptions({ [key]: request } as RequestReadingOptions, saved === null ? null : prefs({ [key]: saved }));
      expect(resolved[key]).toBe(expected);
      expect(resolved.sources[key]).toBe(source);
    });
  }

  it('gives a user with no saved preferences base conversion only, even when signed in', () => {
    const resolved = resolveReadingOptions({}, null);
    expect(resolved).toMatchObject({ expandThread: false, includeComments: false, analyzeImages: false, removeImages: false, maxThreadPosts: 20, maxCredits: 100 });
    expect(Object.values(resolved.sources).every((source) => source === 'default')).toBe(true);
  });

  it('applies bounded numbers with the same precedence', () => {
    const saved = prefs({ maxThreadPosts: 40, maxCredits: 30 });
    const resolved = resolveReadingOptions({ maxThreadPosts: 5 }, saved);
    expect(resolved.maxThreadPosts).toBe(5);
    expect(resolved.sources.maxThreadPosts).toBe('request');
    expect(resolved.maxCredits).toBe(30);
    expect(resolved.sources.maxCredits).toBe('preference');
  });

  it('maps keepImages onto removeImages and lets an explicit option win a conflict', () => {
    expect(resolveReadingOptions({}, prefs({ keepImages: false })).removeImages).toBe(true);
    expect(resolveReadingOptions({ removeImages: false }, prefs({ keepImages: false })).removeImages).toBe(false);
    const explicitAnalysis = resolveReadingOptions({ analyzeImages: true }, prefs({ keepImages: false }));
    expect(explicitAnalysis).toMatchObject({ analyzeImages: true, removeImages: false });
    const explicitRemoval = resolveReadingOptions({ removeImages: true }, prefs({ analyzeImages: true }));
    expect(explicitRemoval).toMatchObject({ analyzeImages: false, removeImages: true });
    expect(() => resolveReadingOptions({ analyzeImages: true, removeImages: true }, null)).toThrowError(expect.objectContaining({ code: 'invalid_options' }));
  });

  it('never mutates the saved preferences when a request overrides them', () => {
    const saved = prefs({ expandThread: true, maxThreadPosts: 50 });
    const snapshot = JSON.stringify(saved);
    resolveReadingOptions({ expandThread: false, maxThreadPosts: 3, removeImages: true }, saved);
    expect(JSON.stringify(saved)).toBe(snapshot);
  });
});

describe('reading preference validation', () => {
  it('merges a partial update and keeps omitted fields', () => {
    const next = applyPreferencesPatch(prefs({ includeComments: true }), { expandThread: true, maxThreadPosts: 30 });
    expect(next).toEqual({ ...DEFAULT_READING_PREFERENCES, includeComments: true, expandThread: true, maxThreadPosts: 30 });
  });

  it.each([
    [{ maxThreadPosts: 0 }, 'maxThreadPosts must be an integer from 1 to 100'],
    [{ maxThreadPosts: 101 }, 'maxThreadPosts must be an integer from 1 to 100'],
    [{ maxComments: 1.5 }, 'maxComments must be an integer from 1 to 1000'],
    [{ maxImages: 21 }, 'maxImages must be an integer from 1 to 20'],
    [{ maxCredits: 1001 }, 'maxCredits must be an integer from 1 to 1000'],
    [{ expandThread: 'yes' }, 'expandThread must be true or false'],
    [{ keepImages: false, analyzeImages: true }, 'analyzeImages requires keepImages'],
  ])('rejects %j with a clear message', (patch, message) => {
    let error: unknown;
    try {
      applyPreferencesPatch(prefs(), patch);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReadingPreferencesError);
    // toContain trips over the DOM globals the linkedom polyfill installs, so compare with includes.
    expect((error as ReadingPreferencesError).message.includes(message), (error as Error).message).toBe(true);
    expect((error as ReadingPreferencesError).status).toBe(422);
  });

  it('rejects unknown fields', () => {
    expect(() => applyPreferencesPatch(prefs(), { maxCreditz: 5 })).toThrow(ReadingPreferencesError);
  });

  it('reads stored rows deterministically: clamps out-of-range numbers and falls back on malformed data', () => {
    expect(normalizeStoredPreferences(JSON.stringify({ maxThreadPosts: 500, maxImages: 0, maxComments: 12.6, expandThread: true }))).toEqual({
      ...DEFAULT_READING_PREFERENCES, maxThreadPosts: 100, maxImages: 1, maxComments: 13, expandThread: true,
    });
    expect(normalizeStoredPreferences('{not json')).toEqual(DEFAULT_READING_PREFERENCES);
    expect(normalizeStoredPreferences(JSON.stringify({ expandThread: 'yes', analyzeImages: true, keepImages: false }))).toEqual({
      ...DEFAULT_READING_PREFERENCES, keepImages: false,
    });
  });
});

describe('bounded credit impact', () => {
  it('estimates the worst case of enabled enrichment only', () => {
    expect(maxEnrichmentCredits(prefs()).total).toBe(0);
    expect(maxEnrichmentCredits(prefs({ expandThread: true, maxThreadPosts: 20 }))).toMatchObject({ thread: 19, total: 19 });
    expect(maxEnrichmentCredits(prefs({ includeComments: true, maxComments: 21 })).comments).toBe(20);
    expect(maxEnrichmentCredits(prefs({ analyzeImages: true, maxImages: 3 })).images).toBe(15);
    expect(creditEstimateText(prefs()).startsWith('Base conversion only')).toBe(true);
    expect(creditEstimateText(prefs({ analyzeImages: true, maxImages: 20, maxCredits: 50 })).includes('up to 50 credits')).toBe(true);
  });

  it('reserves only the base price for X conversions without opted-in enrichment', () => {
    const x = new URL('https://x.com/alice/status/2');
    expect(reservationCredits(x, resolveReadingOptions({}, null))).toBe(1);
    expect(reservationCredits(x, resolveReadingOptions({}, prefs({ expandThread: true, maxCredits: 40 })))).toBe(40);
  });
});

describe('X thread bounds', () => {
  const tweet = (id: string): Tweet => ({ id, parent: '', conversation: '1', authorId: 'a', handle: 'alice', text: id });

  it('keeps at most maxThreadPosts members and always the requested post', () => {
    const members = ['1', '2', '3', '4', '5'].map(tweet);
    expect(boundedThread(members, '2', 3).map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(boundedThread(members, '5', 2).map((t) => t.id)).toEqual(['4', '5']);
    expect(boundedThread(members, '3', 10)).toHaveLength(5);
  });

  it('makes no provider call for a signed-in caller who did not opt in', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = { source: 'https://x.com/alice/status/2', content: 'post' } as ConvertResult;
    await enrichX(result, {
      authenticated: true,
      budget: new ConversionBudget(100),
      env: { RAPIDAPI_KEY: 'test-placeholder' },
      tracer: { span: async (_name: string, fn: () => Promise<unknown>) => fn() },
    } as unknown as ConvertContext);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.enrichment).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

// ─── runConversion end to end over SQLite ─────────────────────────────────────

function setup(saved?: Partial<ReadingPreferences>) {
  const db = conversionDatabase();
  db.prepare('INSERT INTO users (id, plan) VALUES (?, ?)').run('u1', 'pro');
  if (saved) db.prepare('INSERT INTO reading_preferences (user_id, preferences, updated_at) VALUES (?,?,?)').run('u1', JSON.stringify({ ...DEFAULT_READING_PREFERENCES, ...saved }), 1);
  const cache = { get: async () => null, put: async () => undefined };
  const env = { DB: d1(db), CACHE: cache, RAPIDAPI_KEY: 'test-placeholder' } as unknown as Env;
  return { db, env };
}

/** Thread 1 <- 2 <- 3 by the same author; fxtwitter serves each post body. */
function stubX() {
  const calls: string[] = [];
  const row = (id: string, parent: string) => ({ tweet_id: id, in_reply_to_status_id_str: parent, conversation_id: '1', user_info: { screen_name: 'alice', rest_id: 'a1' }, text: `post ${id}` });
  const rows: Record<string, ReturnType<typeof row>> = { '1': row('1', ''), '2': row('2', '1'), '3': row('3', '2') };
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(`${url.host}${url.pathname}`);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.host === 'api.fxtwitter.com') {
      const id = url.pathname.split('/').pop()!;
      return json({ tweet: { id, text: `post ${id}`, author: { name: 'Alice', screen_name: 'alice' }, created_at: '2026-10-01' } });
    }
    if (url.pathname === '/tweet.php') return json(rows[url.searchParams.get('id')!]);
    if (url.pathname === '/search.php') return json({ timeline: Object.values(rows) });
    return new Response('not found', { status: 404 });
  }));
  return calls;
}

const user: Principal = { kind: 'api_key', userId: 'u1', role: 'user', scopes: ['convert'] };
const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined) };
const convert = (env: Env, extra: Partial<Parameters<typeof runConversion>[2]> = {}) =>
  runConversion(env, ctx, { url: 'https://x.com/alice/status/1', channel: 'api', principal: user, save: false, fresh: true, ...extra });
const providerCalls = (calls: string[]) => calls.filter((call) => call.startsWith('twitter-api45'));

describe('runConversion reading preferences', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not expand X threads for a signed-in user without saved preferences', async () => {
    const { db, env } = setup();
    const calls = stubX();
    try {
      const r = await convert(env);
      expect(providerCalls(calls)).toEqual([]);
      expect(r.credits).toBe(1);
      expect(r.creditBreakdown).toEqual({ base: 1, thread: 0, comments: 0, images: 0 });
      expect(r.result.enrichment).toBeUndefined();
      expect(r.readingOptions.sources.expandThread).toBe('default');
      expect(db.prepare('SELECT reserved FROM conversion_charges').get()).toEqual({ reserved: 1 });
    } finally {
      db.close();
    }
  });

  it('expands the thread from a saved opt-in, bounded by maxThreadPosts', async () => {
    const { db, env } = setup({ expandThread: true, maxThreadPosts: 2 });
    const calls = stubX();
    try {
      const r = await convert(env);
      expect(providerCalls(calls).length).toBeGreaterThan(0);
      expect(r.creditBreakdown).toEqual({ base: 1, thread: 1, comments: 0, images: 0 });
      expect(r.result.enrichment?.thread).toMatchObject({ complete: false, reason: 'thread_limit', count: 2 });
      expect(r.readingOptions.sources).toMatchObject({ expandThread: 'preference', maxThreadPosts: 'preference' });
    } finally {
      db.close();
    }
  });

  it('lets an explicit request turn a saved opt-in off without rewriting the saved preferences', async () => {
    const { db, env } = setup({ expandThread: true });
    const calls = stubX();
    try {
      const before = db.prepare('SELECT preferences, updated_at FROM reading_preferences').get();
      const r = await convert(env, { expandThread: false });
      expect(providerCalls(calls)).toEqual([]);
      expect(r.credits).toBe(1);
      expect(r.readingOptions.sources.expandThread).toBe('request');
      expect(db.prepare('SELECT preferences, updated_at FROM reading_preferences').get()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('honours an explicit per-request opt-in when nothing is saved', async () => {
    const { db, env } = setup();
    stubX();
    try {
      const r = await convert(env, { expandThread: true });
      expect(r.creditBreakdown).toEqual({ base: 1, thread: 2, comments: 0, images: 0 });
      expect(r.result.enrichment?.thread).toMatchObject({ complete: true, count: 3 });
    } finally {
      db.close();
    }
  });

  it('rejects an anonymous thread opt-in and an out-of-range maxThreadPosts', async () => {
    const { db, env } = setup();
    stubX();
    try {
      const anonymous: Principal = { kind: 'anonymous', userId: null, role: 'user', scopes: ['convert'] } as unknown as Principal;
      await expect(convert(env, { principal: anonymous, expandThread: true })).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
      await expect(convert(env, { expandThread: true, maxThreadPosts: 101 })).rejects.toMatchObject({ code: 'invalid_options', status: 400 });
    } finally {
      db.close();
    }
  });
});
