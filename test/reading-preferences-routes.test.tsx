import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppBindings, Env, Principal } from '../src/env';
import { api } from '../src/routes/api';
import { buildOpenApi } from '../src/openapi';
import { DEFAULT_READING_PREFERENCES } from '../src/lib/reading-options';
import { ReadingOptionsFields } from '../src/views/components/reading-options-fields';
import { ReadingPreferencesSection } from '../src/views/reading-preferences-section';
import { AccountPage, OverviewPage, TraceDetailPage } from '../src/views/dashboard';
import type { UserRow } from '../src/auth/identity';
import { conversionDatabase, d1, type SqliteDatabase } from './helpers/sqlite-d1';

const user: Principal = { kind: 'api_key', userId: 'u1', role: 'user', scopes: ['convert'] };
const execution = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
let db: SqliteDatabase | null = null;

function client(principal: Principal) {
  db = conversionDatabase();
  db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
  const env = { DB: d1(db), RL_AUTH: { limit: async () => ({ success: true }) }, RL_ANON: { limit: async () => ({ success: true }) } } as unknown as Env;
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => { c.set('principal', principal); await next(); });
  app.route('/api/v1', api);
  return (method: string, body?: unknown) => app.fetch(new Request('https://anymd.cc/api/v1/account/reading-preferences', {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), env, execution);
}

afterEach(() => { db?.close(); db = null; });

describe('REST reading preferences', () => {
  it('returns the safe defaults when nothing is saved', async () => {
    const res = await client(user)('GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ preferences: DEFAULT_READING_PREFERENCES, saved: false, updated_at: null });
  });

  it('partially updates, persists per user, and resets', async () => {
    const call = client(user);
    const put = await call('PUT', { expandThread: true, maxThreadPosts: 30 });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ saved: true, preferences: { ...DEFAULT_READING_PREFERENCES, expandThread: true, maxThreadPosts: 30 } });
    const second = await call('PUT', { includeComments: true });
    expect(((await second.json()) as { preferences: unknown }).preferences).toMatchObject({ expandThread: true, maxThreadPosts: 30, includeComments: true });
    const reset = await call('DELETE');
    expect(await reset.json()).toMatchObject({ saved: false, preferences: DEFAULT_READING_PREFERENCES });
    expect(db!.prepare('SELECT COUNT(*) AS n FROM reading_preferences').get()).toEqual({ n: 0 });
  });

  it('rejects out-of-range, unknown and conflicting fields with field details', async () => {
    const call = client(user);
    for (const body of [{ maxThreadPosts: 0 }, { maxImages: 99 }, { surprise: true }, { keepImages: false, analyzeImages: true }]) {
      const res = await call('PUT', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      const error = ((await res.json()) as { error: { code: string; details: unknown[] } }).error;
      expect(error.code).toBe('invalid_preferences');
      expect(error.details.length).toBeGreaterThan(0);
    }
    expect((await call('PUT', '{not json')).status).toBe(400);
    expect(db!.prepare('SELECT COUNT(*) AS n FROM reading_preferences').get()).toEqual({ n: 0 });
  });

  it('requires an account and the convert scope', async () => {
    const anonymous = { kind: 'anonymous', userId: null, role: 'user', scopes: ['convert'] } as unknown as Principal;
    expect((await client(anonymous)('GET')).status).toBe(401);
    db?.close();
    expect((await client({ ...user, scopes: ['library:read'] })('PUT', { expandThread: true })).status).toBe(403);
  });

  it('is described in the OpenAPI document', () => {
    const spec = buildOpenApi('https://anymd.cc');
    const path = spec.paths['/account/reading-preferences'] as Record<string, unknown>;
    expect(Object.keys(path).sort()).toEqual(['delete', 'get', 'put']);
    const convertBody = JSON.stringify(spec.paths['/convert']);
    expect(convertBody.includes('expandThread') && convertBody.includes('maxThreadPosts')).toBe(true);
  });
});

describe('reading options UI', () => {
  const html = (node: unknown) => String(node);

  it('labels every control, separates base from extra-credit options and marks prices', () => {
    const out = html(<ReadingOptionsFields values={DEFAULT_READING_PREFERENCES} idPrefix="t" imagesName="images" />);
    for (const id of ['keep-images', 'expand-thread', 'max-thread-posts', 'include-comments', 'max-comments', 'analyze-images', 'max-images', 'max-credits']) {
      expect(out.includes(`id="t-${id}"`), id).toBe(true);
      expect(out.includes(`for="t-${id}"`), id).toBe(true);
    }
    expect(out.includes('Base conversion · no extra credits')).toBe(true);
    expect(out.includes('may use extra credits, off by default')).toBe(true);
    expect(out.includes('aria-describedby="t-expand-thread-hint"')).toBe(true);
    expect(out.includes('per additional X thread post')).toBe(true);
    expect(out.includes('data-requires="expandThread"')).toBe(true);
    expect(out.includes('aria-live="polite"')).toBe(true);
    // Safe defaults: only the free image retention toggle starts checked.
    expect(out.match(/checked=""/g)?.length).toBe(1);
  });

  it('renders the account section with a CSRF-safe same-origin form and status messages', () => {
    const out = html(<ReadingPreferencesSection stored={{ preferences: { ...DEFAULT_READING_PREFERENCES, expandThread: true }, saved: true, updatedAt: Date.UTC(2026, 9, 9) }} error="bad value" />);
    expect(out.includes('id="reading-defaults"')).toBe(true);
    expect(out.includes('action="/dashboard/account/reading"')).toBe(true);
    expect(out.includes('method="post"')).toBe(true);
    expect(out.includes('role="alert"')).toBe(true);
    expect(out.includes('name="keepImages"')).toBe(true);
    expect(out.includes('Reset to safe defaults')).toBe(true);
  });

  it('renders the account page section, the prefilled dashboard converter and trace credit sources', () => {
    const account = { id: 'u1', email: 'a@example.com', name: 'A', role: 'user', plan: 'free', created_at: 0 } as unknown as UserRow;
    const saved = { preferences: { ...DEFAULT_READING_PREFERENCES, includeComments: true }, saved: true, updatedAt: 1 };
    expect(html(<AccountPage user={account} docs={0} reading={{ stored: saved }} />).includes('Deep reading defaults')).toBe(true);
    const quota = { plan: 'free', included: 500, extra: 0, used: 0, remaining: 500, overage: false };
    const overview = html(<OverviewPage user={account} quota={quota} docs={0} words={0} recent={[]} month={{ conversions: 0, errors: 0 }} keyCount={0} origin="https://anymd.cc" reading={saved} />);
    expect(overview.includes('data-reading-source="saved"')).toBe(true);
    expect(overview.includes('Prefilled from your saved reading defaults')).toBe(true);
    const trace = html(<TraceDetailPage trace={{ id: 't', kind: 'convert', target: 'https://x.com/a/status/1', status: 'ok', duration_ms: 5, spans: '[]', created_at: 0,
      meta: JSON.stringify({ credit_breakdown: { base: 1, thread: 4, comments: 0, images: 0 }, reading_options: { expandThread: true, sources: { expandThread: 'preference' } } }) }} />);
    expect(trace.includes('X thread posts')).toBe(true);
    expect(trace.includes('saved default')).toBe(true);
  });
});
