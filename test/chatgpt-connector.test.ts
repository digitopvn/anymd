/**
 * The ChatGPT connector path end to end through the real Worker entry and OAuth provider: dynamic
 * client registration with ChatGPT's redirect URI, consent, PKCE token exchange with the RFC 8707
 * resource, RFC 9207 `iss` on success and denial, and MCP calls with the issued token. Conversion
 * itself is stubbed so the read-only workflow runs without network access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/convert/service', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/convert/service')>();
  return {
    ...real,
    runConversion: vi.fn(async (_env: unknown, _ctx: unknown, req: { url: string; save?: boolean }) => ({
      result: { source: req.url, title: 'Example Domain', domain: 'example.com', sourceKind: 'web', wordCount: 3, content: 'This domain is for use in examples.' },
      markdown: '# Example Domain\n\nThis domain is for use in examples.',
      documentId: null,
      notSavedReason: req.save === false ? 'not_requested' : null,
      credits: 1,
      cached: false,
      traceId: 'trace-should-not-leak',
      durationMs: 42,
      readingOptions: {},
    })),
  };
});

import worker from '../src/worker';
import { normalizeTargetUrl } from '../src/convert';
import { SESSION_COOKIE } from '../src/auth/identity';
import { createTestEnv, seedSession, seedUser, type TestEnv } from './helpers/sqlite-env';

const ORIGIN = 'https://anymd.test';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

/** OAUTH_KV with the `list` the provider needs, honouring prefixes. */
function oauthKv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string, t?: string | { type?: string }) => {
      const v = m.get(k);
      if (v === undefined) return null;
      return (typeof t === 'string' ? t : t?.type) === 'json' ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async (o: { prefix?: string } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(o.prefix ?? '')).map((name) => ({ name })), list_complete: true }),
  };
}

let t: TestEnv;
let cookie: string;

beforeEach(async () => {
  t = createTestEnv({ OAUTH_KV: oauthKv() as never, OAUTH_PROVIDER: undefined as never });
  const user = await seedUser(t, 'user');
  cookie = `${SESSION_COOKIE}=${(await seedSession(t, user)).token}`;
});
afterEach(() => t.close());

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }), t.env, ctx);

async function pkce() {
  const verifier = 'v'.repeat(20) + crypto.randomUUID().replace(/-/g, '');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

async function register(): Promise<string> {
  const res = await call('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Runs authorize → consent and returns the redirect back to ChatGPT. */
async function consent(clientId: string, challenge: string, decision: 'allow' | 'deny'): Promise<URL> {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CHATGPT_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', resource: `${ORIGIN}/mcp` });
  const page = await call(`/oauth/authorize?${q}`, { headers: { cookie } });
  const html = await page.text();
  expect(page.status, html.slice(0, 300)).toBe(200);
  const handle = /name="state" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  const consentCookies = page.headers.getSetCookie().map((c) => c.split(';')[0]);
  const res = await call('/oauth/authorize', {
    method: 'POST',
    headers: { cookie: [cookie, ...consentCookies].join('; '), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: handle!.replace(/&amp;/g, '&'), decision }),
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

async function mcp(token: string, method: string, params?: Record<string, unknown>) {
  const res = await call('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as { result: any } };
}

describe('ChatGPT connector OAuth', () => {
  it('advertises discovery ChatGPT requires: PKCE S256, DCR, iss parameter, resource metadata', async () => {
    const as = (await (await call('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(ORIGIN);
    expect((as.code_challenge_methods_supported as string[]).includes('S256')).toBe(true);
    expect(as.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    const pr = (await (await call('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(pr.resource).toBe(`${ORIGIN}/mcp`);
    expect(pr.authorization_servers).toEqual([as.issuer]);
    expect(pr.scopes_supported).toEqual(['convert', 'library:read', 'library:write']);
  });

  it('challenges an unauthenticated MCP call with the resource metadata URL', async () => {
    const res = await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')?.includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`)).toBe(true);
  });

  it('connects with DCR + PKCE and runs the read-only workflow with the least-privilege baseline', async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const back = await consent(clientId, challenge, 'allow');
    expect(`${back.origin}${back.pathname}`).toBe(CHATGPT_REDIRECT);
    expect(back.searchParams.get('state')).toBe('st-123');
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
    const code = back.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenRes = await call('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, redirect_uri: CHATGPT_REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
    });
    const token = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokenRes.status, JSON.stringify(token)).toBe(200);
    expect(token.scope.split(' ').sort()).toEqual(['convert', 'library:read', 'library:write']);

    const list = await mcp(token.access_token, 'tools/list');
    expect(list.status).toBe(200);
    const names: string[] = list.body.result.tools.map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(['read_url', 'search_library', 'get_document', 'list_documents']));
    // No admin or account-management plane on a default connection.
    expect(names.some((n) => n.startsWith('admin_') || n === 'create_api_key' || n === 'list_users')).toBe(false);

    const read = await mcp(token.access_token, 'tools/call', { name: 'read_url', arguments: { url: 'https://example.com/', save: false } });
    expect(read.body.result.isError).toBeFalsy();
    expect(read.body.result.content[0].text.startsWith('# Example Domain')).toBe(true);
    expect(read.body.result.structuredContent.saved).toBe(false);
    // Response minimization: no internal trace ids or timings in tool results.
    expect(read.body.result.structuredContent.trace_id).toBeUndefined();
    expect(read.body.result.structuredContent.duration_ms).toBeUndefined();
    expect(JSON.stringify(read.body.result).includes('trace-should-not-leak')).toBe(false);

    const search = await mcp(token.access_token, 'tools/call', { name: 'search_library', arguments: { query: 'nothing saved yet', mode: 'fulltext' } });
    expect(search.body.result.isError).toBeFalsy();
  });

  it('returns iss with the access_denied redirect when the user declines', async () => {
    const clientId = await register();
    const back = await consent(clientId, (await pkce()).challenge, 'deny');
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
    expect(back.searchParams.get('state')).toBe('st-123');
  });

  it('rejects a token request for a different resource', async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const code = (await consent(clientId, challenge, 'allow')).searchParams.get('code')!;
    const res = await call('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CHATGPT_REDIRECT, client_id: clientId, code_verifier: verifier, resource: 'https://evil.example/mcp' }),
    });
    expect(res.status).toBe(400);
  });

  it('stops working once the user disconnects the app (revoked token)', async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const code = (await consent(clientId, challenge, 'allow')).searchParams.get('code')!;
    const token = (await (
      await call('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CHATGPT_REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
      })
    ).json()) as { access_token: string };
    const revoke = await call('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token.access_token, client_id: clientId }),
    });
    expect(revoke.status).toBe(200);
    const after = await mcp(token.access_token, 'tools/list');
    expect(after.status).toBe(401);
  });
});

describe('ChatGPT review negative cases', () => {
  it('refuses the cloud metadata address before any fetch', () => {
    let code: string | undefined;
    try {
      normalizeTargetUrl('http://169.254.169.254/latest/meta-data/');
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('blocked_host');
  });

  it('offers no bulk deletion: deleting needs one named document and is marked destructive', async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const code = (await consent(clientId, challenge, 'allow')).searchParams.get('code')!;
    const token = (await (
      await call('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CHATGPT_REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
      })
    ).json()) as { access_token: string };
    const tools: { name: string; inputSchema: { required?: string[] }; annotations?: { destructiveHint?: boolean } }[] = (await mcp(token.access_token, 'tools/list')).body.result.tools;
    const deleting = tools.filter((x) => x.annotations?.destructiveHint);
    expect(deleting.map((x) => x.name)).toEqual(['delete_document']);
    expect(deleting[0].inputSchema.required).toEqual(['id']);
  });
});

describe('OpenAI domain verification', () => {
  it('serves the configured token as plain text, nothing else', async () => {
    t.env.OPENAI_APPS_CHALLENGE = ' tok_abc123 \n';
    const res = await call('/.well-known/openai-apps-challenge');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('tok_abc123');
  });

  it('is a 404 when no token is configured', async () => {
    const res = await call('/.well-known/openai-apps-challenge');
    expect(res.status).toBe(404);
  });
});
