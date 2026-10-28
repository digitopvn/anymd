/**
 * End-to-end OAuth for MCP clients (ChatGPT, Claude) through the real Worker entry: discovery,
 * registration (DCR and metadata-URL clients), consent, PKCE, the token endpoint, and MCP calls with
 * the resulting tokens. Covers reconnect, refresh, expiry, revocation, audience, scope step-up,
 * read-only and destructive tools, cross-tenant access, suspended and deleted accounts, and that
 * auth failures are logged without secrets and rate limited.
 *
 * String checks use `includes` rather than `toContain`: the Worker's DOM polyfill defines a global
 * `Node` object, which vitest's `toContain` probes with `instanceof`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { SESSION_COOKIE, type UserRow } from '../src/auth/identity';
import { saveDocument } from '../src/library/store';
import type { ConvertResult } from '../src/convert/types';
import { counter, createTestEnv, seedSession, seedUser, type TestEnv } from './helpers/sqlite-env';

const ORIGIN = 'https://anymd.test';
const RESOURCE = `${ORIGIN}/mcp`;
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

let t: TestEnv;

beforeEach(() => {
  t = createTestEnv({ RL_ANON: counter(), RL_AUTH: counter() });
  // The provider installs its own helpers; the service-test stub must not shadow them.
  delete (t.env as Partial<TestEnv['env']>).OAUTH_PROVIDER;
  // Metadata-URL clients (CIMD) need this compatibility flag, which wrangler.jsonc sets.
  (globalThis as { Cloudflare?: unknown }).Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as { Cloudflare?: unknown }).Cloudflare;
  t.close();
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), t.env, ctx);
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function register(redirect = CHATGPT_REDIRECT, name = 'ChatGPT'): Promise<string> {
  const res = await call('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Cookies from Set-Cookie headers, as a Cookie request header value. */
function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

interface Login {
  user: UserRow;
  cookie: string;
}

async function login(role: 'user' | 'owner' = 'user'): Promise<Login> {
  const user = await seedUser(t, role);
  const { token } = await seedSession(t, user);
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

interface AuthorizeOptions {
  clientId: string;
  scope?: string;
  redirect?: string;
  method?: string;
  resource?: string;
  /** Extra consent form fields, as the user's choices on the consent screen. */
  form?: Record<string, string>;
}

function authorizeQuery(o: AuthorizeOptions, challenge: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: o.clientId, redirect_uri: o.redirect ?? CHATGPT_REDIRECT, code_challenge: challenge, code_challenge_method: o.method ?? 'S256', state: 'st-123' });
  if (o.scope !== undefined) q.set('scope', o.scope);
  q.set('resource', o.resource ?? RESOURCE);
  return q.toString();
}

/** Consent screen → allow → code → token, as a browser plus a public client would do it. */
async function connect(who: Login, o: AuthorizeOptions) {
  const { verifier, challenge } = await pkce();
  const page = await call(`/oauth/authorize?${authorizeQuery(o, challenge)}`, { headers: { cookie: who.cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  const handle = /name="state" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  const decided = await call('/oauth/authorize', {
    method: 'POST',
    headers: { cookie: `${who.cookie}; ${cookiesOf(page)}`, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams({ ...o.form, state: handle!, decision: 'allow' }).toString(),
  });
  expect(decided.status).toBe(302);
  const back = new URL(decided.headers.get('location')!);
  expect(`${back.origin}${back.pathname}`).toBe(o.redirect ?? CHATGPT_REDIRECT);
  expect(back.searchParams.get('state')).toBe('st-123');
  const code = back.searchParams.get('code')!;
  const tokenRes = await token({ grant_type: 'authorization_code', code, redirect_uri: o.redirect ?? CHATGPT_REDIRECT, client_id: o.clientId, code_verifier: verifier, resource: RESOURCE });
  expect(tokenRes.status).toBe(200);
  return { html, ...((await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string; expires_in: number }) };
}

function token(params: Record<string, string>) {
  return call('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
}

let rpcId = 0;
function mcp(accessToken: string, method: string, params?: Record<string, unknown>) {
  return call('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-connecting-ip': '203.0.113.7' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
}

async function toolNames(accessToken: string): Promise<string[]> {
  const res = await mcp(accessToken, 'tools/list');
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name);
}

function conversion(source: string): ConvertResult {
  return { title: 'A post', author: '', published: '', description: '', domain: 'example.com', site: 'Example', image: '', language: 'en', content: 'Body', baseContent: 'Body', wordCount: 1, source, sourceKind: 'web' };
}

const WRITE_TOOLS = ['tag_document', 'delete_document'];

describe('discovery', () => {
  it('publishes protected-resource and authorization-server metadata a ChatGPT connector can follow', async () => {
    const challenge = await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(challenge.status).toBe(401);
    expect((challenge.headers.get('www-authenticate') ?? '').includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`)).toBe(true);

    const prm = (await (await call('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual([ORIGIN]);
    // Advertised baseline: no deletion, nothing elevated.
    expect(prm.scopes_supported).toEqual(['convert', 'library:read', 'library:write']);

    const as = (await (await call('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(ORIGIN);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
    expect(as.scopes_supported).toEqual(expect.arrayContaining(['library:delete']));
  });
});

describe('connect and reconnect', () => {
  it('connects a new user with the least-privilege baseline and shows where the browser returns', async () => {
    const who = await login();
    const clientId = await register();
    const conn = await connect(who, { clientId });
    expect(conn.html.includes('chatgpt.com')).toBe(true);
    expect(conn.scope.split(' ').sort()).toEqual(['convert', 'library:read', 'library:write']);
    const tools = await toolNames(conn.access_token);
    expect(tools).toEqual(expect.arrayContaining(['read_url', 'search_library', 'get_document', 'list_documents', 'tag_document']));
    expect(tools.includes('delete_document')).toBe(false);
    expect(tools.includes('usage_summary')).toBe(false);
  });

  it('lets a returning user reconnect, and keeps working across a token refresh', async () => {
    const who = await login();
    const clientId = await register();
    const first = await connect(who, { clientId });
    const second = await connect(who, { clientId });
    expect(second.access_token).not.toBe(first.access_token);
    expect((await mcp(second.access_token, 'tools/list')).status).toBe(200);

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(200);
    const { access_token } = (await refreshed.json()) as { access_token: string };
    expect((await mcp(access_token, 'tools/list')).status).toBe(200);
  });

  it('rejects plain PKCE, an unregistered return URL and a foreign resource', async () => {
    const who = await login();
    const clientId = await register();
    const { challenge } = await pkce();
    const plain = await call(`/oauth/authorize?${authorizeQuery({ clientId, method: 'plain' }, challenge)}`, { headers: { cookie: who.cookie } });
    expect(plain.status).toBe(400);
    const elsewhere = await call(`/oauth/authorize?${authorizeQuery({ clientId, redirect: 'https://evil.example/cb' }, challenge)}`, { headers: { cookie: who.cookie } });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.get('location')).toBeNull();
    const foreign = await call(`/oauth/authorize?${authorizeQuery({ clientId, resource: 'https://other.example/mcp' }, challenge)}`, { headers: { cookie: who.cookie } });
    expect(foreign.status).not.toBe(200);
    expect((foreign.headers.get('location') ?? '').includes('code=')).toBe(false);
  });

  it('rejects a code redeemed with the wrong PKCE verifier', async () => {
    const who = await login();
    const clientId = await register();
    const { challenge } = await pkce();
    const page = await call(`/oauth/authorize?${authorizeQuery({ clientId }, challenge)}`, { headers: { cookie: who.cookie } });
    const handle = /name="state" value="([^"]+)"/.exec(await page.text())![1];
    const decided = await call('/oauth/authorize', {
      method: 'POST',
      headers: { cookie: `${who.cookie}; ${cookiesOf(page)}`, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: new URLSearchParams({ state: handle, decision: 'allow' }).toString(),
    });
    const code = new URL(decided.headers.get('location')!).searchParams.get('code')!;
    const res = await token({ grant_type: 'authorization_code', code, redirect_uri: CHATGPT_REDIRECT, client_id: clientId, code_verifier: (await pkce()).verifier });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('accepts a client identified by its metadata URL (CIMD) and names it on the consent screen', async () => {
    const clientId = 'https://client.example/oauth/client.json';
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== clientId) return realFetch(input, init);
      return Response.json({ client_id: clientId, client_name: 'Example Agent', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    });
    const who = await login();
    const conn = await connect(who, { clientId, redirect: 'https://client.example/callback' });
    expect(conn.html.includes('Example Agent')).toBe(true);
    expect(conn.html.includes(`Client ID: ${clientId}`)).toBe(true);
    expect(conn.html.includes('client.example')).toBe(true);
    expect(/data-client-host[^>]*>\s*App identity: <strong[^>]*>client\.example<\/strong>/.test(conn.html)).toBe(true);
    expect((await mcp(conn.access_token, 'tools/list')).status).toBe(200);
  });

  it('shows a plain error, without the fetch failure, when a metadata-URL client cannot be loaded', async () => {
    const clientId = 'https://broken.example/oauth/client.json';
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== clientId) return realFetch(input, init);
      return new Response('upstream secret detail', { status: 500 });
    });
    const who = await login();
    const { challenge } = await pkce();
    const page = await call(`/oauth/authorize?${authorizeQuery({ clientId, redirect: 'https://broken.example/cb' }, challenge)}`, { headers: { cookie: who.cookie } });
    expect(page.status).toBe(400);
    const html = await page.text();
    expect(html.includes('Could not load this app')).toBe(true);
    expect(html.includes('upstream secret detail')).toBe(false);
  });
});

describe('scopes, read-only and destructive tools', () => {
  it('keeps a read-only connection away from every write tool, with a 403 step-up challenge', async () => {
    const who = await login();
    const clientId = await register();
    const conn = await connect(who, { clientId, scope: 'library:read' });
    const tools = await toolNames(conn.access_token);
    expect(tools).toEqual(expect.arrayContaining(['search_library', 'get_document', 'list_documents']));
    for (const name of [...WRITE_TOOLS, 'read_url']) expect(tools.includes(name)).toBe(false);

    const doc = await saveDocument(t.env, who.user.id, conversion('https://example.com/keep'), 'Body');
    for (const name of WRITE_TOOLS) {
      const res = await mcp(conn.access_token, 'tools/call', { name, arguments: { id: doc!.id, add: ['x'] } });
      expect(res.status, name).toBe(403);
      expect((res.headers.get('www-authenticate') ?? '').includes('error="insufficient_scope"')).toBe(true);
    }
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(doc!.id)).toEqual({ n: 1 });
  });

  it('requires library:delete, approved on the consent screen, to delete; a model-supplied argument cannot stand in for it', async () => {
    const who = await login();
    const clientId = await register();
    const base = await connect(who, { clientId });
    const doc = await saveDocument(t.env, who.user.id, conversion('https://example.com/a'), 'Body');

    const denied = await mcp(base.access_token, 'tools/call', { name: 'delete_document', arguments: { id: doc!.id, confirm: true } });
    expect(denied.status).toBe(403);
    const challenge = denied.headers.get('www-authenticate')!;
    const stepUp = /scope="([^"]+)"/.exec(challenge)![1];
    expect(stepUp.split(' ')).toEqual(expect.arrayContaining(['convert', 'library:read', 'library:write', 'library:delete']));
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(doc!.id)).toEqual({ n: 1 });

    // Step-up: the client re-authorizes with the challenge's scopes, and the user sees deletion flagged as sensitive.
    const elevated = await connect(who, { clientId, scope: stepUp });
    expect(elevated.html.includes('Permanently delete library documents')).toBe(true);
    expect(elevated.html.includes('data-elevated-scopes')).toBe(true);
    expect((await toolNames(elevated.access_token)).includes('delete_document')).toBe(true);
    const ok = await mcp(elevated.access_token, 'tools/call', { name: 'delete_document', arguments: { id: doc!.id } });
    expect(((await ok.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(doc!.id)).toEqual({ n: 0 });
  });

  it('offers deletion as an unchecked consent option, so a client that never asks for scopes can still be allowed to delete', async () => {
    const who = await login();
    const clientId = await register();
    const base = await connect(who, { clientId });
    expect(base.html.includes('name="allow_delete"')).toBe(true);
    expect(base.html.includes('name="allow_delete" value="1" checked')).toBe(false);
    expect((await toolNames(base.access_token)).includes('delete_document')).toBe(false);

    const allowed = await connect(who, { clientId, form: { allow_delete: '1' } });
    expect(allowed.scope.split(' ')).toEqual(expect.arrayContaining(['convert', 'library:read', 'library:write', 'library:delete']));
    expect((await toolNames(allowed.access_token)).includes('delete_document')).toBe(true);
    // Any other value of the field adds nothing.
    const forged = await connect(who, { clientId, form: { allow_delete: 'true' } });
    expect(forged.scope.split(' ').includes('library:delete')).toBe(false);
  });

  it('never reaches another account\'s documents', async () => {
    const alice = await login();
    const bob = await login();
    const bobsDoc = await saveDocument(t.env, bob.user.id, conversion('https://example.com/bob'), 'Secret body');
    const clientId = await register();
    const { access_token } = await connect(alice, { clientId, scope: 'convert library:read library:write library:delete' });

    for (const [name, args] of [
      ['get_document', { id: bobsDoc!.id }],
      ['delete_document', { id: bobsDoc!.id }],
      ['tag_document', { id: bobsDoc!.id, add: ['mine'] }],
    ] as const) {
      const res = await mcp(access_token, 'tools/call', { name, arguments: args });
      const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
      expect(body.result.isError, name).toBe(true);
      expect(body.result.content[0].text.includes('not found'), name).toBe(true);
    }
    const listed = await mcp(access_token, 'tools/call', { name: 'list_documents', arguments: {} });
    expect(JSON.stringify(await listed.json()).includes(bobsDoc!.id)).toBe(false);
    // Bob's document is untouched: still there, still untagged.
    expect(t.db.prepare('SELECT tags FROM documents WHERE id = ?').get(bobsDoc!.id)).toEqual({ tags: '' });
  });
});

describe('expired, revoked and dead credentials', () => {
  it('rejects an expired access token with 401 invalid_token, and the refresh token still renews it', async () => {
    const who = await login();
    const clientId = await register();
    const conn = await connect(who, { clientId });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    const res = await mcp(conn.access_token, 'tools/list');
    expect(res.status).toBe(401);
    expect((res.headers.get('www-authenticate') ?? '').includes('error="invalid_token"')).toBe(true);
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: conn.refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(200);
  });

  it('stops access and refresh tokens once the grant is revoked', async () => {
    const who = await login();
    const clientId = await register();
    const conn = await connect(who, { clientId });
    const revoke = await call('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: conn.refresh_token, client_id: clientId }).toString() });
    expect(revoke.status).toBe(200);
    expect((await mcp(conn.access_token, 'tools/list')).status).toBe(401);
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: conn.refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(400);
    expect(((await refreshed.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects a token presented to another resource (wrong audience) and a forged token', async () => {
    const who = await login();
    const clientId = await register();
    const conn = await connect(who, { clientId });
    const exchange = await token({ grant_type: 'refresh_token', refresh_token: conn.refresh_token, client_id: clientId, resource: 'https://other.example/mcp' });
    expect(exchange.status).toBe(400);
    expect(((await exchange.json()) as { error: string }).error).toBe('invalid_target');
    const [userId, grantId] = conn.access_token.split(':');
    expect((await mcp(`${userId}:${grantId}:forged`, 'tools/list')).status).toBe(401);
  });

  it('answers 401 for suspended and deleted accounts even with a live token', async () => {
    const who = await login();
    const clientId = await register();
    const conn = await connect(who, { clientId });
    t.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(who.user.id);
    expect((await mcp(conn.access_token, 'tools/list')).status).toBe(401);
    t.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(who.user.id);
    expect((await mcp(conn.access_token, 'tools/list')).status).toBe(200);
    t.db.prepare('DELETE FROM users WHERE id = ?').run(who.user.id);
    const res = await mcp(conn.access_token, 'tools/list');
    expect(res.status).toBe(401);
    expect((res.headers.get('www-authenticate') ?? '').includes('resource_metadata=')).toBe(true);
  });

  it('logs auth failures without the token and rate limits a credential replayed from one IP', async () => {
    t.env.RL_ANON = counter(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = 'user-x:grant-y:not-a-real-secret-value';
    expect((await mcp(bad, 'tools/list')).status).toBe(401);
    expect((await mcp(bad, 'tools/list')).status).toBe(401);
    const limited = await mcp(bad, 'tools/list');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    // The challenge survives, so a client that refreshes on invalid_token still knows to.
    expect((limited.headers.get('www-authenticate') ?? '').includes('invalid_token')).toBe(true);
    // Another user's token from the same shared egress IP still gets its own 401.
    expect((await mcp('user-z:grant-w:another-unknown-value', 'tools/list')).status).toBe(401);
    const lines = warn.mock.calls.map((c) => c.map(String).join(' '));
    expect(lines.some((l) => l.includes('"event":"oauth.auth_failed"') && l.includes('"reason":"token_not_found"'))).toBe(true);
    expect(lines.some((l) => l.includes('auth_failure_rate_limited'))).toBe(true);
    for (const l of lines) expect(l.includes('not-a-real-secret-value')).toBe(false);
    // A missing header is ordinary discovery, never rate limited.
    expect((await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });

  it('rate limits a rejected API key replayed from one IP', async () => {
    t.env.RL_ANON = counter(1);
    const send = () => call('/mcp', { method: 'POST', headers: { authorization: 'Bearer amd_definitely_not_a_key', 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.8' }, body: '{}' });
    expect((await send()).status).toBe(401);
    expect((await send()).status).toBe(429);
  });
});
