import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCIAL_SEARCH_CREDITS } from '../src/billing/plans';
import { getSocialSearch, listSocialSearches, runSocialSearch, socialSearchPayload, type SocialSearchResponse } from '../src/convert/social-search';
import type { SocialSearchResult } from '../src/convert/social-search-providers';
import {
  canonicalPostUrl, filterPage, MAX_RANGE_DAYS, parseTimestamp, postKey, resolveTimeRange, sameRequestedRange, zonedDayStart,
} from '../src/convert/social-search-results';
import { parseSessionCursor, SESSION_MAX_PAGES, SESSION_TTL_MS, sweepExpiredSessions } from '../src/convert/social-search-session';
import type { AppBindings, Principal } from '../src/env';
import { creditsUsedThisMonth } from '../src/lib/usage';
import { api } from '../src/routes/api';
import { SocialSearchPage } from '../src/views/dashboard';
import { callTool } from './helpers/mcp-client';
import { createTestEnv, seedUser, type TestEnv } from './helpers/sqlite-env';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 86_400_000;

const post = (over: Partial<SocialSearchResult> & Pick<SocialSearchResult, 'platform' | 'id' | 'url'>): SocialSearchResult => ({
  author: { name: 'A', handle: null, url: null }, text: 't', publishedAt: '2026-10-12T00:00:00.000Z', stats: { likes: null, replies: null, reposts: null, views: null }, media: [], ...over,
});

describe('time ranges', () => {
  it('parses zoned ISO timestamps and bare dates as UTC, rejecting impossible or zoneless values', () => {
    expect(parseTimestamp('2026-10-01', 'since')).toBe(Date.UTC(2026, 9, 1));
    expect(parseTimestamp('2026-10-01T07:00:00+07:00', 'since')).toBe(Date.UTC(2026, 9, 1));
    expect(parseTimestamp('2026-10-01T00:00:00.5Z', 'since')).toBe(Date.UTC(2026, 9, 1, 0, 0, 0, 500));
    expect(parseTimestamp('2026-10-01T00:00-05:30', 'since')).toBe(Date.UTC(2026, 9, 1, 5, 30));
    for (const bad of ['2026-02-30', '2026-10-01T25:00:00Z', '2026-10-01T00:00:00', '2026-10-01T00:00:00+15:00', '2026-10-01T00:00:00+14:30', 'yesterday', '1696118400']) {
      expect(() => parseTimestamp(bad, 'since'), bad).toThrow(expect.objectContaining({ status: 400, code: 'invalid_request' }));
    }
  });

  it('anchors a period at the request time and validates custom bounds', () => {
    expect(resolveTimeRange({}, NOW)).toBeNull();
    expect(resolveTimeRange({ period: '7d' }, NOW)).toEqual({ period: '7d', since: NOW - 7 * DAY, until: NOW });
    expect(resolveTimeRange({ period: '24h' }, NOW)).toEqual({ period: '24h', since: NOW - DAY, until: NOW });
    expect(resolveTimeRange({ since: '2026-10-01' }, NOW)).toEqual({ period: null, since: Date.UTC(2026, 9, 1), until: null });
    expect(resolveTimeRange({ until: '2026-10-01' }, NOW)).toEqual({ period: null, since: null, until: Date.UTC(2026, 9, 1) });
    // A future end is fine (the range just includes now); a future start is not.
    expect(resolveTimeRange({ since: '2026-10-01', until: '2026-12-01' }, NOW)?.until).toBe(Date.UTC(2026, 11, 1));
    const refuse = (input: Parameters<typeof resolveTimeRange>[0], message: RegExp) =>
      expect(() => resolveTimeRange(input, NOW)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_request', message: expect.stringMatching(message) }));
    refuse({ period: '7d', since: '2026-10-01' }, /either period or since\/until/);
    refuse({ since: '2026-10-05', until: '2026-10-05' }, /before until/);
    refuse({ since: '2026-10-06', until: '2026-10-05' }, /before until/);
    refuse({ since: '2026-10-14' }, /future/);
    refuse({ since: '2003-12-31' }, /too far in the past/);
    refuse({ since: '2025-01-01', until: '2026-01-03' }, new RegExp(`${MAX_RANGE_DAYS} days`));
    expect(resolveTimeRange({ since: '2025-01-01', until: '2026-01-02' }, NOW)).not.toBeNull();
  });

  it('accepts the original filter, or none, alongside a cursor', () => {
    const period = resolveTimeRange({ period: '7d' }, NOW);
    const custom = resolveTimeRange({ since: '2026-10-01', until: '2026-10-05' }, NOW);
    expect(sameRequestedRange({}, period)).toBe(true);
    expect(sameRequestedRange({ period: '7d' }, period)).toBe(true);
    expect(sameRequestedRange({ period: '30d' }, period)).toBe(false);
    expect(sameRequestedRange({ since: '2026-10-01T00:00:00Z', until: '2026-10-05T00:00:00Z' }, custom)).toBe(true);
    expect(sameRequestedRange({ since: '2026-10-01' }, custom)).toBe(false);
    expect(sameRequestedRange({ period: '7d' }, null)).toBe(false);
  });

  it('turns calendar days in a time zone into UTC instants, across DST changes', () => {
    expect(zonedDayStart('2026-10-01', 'UTC')).toBe('2026-10-01T00:00:00.000Z');
    expect(zonedDayStart('2026-10-01', 'Asia/Ho_Chi_Minh')).toBe('2026-09-30T17:00:00.000Z');
    expect(zonedDayStart('2026-10-05', 'Asia/Ho_Chi_Minh', 1)).toBe('2026-10-05T17:00:00.000Z');
    // New York: EDT (-4) before 2026-11-01, EST (-5) after.
    expect(zonedDayStart('2026-11-01', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z');
    expect(zonedDayStart('2026-11-02', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z');
    expect(zonedDayStart('not-a-date', 'UTC')).toBeNull();
  });
});

describe('exact post identity', () => {
  it('canonicalizes hosts, tracking parameters and trailing slashes only', () => {
    expect(canonicalPostUrl('https://www.twitter.com/a/status/1/?utm_source=x&s=20#frag')).toBe('https://x.com/a/status/1');
    expect(canonicalPostUrl('https://m.facebook.com/story.php?story_fbid=9&id=2&fbclid=abc')).toBe('https://facebook.com/story.php?id=2&story_fbid=9');
    expect(canonicalPostUrl('https://www.threads.com/@a/post/XYZ')).toBe('https://threads.net/@a/post/XYZ');
    expect(canonicalPostUrl('javascript:alert(1)')).toBeNull();
  });

  it('keys posts by their platform id, so URL variants match and cross-posts stay distinct', () => {
    expect(postKey(post({ platform: 'x', id: '42', url: 'https://x.com/a/status/42' }))).toBe('x:42');
    expect(postKey(post({ platform: 'x', id: 'weird', url: 'https://twitter.com/i/web/status/42?s=20' }))).toBe('x:42');
    expect(postKey(post({ platform: 'instagram', id: '3141', url: 'https://www.instagram.com/reel/ABC/?igsh=1' }))).toBe('instagram:ABC');
    expect(postKey(post({ platform: 'instagram', id: 'ABC', url: 'https://instagram.com/someone/p/ABC/' }))).toBe('instagram:ABC');
    expect(postKey(post({ platform: 'threads', id: 'pk1', url: 'https://www.threads.com/@a/post/QQ' }))).toBe('threads:QQ');
    expect(postKey(post({ platform: 'linkedin', id: 'urn:li:activity:7514000', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7514000/' }))).toBe('linkedin:7514000');
    expect(postKey(post({ platform: 'linkedin', id: '', url: 'https://www.linkedin.com/posts/jane_hello-activity-7514000-AbCd' }))).toBe('linkedin:7514000');
    expect(postKey(post({ platform: 'facebook', id: '1234_5678', url: 'https://www.facebook.com/zuck/posts/pfbid0abc' }))).toBe('facebook:1234_5678');
    // The same text on X and Threads is two posts.
    expect(postKey(post({ platform: 'x', id: '7', url: 'https://x.com/a/status/7' }))).not.toBe(postKey(post({ platform: 'threads', id: '7', url: 'https://www.threads.net/@a/post/7' })));
  });

  it('removes duplicates within and across pages, keeps the most complete copy, then applies the range', () => {
    const range = { period: null, since: Date.UTC(2026, 9, 10), until: Date.UTC(2026, 9, 12) };
    const sparse = post({ platform: 'x', id: '1', url: 'https://twitter.com/a/status/1', text: '', publishedAt: '2026-10-11T00:00:00Z' });
    const full = post({ platform: 'x', id: '1', url: 'https://x.com/a/status/1', text: 'full', publishedAt: '2026-10-11T00:00:00Z', stats: { likes: 5, replies: 1, reposts: 0, views: 9 } });
    const page = [
      sparse,
      post({ platform: 'x', id: '2', url: 'https://x.com/a/status/2', publishedAt: '2026-10-09T23:59:59.999Z' }),
      post({ platform: 'x', id: '3', url: 'https://x.com/a/status/3', publishedAt: '2026-10-12T00:00:00Z' }), // until is exclusive
      post({ platform: 'x', id: '4', url: 'https://x.com/a/status/4', publishedAt: null }),
      full,
      post({ platform: 'x', id: '5', url: 'https://x.com/a/status/5', publishedAt: '2026-10-10T00:00:00Z' }), // since is inclusive
      post({ platform: 'x', id: '6', url: 'https://x.com/a/status/6' }),
    ];
    const f = filterPage(page, range, new Set(['x:6']));
    expect(f.kept.map((r) => r.id)).toEqual(['1', '5']);
    expect(f.kept[0]).toBe(full);
    // Stats are kept from one copy, never summed.
    expect(f.kept[0].stats.likes).toBe(5);
    expect(f.keys).toEqual(['x:1', 'x:5']);
    expect(f.counts).toEqual({ raw: 7, duplicates: 2, outOfRange: 2, missingTimestamp: 1 });
    expect(f.counts.raw).toBe(f.kept.length + f.counts.duplicates + f.counts.outOfRange + f.counts.missingTimestamp);
    // Without a range, undated and old posts are kept.
    expect(filterPage(page, null, new Set()).kept.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});

describe('runSocialSearch with filters and paging sessions', () => {
  let t: TestEnv | null = null;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const flush = async () => { await Promise.all(pending.splice(0)); };
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); t?.close(); t = null; });

  async function setup(plan = 'pro') {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = createTestEnv({ RAPIDAPI_KEY: 'test-placeholder' } as never);
    const user = await seedUser(t, 'user', { plan });
    const principal: Principal = { kind: 'api_key', userId: user.id, role: 'user', scopes: ['convert'], apiKeyId: 'key_test' };
    return { env: t.env, user, principal };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const answer = (answers: Record<string, (url: URL, init?: RequestInit) => Response>) => {
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      return answers[url.hostname]?.(url, init) ?? new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const tweet = (id: string, at: string) => ({
    type: 'tweet', tweet_id: id, screen_name: 'alice', text: `post ${id}`, created_at: new Date(at).toUTCString().replace('GMT', '+0000'),
    user_info: { screen_name: 'alice', name: 'Alice' },
  });
  const xPages = (pages: Record<string, { ids: [string, string][]; next: string | null }>) => ({
    'twitter-api45.p.rapidapi.com': (u: URL) => {
      const page = pages[u.searchParams.get('cursor') ?? ''];
      return json({ timeline: page.ids.map(([id, at]) => tweet(id, at)), ...(page.next ? { next_cursor: page.next } : {}) });
    },
  });
  const sessions = () => t!.db.prepare('SELECT id, version, pages, period, since_ms, until_ms FROM social_search_sessions').all() as { id: string; version: number; pages: number }[];

  it('filters X natively, keeps the range across pages and never repeats a post', async () => {
    const { env, user, principal } = await setup();
    const fetch = answer(xPages({
      '': { ids: [['1', '2026-10-12T10:00:00Z'], ['2', '2026-10-11T10:00:00Z']], next: 'c2' },
      c2: { ids: [['2', '2026-10-11T10:00:00Z'], ['3', '2026-10-10T10:00:00Z'], ['4', '2026-09-01T00:00:00Z']], next: 'c3' },
      c3: { ids: [['3', '2026-10-10T10:00:00Z']], next: 'c4' },
      c4: { ids: [], next: null },
    }));
    const first = await runSocialSearch(env, ctx, { platform: 'x', query: 'Cats', period: '7d', channel: 'api', principal });
    const q = new URL(String(fetch.mock.calls[0][0])).searchParams.get('query');
    expect(q).toBe(`Cats since_time:${(NOW - 7 * DAY) / 1000} until_time:${NOW / 1000}`);
    expect(first).toMatchObject({
      coverage: 'native', timeRange: { period: '7d', since: new Date(NOW - 7 * DAY).toISOString(), until: new Date(NOW).toISOString() },
      rawCount: 2, nextPageCredits: SOCIAL_SEARCH_CREDITS.x, platforms: [{ platform: 'x', filterMode: 'native', rawCount: 2, count: 2 }],
    });
    expect(first.results.map((r) => r.id)).toEqual(['1', '2']);

    // Later: the window does not slide, and the cursor carries it without repeating period.
    vi.setSystemTime(NOW + 3_600_000);
    const second = await runSocialSearch(env, ctx, { platform: 'x', query: 'cats', cursor: first.nextCursor!, channel: 'api', principal });
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('query')).toBe(q!.replace('Cats', 'cats'));
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('cursor')).toBe('c2');
    expect(second.results.map((r) => r.id)).toEqual(['3']);
    expect(second).toMatchObject({ rawCount: 3, duplicateCount: 1, outOfRangeCount: 1, credits: SOCIAL_SEARCH_CREDITS.x, timeRange: first.timeRange });
    expect(parseSessionCursor(second.nextCursor!).id).toBe(parseSessionCursor(first.nextCursor!).id);

    // A page with only duplicates is empty, still charged (the provider returned posts), and still has a next page.
    const third = await runSocialSearch(env, ctx, { platform: 'x', query: 'cats', cursor: second.nextCursor!, period: '7d', channel: 'api', principal });
    expect(third).toMatchObject({ results: [], rawCount: 1, duplicateCount: 1, credits: SOCIAL_SEARCH_CREDITS.x, nextCursor: expect.stringMatching(/^amdss2\./) });
    const last = await runSocialSearch(env, ctx, { platform: 'x', query: 'cats', cursor: third.nextCursor!, channel: 'api', principal });
    expect(last).toMatchObject({ results: [], nextCursor: null, credits: 0, nextPageCredits: 0 });
    // The finished session is gone.
    expect(sessions()).toEqual([]);
    await flush();
    expect(await creditsUsedThisMonth(env, user.id)).toBe(3 * SOCIAL_SEARCH_CREDITS.x);
    const usage = t!.db.prepare("SELECT meta FROM traces WHERE kind = 'social_search' ORDER BY created_at, rowid").all() as { meta: string }[];
    expect(JSON.parse(usage[1].meta)).toMatchObject({ raw_count: 3, unique_count: 2, duplicate_count: 1, out_of_range_count: 1, coverage: 'native', time_filter: '7d', platforms: [{ filter_mode: 'native', raw: 3 }] });
  });

  it('refuses a replayed or concurrent cursor without charging, and releases a cursor whose page failed', async () => {
    const { env, user, principal } = await setup();
    let fail = false;
    answer({ 'twitter-api45.p.rapidapi.com': (u) => (fail ? json({ message: 'down' }, 500) : json({ timeline: [tweet(u.searchParams.get('cursor') ? '2' : '1', '2026-10-12T00:00:00Z')], next_cursor: `${u.searchParams.get('cursor') ?? ''}n` })) });
    const first = await runSocialSearch(env, ctx, { platform: 'x', query: 'cats', channel: 'api', principal });
    await flush();
    const used = await creditsUsedThisMonth(env, user.id);

    fail = true;
    await expect(runSocialSearch(env, ctx, { platform: 'x', query: 'cats', cursor: first.nextCursor!, channel: 'api', principal })).rejects.toMatchObject({ status: 502 });
    fail = false;
    // The failed page did not use up the cursor; two requests race for it and exactly one wins.
    const race = await Promise.allSettled([1, 2].map(() => runSocialSearch(env, ctx, { platform: 'x', query: 'cats', cursor: first.nextCursor!, channel: 'api', principal })));
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'cursor_conflict' } });
    await expect(runSocialSearch(env, ctx, { platform: 'x', query: 'cats', cursor: first.nextCursor!, channel: 'api', principal })).rejects.toMatchObject({ status: 409, code: 'cursor_conflict' });
    await flush();
    expect(await creditsUsedThisMonth(env, user.id)).toBe(used + SOCIAL_SEARCH_CREDITS.x);
  });

  it('binds a cursor to its owner, search and range, and expires it after 24 hours', async () => {
    const { env, principal } = await setup();
    let n = 0;
    const fetch = answer({ 'twitter-api45.p.rapidapi.com': () => json({ timeline: [tweet(String(++n), '2026-10-12T00:00:00Z')], next_cursor: `n${n}` }) });
    const first = await runSocialSearch(env, ctx, { platform: 'x', query: 'cats', since: '2026-10-01', channel: 'api', principal });
    const cursor = first.nextCursor!;
    fetch.mockClear();
    const other = await seedUser(t!, 'user', { plan: 'pro' });
    const otherPrincipal: Principal = { ...principal, userId: other.id };
    const tries: [Partial<Parameters<typeof runSocialSearch>[2]>, object][] = [
      [{ principal: otherPrincipal }, { status: 400, code: 'cursor_expired' }],
      [{ query: 'dogs' }, { status: 400, code: 'invalid_request', message: expect.stringContaining('different search') }],
      [{ platform: 'all' }, { status: 400, code: 'invalid_request' }],
      [{ since: '2026-10-02' }, { status: 400, code: 'invalid_request', message: expect.stringContaining('different time range') }],
      [{ period: '7d' }, { status: 400, code: 'invalid_request' }],
      [{ cursor: `${cursor.slice(0, -1)}9` }, { status: 409, code: 'cursor_conflict' }],
      [{ cursor: 'amdss2.sss_nope.1' }, { status: 400, code: 'invalid_request' }],
      [{ cursor: 'amdss2.sss_0000000000.1' }, { status: 400, code: 'cursor_expired' }],
    ];
    for (const [change, error] of tries) {
      const outcome = await runSocialSearch(env, ctx, { platform: 'x', query: 'cats', cursor, channel: 'api', principal, ...change }).then(() => 'resolved', (e) => e);
      expect(outcome, JSON.stringify(change)).toMatchObject(error);
    }
    expect(fetch).not.toHaveBeenCalled();
    // Same query with other case and spacing, and the same range spelled differently, are the same search.
    const ok = await runSocialSearch(env, ctx, { platform: 'x', query: '  CATS ', since: '2026-10-01T07:00:00+07:00', cursor, channel: 'api', principal });
    expect(ok.timeRange).toEqual(first.timeRange);

    vi.setSystemTime(NOW + SESSION_TTL_MS + 1);
    await expect(runSocialSearch(env, ctx, { platform: 'x', query: 'cats', cursor: ok.nextCursor!, channel: 'api', principal })).rejects.toMatchObject({ status: 400, code: 'cursor_expired' });
    expect(await sweepExpiredSessions(env, Date.now())).toBe(1);
    expect(sessions()).toEqual([]);
    await flush();
  });

  it('accepts older provider cursors without filters only', async () => {
    const { env, principal } = await setup();
    const fetch = answer(xPages({ old: { ids: [['9', '2026-10-12T00:00:00Z']], next: 'old2' } }));
    const r = await runSocialSearch(env, ctx, { platform: 'x', query: 'cats', cursor: 'old', channel: 'api', principal });
    expect(r.results.map((x) => x.id)).toEqual(['9']);
    expect(r.nextCursor).toMatch(/^amdss2\./);
    const legacyAll = btoa(JSON.stringify({ x: 'old' })).replace(/=+$/, '');
    await expect(runSocialSearch(env, ctx, { platform: 'all', query: 'cats', cursor: legacyAll, period: '24h', channel: 'api', principal })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('predates time filters') });
    expect(fetch).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('stops a provider that repeats its cursor, and ends paging at the session limit', async () => {
    const { env, principal } = await setup();
    answer({ 'twitter-api45.p.rapidapi.com': (u) => json({ timeline: [tweet(String(Number(u.searchParams.get('cursor') ?? 0) + 1), '2026-10-12T00:00:00Z')], next_cursor: 'same' }) });
    const first = await runSocialSearch(env, ctx, { platform: 'x', query: 'loop', channel: 'api', principal });
    expect(first.nextCursor).toMatch(/^amdss2\./);
    // The provider answered cursor "same" with "same" again: there is no new page.
    answer({ 'twitter-api45.p.rapidapi.com': () => json({ timeline: [tweet('77', '2026-10-12T00:00:00Z')], next_cursor: 'same' }) });
    const second = await runSocialSearch(env, ctx, { platform: 'x', query: 'loop', cursor: first.nextCursor!, channel: 'api', principal });
    expect(second).toMatchObject({ nextCursor: null, sessionLimitReached: false });

    let n = 0;
    answer({ 'twitter-api45.p.rapidapi.com': () => { n++; return json({ timeline: [tweet(String(1000 + n), '2026-10-12T00:00:00Z')], next_cursor: `p${n}` }); } });
    let page = await runSocialSearch(env, ctx, { platform: 'x', query: 'deep', channel: 'api', principal });
    for (let i = 2; i <= SESSION_MAX_PAGES; i++) page = await runSocialSearch(env, ctx, { platform: 'x', query: 'deep', cursor: page.nextCursor!, channel: 'api', principal });
    expect(page).toMatchObject({ nextCursor: null, sessionLimitReached: true, nextPageCredits: 0 });
    expect(n).toBe(SESSION_MAX_PAGES);
    await flush();
  });

  it('post-filters the other platforms in "all", reports partial coverage and bills platforms whose posts were all removed', async () => {
    const { env, user, principal } = await setup();
    const at = (iso: string) => Date.parse(iso) / 1000;
    answer({
      'twitter-api45.p.rapidapi.com': () => json({ timeline: [tweet('1', '2026-10-12T00:00:00Z')] }),
      'facebook-scraper3.p.rapidapi.com': () => json({ results: [
        { post_id: '11', url: 'https://www.facebook.com/a/posts/11', message: 'old', timestamp: at('2026-09-01T00:00:00Z'), author: { name: 'A' } },
      ] }),
      'instagram-pro-and-cheap-api.p.rapidapi.com': () => json({ items: [
        { shortcode: 'IG1', url: 'https://www.instagram.com/p/IG1/', caption: 'a', owner: { username: 'u' }, taken_at: at('2026-10-11T00:00:00Z') },
        { shortcode: 'IG1', url: 'https://www.instagram.com/reel/IG1/?igsh=x', caption: '', owner: { username: 'u' }, taken_at: at('2026-10-11T00:00:00Z') },
        { shortcode: 'IG2', url: 'https://www.instagram.com/p/IG2/', caption: 'no date', owner: { username: 'u' } },
      ], has_more: false }),
      'fresh-linkedin-profile-data.p.rapidapi.com': () => json({ data: [{ urn: '7514000', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7514000/', text: 'in range', posted: '2026-10-12 08:00:00.000' }] }),
    });
    const r = await runSocialSearch(env, ctx, { platform: 'all', query: 'cats', period: '7d', channel: 'api', principal });
    await flush();
    expect(r.results.map((x) => x.id)).toEqual(['7514000', '1', 'IG1']);
    expect(r.coverage).toBe('provider_limited');
    expect(r).toMatchObject({ rawCount: 6, duplicateCount: 1, outOfRangeCount: 1, missingTimestampCount: 1, nextCursor: null });
    const by = Object.fromEntries(r.platforms.map((p) => [p.platform, p]));
    expect(by.x).toMatchObject({ filterMode: 'native', count: 1 });
    expect(by.facebook).toMatchObject({ filterMode: 'post_filter', count: 0, rawCount: 1, outOfRangeCount: 1, credits: SOCIAL_SEARCH_CREDITS.facebook });
    expect(by.instagram).toMatchObject({ count: 1, rawCount: 3, duplicateCount: 1, missingTimestampCount: 1 });
    expect(by.threads).toMatchObject({ count: 0, rawCount: 0, credits: 0 });
    const charged = SOCIAL_SEARCH_CREDITS.x + SOCIAL_SEARCH_CREDITS.facebook + SOCIAL_SEARCH_CREDITS.instagram + SOCIAL_SEARCH_CREDITS.linkedin;
    expect(r.credits).toBe(charged);
    expect(await creditsUsedThisMonth(env, user.id)).toBe(charged);

    // The history keeps the filter details; reopening it shows the same summary.
    const [item] = await listSocialSearches(env, user.id);
    expect(item.timeRange).toEqual(r.timeRange);
    const saved = await getSocialSearch(env, user.id, r.traceId);
    expect(saved).toMatchObject({ coverage: 'provider_limited', rawCount: 6, duplicateCount: 1, timeRange: r.timeRange, platforms: r.platforms });

    expect(socialSearchPayload(r)).toMatchObject({
      raw_count: 6, duplicate_count: 1, out_of_range_count: 1, missing_timestamp_count: 1, coverage: 'provider_limited', time_range: r.timeRange, next_page_credits: 0,
      platforms: expect.arrayContaining([expect.objectContaining({ platform: 'facebook', raw_count: 1, out_of_range_count: 1, filter_mode: 'post_filter' })]),
    });
  });

  it('reads history rows saved before filters existed', async () => {
    const { env, user } = await setup();
    t!.db.prepare(`INSERT INTO social_searches (id, user_id, platform, query, channel, paged, result_count, credits, results_json, platforms_json, next_cursor, duration_ms, created_at)
      VALUES ('trc_old', ?, 'x', 'cats', 'web', 0, 0, 10, '[]', '[{"platform":"x","count":0,"credits":10,"error":null}]', 'raw-cursor', 5, ?)`).run(user.id, NOW);
    const saved = await getSocialSearch(env, user.id, 'trc_old');
    expect(saved).toMatchObject({ timeRange: null, coverage: 'unfiltered', rawCount: 0, nextPageCredits: SOCIAL_SEARCH_CREDITS.x, platforms: [{ platform: 'x', rawCount: 0, filterMode: 'none' }] });
    expect((await listSocialSearches(env, user.id))[0].timeRange).toBeNull();
  });

  it('takes filters over REST and MCP, and maps cursor errors to their status', async () => {
    const { env, principal } = await setup();
    let n = 0;
    answer({ 'twitter-api45.p.rapidapi.com': () => json({ timeline: [tweet(String(++n), '2026-10-12T00:00:00Z')], next_cursor: `n${n}` }) });
    const app = new Hono<AppBindings>();
    app.use('*', async (c, next) => { c.set('principal', principal); await next(); });
    app.route('/api/v1', api);
    const execution = { waitUntil: ctx.waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const post = (body: object) => app.fetch(new Request('https://anymd.test/api/v1/social/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, execution);

    const res = await post({ platform: 'x', query: 'cats', since: '2026-10-01', until: '2026-10-13' });
    expect(res.status).toBe(200);
    const body = await res.json() as ReturnType<typeof socialSearchPayload>;
    expect(body).toMatchObject({ count: 1, coverage: 'native', time_range: { period: null, since: '2026-10-01T00:00:00.000Z', until: '2026-10-13T00:00:00.000Z' }, next_page_credits: SOCIAL_SEARCH_CREDITS.x });
    expect((await post({ platform: 'x', query: 'cats', cursor: body.next_cursor })).status).toBe(200);
    const replay = await post({ platform: 'x', query: 'cats', cursor: body.next_cursor });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: 'cursor_conflict' } });
    const bad = await post({ platform: 'x', query: 'cats', period: '1y' });
    expect(bad.status).toBe(400);

    const call = await callTool(env, principal as Principal & { userId: string }, 'search_social', { platform: 'x', query: 'cats', period: '24h' });
    expect(call.result.isError).toBeFalsy();
    expect(call.result.structuredContent).toMatchObject({ coverage: 'native', time_range: { period: '24h' } });
    await flush();
  });
});

describe('dashboard social filters', () => {
  const result = (over: Partial<SocialSearchResponse>): SocialSearchResponse => ({
    platform: 'all', query: 'cats', results: [], nextCursor: 'amdss2.sss_0123456789.2', nextPageCredits: 20, credits: 20, traceId: 't', durationMs: 5,
    rawCount: 3, duplicateCount: 1, outOfRangeCount: 2, missingTimestampCount: 0, coverage: 'provider_limited', sessionLimitReached: false,
    timeRange: { period: '7d', since: '2026-10-06T12:00:00.000Z', until: '2026-10-13T12:00:00.000Z' },
    platforms: [
      { platform: 'x', count: 0, credits: 10, error: null, rawCount: 1, duplicateCount: 1, outOfRangeCount: 0, missingTimestampCount: 0, filterMode: 'native' },
      { platform: 'instagram', count: 0, credits: 10, error: null, rawCount: 2, duplicateCount: 0, outOfRangeCount: 2, missingTimestampCount: 0, filterMode: 'post_filter' },
    ],
    ...over,
  });

  it('shows the range, what was removed, partial coverage and an empty filtered page', () => {
    const html = String(<SocialSearchPage platform="all" q="cats" filters={{ period: '7d', from: '', to: '', tz: 'Asia/Ho_Chi_Minh' }} result={result({})} />);
    expect(html.includes('<option value="7d" selected')).toBe(true);
    expect(html.includes('Last 7 days</span>: 2026-10-06 12:00 UTC → 2026-10-13 12:00 UTC')).toBe(true);
    expect(html.includes('1 duplicate removed · 2 outside the range')).toBe(true);
    expect(html.includes('Partial coverage: Instagram is filtered by date after fetching')).toBe(true);
    expect(html.includes('Instagram: 0 of 2')).toBe(true);
    expect(html.includes('No new posts on this page')).toBe(true);
    expect(html.includes('More results (up to 20 credits)')).toBe(true);
    // The next page form keeps showing the filter; the cursor alone sets the range.
    expect(html.includes('<input type="hidden" name="period" value="7d"')).toBe(true);
    expect(html.includes('<input type="hidden" name="tz" value="Asia/Ho_Chi_Minh"')).toBe(true);
  });

  it('distinguishes an empty search from an exhausted one', () => {
    const none = String(<SocialSearchPage platform="x" q="cats" result={result({ platform: 'x', rawCount: 0, duplicateCount: 0, outOfRangeCount: 0, nextCursor: null, nextPageCredits: 0, timeRange: null, coverage: 'unfiltered', platforms: [] })} />);
    expect(none.includes('No posts found')).toBe(true);
    expect(none.includes('Partial coverage')).toBe(false);
    const limit = String(<SocialSearchPage platform="x" q="cats" result={result({ platform: 'x', nextCursor: null, sessionLimitReached: true })} />);
    expect(limit.includes('reached its paging limit')).toBe(true);
    expect(limit.includes('name="cursor"')).toBe(false);
  });
});
