import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCIAL_SEARCH_CREDITS } from '../src/billing/plans';
import { getSocialSearch, listSocialSearches, runSocialSearch, SOCIAL_SEARCH_ALL_MAX, socialSearchPayload } from '../src/convert/social-search';
import {
  parseFacebookSearch,
  parseInstagramSearch,
  parseLinkedInSearch,
  parseThreadsSearch,
  parseXSearch,
} from '../src/convert/social-search-providers';
import type { AppBindings, Principal } from '../src/env';
import { creditsUsedThisMonth } from '../src/lib/usage';
import { api } from '../src/routes/api';
import { SocialSearchPage } from '../src/views/dashboard';
import { callTool, toolNames } from './helpers/mcp-client';
import { createTestEnv, seedUser, type TestEnv } from './helpers/sqlite-env';

const tweet = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'tweet', tweet_id: id, screen_name: 'alice', text: `post ${id}`, created_at: 'Sat Oct 10 08:18:31 +0000 2026',
  favorites: 3, replies: 1, retweets: 2, views: '40', user_info: { screen_name: 'alice', name: 'Alice' },
  media: { photo: [{ media_url_https: 'https://pbs.twimg.com/media/a.jpg' }] }, ...extra,
});

describe('social search parsers', () => {
  it('normalizes X timelines and drops entries without a usable link', () => {
    const page = parseXSearch({ status: 'ok', timeline: [tweet('101'), { type: 'user', screen_name: 'bob' }, tweet('not-a-number')], next_cursor: 'c2' });
    expect(page.nextCursor).toBe('c2');
    expect(page.results).toEqual([{
      platform: 'x', id: '101', url: 'https://x.com/alice/status/101',
      author: { name: 'Alice', handle: 'alice', url: 'https://x.com/alice' },
      text: 'post 101', publishedAt: '2026-10-10T08:18:31.000Z',
      stats: { likes: 3, replies: 1, reposts: 2, views: 40 }, media: ['https://pbs.twimg.com/media/a.jpg'],
    }]);
    // The provider always returns a cursor; an empty page has nothing after it.
    expect(parseXSearch({ timeline: [], next_cursor: 'c3' })).toEqual({ results: [], nextCursor: null });
  });

  it('normalizes Facebook posts and rejects unsafe links', () => {
    const page = parseFacebookSearch({
      results: [
        { post_id: '1', url: 'https://www.facebook.com/zuck/posts/1', message: 'Hello', timestamp: 1790598910, reactions_count: 5, comments_count: 2, reshare_count: 1,
          author: { name: 'Mark', url: 'https://www.facebook.com/zuck' }, image: { uri: 'https://scontent.example.com/a.jpg' } },
        { post_id: '2', url: 'javascript:alert(1)', message: 'bad' },
      ],
      cursor: '{"page":1}',
    });
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({ platform: 'facebook', id: '1', author: { name: 'Mark', handle: null, url: 'https://www.facebook.com/zuck' }, stats: { likes: 5, replies: 2, reposts: 1, views: null } });
    expect(page.results[0].publishedAt).toBe(new Date(1790598910 * 1000).toISOString());
    expect(page.nextCursor).toBe('{"page":1}');
  });

  it('normalizes Instagram posts and stops paging when has_more is false', () => {
    const response = { items: [{ shortcode: 'DX1', url: 'https://www.instagram.com/reel/DX1/', caption: 'Reel', owner: { username: 'cam.era' }, view_count: 9, thumbnail_url: 'https://cdn.example.com/t.jpg' }], next_cursor: 'n', has_more: true };
    const page = parseInstagramSearch(response);
    expect(page.results[0]).toMatchObject({ id: 'DX1', author: { handle: 'cam.era', url: 'https://www.instagram.com/cam.era/' }, stats: { views: 9 }, media: ['https://cdn.example.com/t.jpg'] });
    expect(page.nextCursor).toBe('n');
    expect(parseInstagramSearch({ ...response, has_more: false }).nextCursor).toBeNull();
  });

  it('normalizes Threads results, skipping private authors, as a single page', () => {
    const post = (code: string, priv = false) => ({ node: { thread: { thread_items: [{ post: {
      pk: `pk${code}`, code, caption: { text: `t ${code}` }, taken_at: 1790000000, like_count: 4,
      user: { username: 'dev.user', text_post_app_is_private: priv }, text_post_app_info: { direct_reply_count: 2, repost_count: 1 },
    } }] } } });
    const page = parseThreadsSearch({ data: { searchResults: { edges: [post('AAA'), post('BBB', true)], page_info: { has_next_page: true, end_cursor: 'e1' } } } });
    expect(page.results.map((r) => r.url)).toEqual(['https://www.threads.net/@dev.user/post/AAA']);
    expect(page.results[0].stats).toEqual({ likes: 4, replies: 2, reposts: 1, views: null });
    expect(page.nextCursor).toBeNull();
    expect(parseThreadsSearch(null)).toEqual({ results: [], nextCursor: null });
  });

  it('normalizes LinkedIn posts with UTC timestamps as a single page', () => {
    const page = parseLinkedInSearch({ data: [{ urn: '7514', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7514/', text: 'Hi', posted: '2026-10-10 08:24:22.000',
      poster_name: 'Haseeb', poster_linkedin_url: 'https://www.linkedin.com/in/h', num_likes: 1, num_comments: 0, num_shares: 0, images: [] }] });
    expect(page.results[0]).toMatchObject({ id: '7514', publishedAt: '2026-10-10T08:24:22.000Z', author: { name: 'Haseeb', url: 'https://www.linkedin.com/in/h' } });
    expect(page.nextCursor).toBeNull();
  });
});

describe('runSocialSearch', () => {
  let t: TestEnv | null = null;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const flush = async () => { await Promise.all(pending.splice(0)); };
  afterEach(() => { vi.unstubAllGlobals(); t?.close(); t = null; });

  async function setup(plan = 'free') {
    t = createTestEnv({ RAPIDAPI_KEY: 'test-placeholder' } as never);
    const user = await seedUser(t, 'user', { plan });
    const principal: Principal = { kind: 'api_key', userId: user.id, role: 'user', scopes: ['convert'], apiKeyId: 'key_test' };
    return { env: t.env, user, principal };
  }
  const providerReturns = (status: number, body?: unknown) => {
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('charges one page price for results and records usage with a trace', async () => {
    const { env, user, principal } = await setup();
    const fetch = providerReturns(200, { timeline: [tweet('1'), tweet('2')], next_cursor: 'next' });
    const r = await runSocialSearch(env, ctx, { platform: 'x', query: ' cloudflare ', channel: 'api', principal });
    await flush();
    expect(r).toMatchObject({ platform: 'x', query: 'cloudflare', nextCursor: 'next', credits: SOCIAL_SEARCH_CREDITS.x });
    expect(r.results).toHaveLength(2);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://twitter-api45.p.rapidapi.com/search.php?query=cloudflare&search_type=Latest');
    expect(init?.headers).toMatchObject({ 'X-RapidAPI-Host': 'twitter-api45.p.rapidapi.com' });
    expect(await creditsUsedThisMonth(env, user.id)).toBe(SOCIAL_SEARCH_CREDITS.x);
    expect(t!.db.prepare("SELECT kind, target, credits, status FROM usage_events").all()).toEqual([{ kind: 'social_search', target: 'x:cloudflare', credits: SOCIAL_SEARCH_CREDITS.x, status: 'ok' }]);
    expect(t!.db.prepare('SELECT COUNT(*) AS n FROM traces').get()).toEqual({ n: 1 });
    expect(socialSearchPayload(r)).toMatchObject({ count: 2, next_cursor: 'next', credits: SOCIAL_SEARCH_CREDITS.x, platforms: [{ platform: 'x', count: 2, credits: SOCIAL_SEARCH_CREDITS.x, error: null }] });
    expect(socialSearchPayload(r).results[0]).toMatchObject({ published_at: '2026-10-10T08:18:31.000Z' });
  });

  it('is free when the provider has nothing (204) and falls back to the Threads top tab once', async () => {
    const { env, user, principal } = await setup();
    const fetch = providerReturns(204);
    const r = await runSocialSearch(env, ctx, { platform: 'threads', query: 'rare words', channel: 'mcp', principal });
    await flush();
    expect(r).toMatchObject({ results: [], nextCursor: null, credits: 0 });
    expect(fetch.mock.calls.map(([u]) => new URL(String(u)).pathname)).toEqual(['/api/search/recent', '/api/search/top']);
    expect(await creditsUsedThisMonth(env, user.id)).toBe(0);
  });

  it('posts the LinkedIn search body, and a cursor for a single-page platform is a free empty page', async () => {
    const { env, principal } = await setup();
    const fetch = providerReturns(200, { data: [{ urn: '1', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/', text: 'x' }] });
    const r = await runSocialSearch(env, ctx, { platform: 'linkedin', query: 'agents', channel: 'cli', principal });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://fresh-linkedin-profile-data.p.rapidapi.com/search-posts');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ search_keywords: 'agents', sort_by: 'Latest' });
    // The provider rejects the old `page` field.
    expect('page' in body).toBe(false);
    // LinkedIn pages cost more: its provider is about ten times pricier per search.
    expect(r).toMatchObject({ nextCursor: null, credits: SOCIAL_SEARCH_CREDITS.linkedin });
    expect(SOCIAL_SEARCH_CREDITS.linkedin).toBe(100);
    const paged = await runSocialSearch(env, ctx, { platform: 'threads', query: 'agents', cursor: 'x', channel: 'cli', principal });
    expect(paged).toMatchObject({ results: [], nextCursor: null, credits: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('releases the reservation when the provider fails', async () => {
    const { env, user, principal } = await setup();
    providerReturns(500);
    await expect(runSocialSearch(env, ctx, { platform: 'facebook', query: 'x', channel: 'api', principal })).rejects.toMatchObject({ status: 502, code: 'upstream_error' });
    await flush();
    expect(await creditsUsedThisMonth(env, user.id)).toBe(0);
    expect(t!.db.prepare("SELECT status, credits FROM usage_events").all()).toEqual([{ status: 'error', credits: 0 }]);
  });

  it('refuses before calling the provider: anonymous, invalid input, no key, too few credits', async () => {
    const { env, user, principal } = await setup();
    const fetch = providerReturns(200, { timeline: [tweet('1')] });
    const anonymous = { kind: 'anonymous', userId: null, role: 'user', scopes: ['convert'] } as unknown as Principal;
    await expect(runSocialSearch(env, ctx, { platform: 'x', query: 'a', channel: 'api', principal: anonymous })).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
    await expect(runSocialSearch(env, ctx, { platform: 'tiktok', query: 'a', channel: 'api', principal })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await expect(runSocialSearch(env, ctx, { platform: 'x', query: '  ', channel: 'api', principal })).rejects.toMatchObject({ status: 400 });
    await expect(runSocialSearch({ ...env, RAPIDAPI_KEY: undefined }, ctx, { platform: 'x', query: 'a', channel: 'api', principal })).rejects.toMatchObject({ status: 503, code: 'provider_unavailable' });
    // Free plan with 5 credits left cannot buy a 10-credit page.
    t!.db.prepare("INSERT INTO usage_events (id,user_id,channel,kind,target,status,http_status,credits,duration_ms,created_at) VALUES ('e1',?,'api','convert','t','ok',200,495,1,?)").run(user.id, Date.now());
    await expect(runSocialSearch(env, ctx, { platform: 'x', query: 'a', channel: 'api', principal })).rejects.toMatchObject({ status: 402, code: 'quota_exceeded' });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(await creditsUsedThisMonth(env, user.id)).toBe(495);
  });

  /** Answers each provider host with its own response; unknown hosts have nothing (204). */
  const providersAnswer = (answers: Record<string, (url: URL) => Response>) => {
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = new URL(String(input));
      return answers[url.hostname]?.(url) ?? new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('searches every platform for "all", merges newest first and charges only platforms with results', async () => {
    const { env, user, principal } = await setup('pro');
    const fetch = providersAnswer({
      'twitter-api45.p.rapidapi.com': (u) => json(u.searchParams.get('cursor') === 'x2'
        ? { timeline: [tweet('3', { created_at: 'Sat Oct 10 07:00:00 +0000 2026' })], next_cursor: 'x3' }
        : { timeline: [tweet('1', { created_at: 'Sat Oct 10 06:00:00 +0000 2026' })], next_cursor: 'x2' }),
      'instagram-pro-and-cheap-api.p.rapidapi.com': () => json({ items: [{ shortcode: 'IG1', url: 'https://www.instagram.com/p/IG1/', caption: 'c', owner: { username: 'u' }, taken_at: Date.parse('2026-10-10T09:00:00Z') / 1000 }], next_cursor: 'i2', has_more: true }),
      'facebook-scraper3.p.rapidapi.com': () => json({ message: 'boom' }, 500),
    });
    const r = await runSocialSearch(env, ctx, { platform: 'all', query: 'cats', channel: 'api', principal });
    await flush();
    expect(r.results.map((x) => x.id)).toEqual(['IG1', '1']);
    expect(r.platforms).toEqual([
      { platform: 'x', count: 1, credits: SOCIAL_SEARCH_CREDITS.x, error: null },
      { platform: 'facebook', count: 0, credits: 0, error: expect.stringMatching(/^upstream_error: /) },
      { platform: 'instagram', count: 1, credits: SOCIAL_SEARCH_CREDITS.instagram, error: null },
      { platform: 'threads', count: 0, credits: 0, error: null },
      { platform: 'linkedin', count: 0, credits: 0, error: null },
    ]);
    expect(r.credits).toBe(SOCIAL_SEARCH_CREDITS.x + SOCIAL_SEARCH_CREDITS.instagram);
    expect(await creditsUsedThisMonth(env, user.id)).toBe(r.credits);
    expect(t!.db.prepare("SELECT target, credits FROM usage_events").all()).toEqual([{ target: 'all:cats', credits: r.credits }]);

    // The next page only asks the platforms that had one, each with its own cursor.
    fetch.mockClear();
    const next = await runSocialSearch(env, ctx, { platform: 'all', query: 'cats', cursor: r.nextCursor!, channel: 'api', principal });
    await flush();
    const asked = fetch.mock.calls.map(([u]) => new URL(String(u)));
    expect(asked.map((u) => u.hostname).sort()).toEqual(['instagram-pro-and-cheap-api.p.rapidapi.com', 'twitter-api45.p.rapidapi.com']);
    expect(asked.find((u) => u.hostname.startsWith('twitter'))!.searchParams.get('cursor')).toBe('x2');
    expect(asked.find((u) => u.hostname.startsWith('instagram'))!.searchParams.get('cursor')).toBe('i2');
    expect(next.platforms.map((p) => p.platform)).toEqual(['x', 'instagram']);
    expect(next.results.map((x) => x.id)).toEqual(['IG1', '3']);
  });

  it('rejects a foreign "all" cursor, fails when every platform fails, and refuses "all" without enough credits', async () => {
    const { env, user, principal } = await setup();
    const fetch = providersAnswer({});
    await expect(runSocialSearch(env, ctx, { platform: 'all', query: 'cats', cursor: 'not-a-cursor', channel: 'api', principal })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(runSocialSearch(env, ctx, { platform: 'all', query: 'cats', channel: 'api', principal })).rejects.toMatchObject({ status: 502 });
    await flush();
    expect(await creditsUsedThisMonth(env, user.id)).toBe(0);

    // "all" reserves every platform's page price up front.
    t!.db.prepare("INSERT INTO usage_events (id,user_id,channel,kind,target,status,http_status,credits,duration_ms,created_at) VALUES ('e1',?,'api','convert','t','ok',200,?,1,?)").run(user.id, 500 - SOCIAL_SEARCH_ALL_MAX + 1, Date.now());
    await expect(runSocialSearch(env, ctx, { platform: 'all', query: 'cats', channel: 'api', principal })).rejects.toMatchObject({ status: 402, message: expect.stringContaining(`${SOCIAL_SEARCH_ALL_MAX} credits`) });
    await flush();
  });

  it('saves each search to the history, newest first, readable only by its owner', async () => {
    const { env, user, principal } = await setup();
    providerReturns(200, { timeline: [tweet('1')], next_cursor: 'n2' });
    const first = await runSocialSearch(env, ctx, { platform: 'x', query: 'first', channel: 'cli', principal });
    const second = await runSocialSearch(env, ctx, { platform: 'x', query: 'second', cursor: 'n1', channel: 'web', principal });
    await flush();
    const history = await listSocialSearches(env, user.id);
    expect(history.map((h) => [h.query, h.channel, h.paged, h.resultCount, h.credits])).toEqual([
      ['second', 'web', true, 1, SOCIAL_SEARCH_CREDITS.x],
      ['first', 'cli', false, 1, SOCIAL_SEARCH_CREDITS.x],
    ]);
    expect(history[1].id).toBe(first.traceId);
    const saved = await getSocialSearch(env, user.id, first.traceId);
    expect(saved).toMatchObject({ platform: 'x', query: 'first', nextCursor: 'n2', credits: SOCIAL_SEARCH_CREDITS.x, channel: 'cli', paged: false });
    expect(saved!.results).toEqual(first.results);
    expect(saved!.platforms).toEqual(first.platforms);
    const other = await seedUser(t!, 'user');
    expect(await getSocialSearch(env, other.id, second.traceId)).toBeNull();
    expect(await listSocialSearches(env, other.id)).toEqual([]);
  });

  it('is served over REST and MCP with the same payload', async () => {
    const { env, principal } = await setup();
    providerReturns(200, { items: [{ shortcode: 'DX1', url: 'https://www.instagram.com/p/DX1/', caption: 'c', owner: { username: 'u' } }], has_more: false });
    const app = new Hono<AppBindings>();
    app.use('*', async (c, next) => { c.set('principal', principal); await next(); });
    app.route('/api/v1', api);
    const execution = { waitUntil: ctx.waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const res = await app.fetch(new Request('https://anymd.test/api/v1/social/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'instagram', query: 'cats' }) }), env, execution);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Anymd-Credits')).toBe(String(SOCIAL_SEARCH_CREDITS.instagram));
    expect(await res.json()).toMatchObject({ platform: 'instagram', count: 1, next_cursor: null, results: [{ id: 'DX1', author: { handle: 'u' } }] });

    const bad = await app.fetch(new Request('https://anymd.test/api/v1/social/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'myspace', query: 'x' }) }), env, execution);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const mcpPrincipal = principal as Principal & { userId: string };
    expect((await toolNames(env, mcpPrincipal)).includes('search_social')).toBe(true);
    const call = await callTool(env, mcpPrincipal, 'search_social', { platform: 'instagram', query: 'cats' });
    expect(call.result.isError).toBeFalsy();
    expect(call.result.structuredContent).toMatchObject({ platform: 'instagram', count: 1, credits: SOCIAL_SEARCH_CREDITS.instagram });
    await flush();
  });
});

describe('dashboard social search page', () => {
  it('renders results with escaped text, safe links and a next-page form', () => {
    const result = { platform: 'x' as const, query: 'cats', credits: 10, traceId: 't', durationMs: 5, nextCursor: 'c"2', platforms: [{ platform: 'x' as const, count: 1, credits: 10, error: null }],
      results: [{ platform: 'x' as const, id: '1', url: 'https://x.com/a/status/1', author: { name: 'A', handle: 'a', url: 'https://x.com/a' }, text: '<script>alert(1)</script>', publishedAt: null, stats: { likes: 2, replies: null, reposts: null, views: null }, media: [] }] };
    const html = String(<SocialSearchPage platform="x" q="cats" result={result} />);
    expect(html.includes('<script>alert')).toBe(false);
    expect(html.includes('/convert?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1')).toBe(true);
    expect(html.includes('name="cursor"')).toBe(true);
    expect(html.includes('method="post"')).toBe(true);
    expect(html.includes(`More results (${SOCIAL_SEARCH_CREDITS.x} credits)`)).toBe(true);
  });

  it('labels each result and platform for "all", and links past searches from the history', () => {
    const post = (platform: 'x' | 'linkedin', id: string) => ({ platform, id, url: `https://example.com/${id}`, author: { name: 'A', handle: null, url: null }, text: 't', publishedAt: null, stats: { likes: null, replies: null, reposts: null, views: null }, media: [] });
    const nextCursor = btoa(JSON.stringify({ x: 'c2' })).replace(/=+$/, '');
    const result = { platform: 'all' as const, query: 'cats', credits: 110, traceId: 'trc_1', durationMs: 5, nextCursor, results: [post('linkedin', 'L1'), post('x', 'X1')],
      platforms: [{ platform: 'x' as const, count: 1, credits: 10, error: null }, { platform: 'facebook' as const, count: 0, credits: 0, error: 'upstream_error: down' }, { platform: 'linkedin' as const, count: 1, credits: 100, error: null }] };
    const history = [
      { id: 'trc_1', platform: 'all' as const, query: 'cats', channel: 'web', paged: false, resultCount: 2, credits: 110, createdAt: Date.now() },
      { id: 'trc_0', platform: 'x' as const, query: 'older <b>', channel: 'cli', paged: true, resultCount: 0, credits: 0, createdAt: Date.now() - 60_000 },
    ];
    const html = String(<SocialSearchPage platform="all" q="cats" result={result} history={history} saved={{ channel: 'web', createdAt: Date.now() }} />);
    expect(html.includes('value="all" checked')).toBe(true);
    expect(html.includes('LinkedIn</span>')).toBe(true);
    expect(html.includes('Facebook: unavailable')).toBe(true);
    expect(html.includes(`More results (up to ${SOCIAL_SEARCH_CREDITS.x} credits)`)).toBe(true);
    expect(html.includes('href="/dashboard/social/trc_0"')).toBe(true);
    expect(html.includes('aria-current="page"')).toBe(true);
    expect(html.includes('older <b>')).toBe(false);
    expect(html.includes('Saved search from')).toBe(true);
  });
});
