import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCIAL_SEARCH_CREDITS } from '../src/billing/plans';
import { runSocialSearch, socialSearchPayload } from '../src/convert/social-search';
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
    expect(r).toMatchObject({ platform: 'x', query: 'cloudflare', nextCursor: 'next', credits: SOCIAL_SEARCH_CREDITS });
    expect(r.results).toHaveLength(2);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://twitter-api45.p.rapidapi.com/search.php?query=cloudflare&search_type=Latest');
    expect(init?.headers).toMatchObject({ 'X-RapidAPI-Host': 'twitter-api45.p.rapidapi.com' });
    expect(await creditsUsedThisMonth(env, user.id)).toBe(SOCIAL_SEARCH_CREDITS);
    expect(t!.db.prepare("SELECT kind, target, credits, status FROM usage_events").all()).toEqual([{ kind: 'social_search', target: 'x:cloudflare', credits: SOCIAL_SEARCH_CREDITS, status: 'ok' }]);
    expect(t!.db.prepare('SELECT COUNT(*) AS n FROM traces').get()).toEqual({ n: 1 });
    expect(socialSearchPayload(r)).toMatchObject({ count: 2, next_cursor: 'next', credits: SOCIAL_SEARCH_CREDITS, });
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
    expect(r).toMatchObject({ nextCursor: null, credits: SOCIAL_SEARCH_CREDITS });
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

  it('is served over REST and MCP with the same payload', async () => {
    const { env, principal } = await setup();
    providerReturns(200, { items: [{ shortcode: 'DX1', url: 'https://www.instagram.com/p/DX1/', caption: 'c', owner: { username: 'u' } }], has_more: false });
    const app = new Hono<AppBindings>();
    app.use('*', async (c, next) => { c.set('principal', principal); await next(); });
    app.route('/api/v1', api);
    const execution = { waitUntil: ctx.waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const res = await app.fetch(new Request('https://anymd.test/api/v1/social/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'instagram', query: 'cats' }) }), env, execution);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Anymd-Credits')).toBe(String(SOCIAL_SEARCH_CREDITS));
    expect(await res.json()).toMatchObject({ platform: 'instagram', count: 1, next_cursor: null, results: [{ id: 'DX1', author: { handle: 'u' } }] });

    const bad = await app.fetch(new Request('https://anymd.test/api/v1/social/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'myspace', query: 'x' }) }), env, execution);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const mcpPrincipal = principal as Principal & { userId: string };
    expect((await toolNames(env, mcpPrincipal)).includes('search_social')).toBe(true);
    const call = await callTool(env, mcpPrincipal, 'search_social', { platform: 'instagram', query: 'cats' });
    expect(call.result.isError).toBeFalsy();
    expect(call.result.structuredContent).toMatchObject({ platform: 'instagram', count: 1, credits: SOCIAL_SEARCH_CREDITS });
    await flush();
  });
});

describe('dashboard social search page', () => {
  it('renders results with escaped text, safe links and a next-page form', () => {
    const result = { platform: 'x' as const, query: 'cats', credits: 10, traceId: 't', durationMs: 5, nextCursor: 'c"2',
      results: [{ platform: 'x' as const, id: '1', url: 'https://x.com/a/status/1', author: { name: 'A', handle: 'a', url: 'https://x.com/a' }, text: '<script>alert(1)</script>', publishedAt: null, stats: { likes: 2, replies: null, reposts: null, views: null }, media: [] }] };
    const html = String(<SocialSearchPage platform="x" q="cats" result={result} />);
    expect(html.includes('<script>alert')).toBe(false);
    expect(html.includes('/convert?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1')).toBe(true);
    expect(html.includes('name="cursor"')).toBe(true);
    expect(html.includes('method="post"')).toBe(true);
  });
});
