/**
 * End-to-end OAuth for the MCP endpoint: every request enters through the Worker's default export, so
 * the real @cloudflare/workers-oauth-provider answers discovery, registration, consent, tokens,
 * revocation and the bearer checks on /mcp. Helpers live in test/helpers/oauth-flow.ts.
 *
 * Substring checks use `.includes()`: once the Worker is imported, vitest's toContain and toMatch
 * fail with "Right-hand side of 'instanceof' is not callable" (the same workaround appears in
 * oauth-admin-consent.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_DEFAULT_SCOPES } from '../src/auth/roles';
import { deleteAccount } from '../src/lib/account';
import { getUser, type UserRow } from '../src/auth/identity';
import {
  approveAuthorization,
  beginAuthorization,
  CHATGPT_REDIRECT,
  callTool,
  connectOAuthClient,
  DEFAULT_SCOPE,
  editTokenRecord,
  exchangeCode,
  mcp,
  oauthTestEnv,
  pkce,
  PUBLIC_URL,
  refreshTokens,
  registerClient,
  RESOURCE,
  revokeToken,
  rpc,
  toolNames,
  workerFetch,
} from './helpers/oauth-flow';
import { seedSession, seedUser, type TestEnv } from './helpers/sqlite-env';

const METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;
const ACCESS_TOKEN_TTL_SECONDS = 3600;

let t: TestEnv;

beforeEach(() => {
  t = oauthTestEnv();
});

afterEach(() => {
  vi.useRealTimers();
  t.close();
});

/** Substring assertion that prints the text on failure. */
function expectIncludes(text: string, part: string) {
  expect(text.includes(part), `expected ${JSON.stringify(text.slice(0, 500))} to include ${JSON.stringify(part)}`).toBe(true);
}

/** The Bearer challenge a protected-resource 401 carries: resource_metadata always, error when given. */
function expectBearerChallenge(headers: Headers, error?: string) {
  const challenge = headers.get('www-authenticate') ?? '';
  expect(challenge.startsWith('Bearer '), `challenge: ${challenge}`).toBe(true);
  expectIncludes(challenge, `resource_metadata="${METADATA_URL}"`);
  if (error) expectIncludes(challenge, `error="${error}"`);
}

/** Inserts a library document owned by `user` and returns its id. */
function insertDocument(user: UserRow, title: string): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  t.db
    .prepare('INSERT INTO documents (id, user_id, url, url_hash, title, markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, `https://example.com/${id}`, `hash-${id}`, title, `# ${title}\n\nBody of ${title}.`, now, now);
  return id;
}

function documentRowCount(id: string): number {
  return (t.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(id) as { n: number }).n;
}

/** The client return link on the authorize error page; the page never redirects on its own. */
function errorReturnLink(status: number, location: string | null, html: string): URL {
  expect(status).toBe(400);
  expect(location).toBeNull();
  const href = /<a [^>]*href="([^"]+)"[^>]*data-oauth-error-return/.exec(html)?.[1];
  if (!href) throw new Error(`no return link: ${html.slice(0, 300)}`);
  return new URL(href.replaceAll('&amp;', '&'));
}

/** The authorization code from a successful consent reply. */
function codeFrom(location: string | null): string {
  const code = new URL(location ?? 'https://invalid.example/').searchParams.get('code');
  if (!code) throw new Error(`no code in redirect: ${location}`);
  return code;
}

describe('OAuth discovery', () => {
  it('publishes the MCP endpoint as the protected resource, with the baseline scopes', async () => {
    const res = await workerFetch(t, '/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { resource: string; scopes_supported: string[]; authorization_servers?: string[] };
    expect(meta.resource).toBe(RESOURCE);
    expect(meta.scopes_supported).toEqual(OAUTH_DEFAULT_SCOPES);
  });

  it('publishes authorization server metadata: S256 only, iss supported, registration and revocation endpoints', async () => {
    const res = await workerFetch(t, '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect(meta.authorization_endpoint).toBe(`${PUBLIC_URL}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
    expect(meta.revocation_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
    expect(meta.response_types_supported).toEqual(['code']);
  });
});

describe('connecting a client', () => {
  it('connects a new user: consent yields a code, the code yields tokens, and the token works on /mcp', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);

    expect(conn.tokens.token_type.toLowerCase()).toBe('bearer');
    expect(conn.tokens.access_token.split(':')).toHaveLength(3);
    expect(conn.tokens.refresh_token).toBeTruthy();
    expect(conn.tokens.scope).toBe(DEFAULT_SCOPE);
    expect(conn.iss).toBe(PUBLIC_URL);
    expect(conn.state).toBe('xyz');

    const names = await toolNames(t, conn.tokens.access_token);
    expect(names).toEqual(expect.arrayContaining(['get_document', 'tag_document', 'read_url']));
    // Deleting is never in the default grant: it needs library:delete, approved by name.
    expect(names.includes('delete_document')).toBe(false);

    const listed = await callTool(t, conn.tokens.access_token, 'list_documents', {});
    expect(listed.status).toBe(200);
    expect(listed.json.result.isError).not.toBe(true);
  });

  it('lets a returning user reconnect the same client, and the new token works', async () => {
    const user = await seedUser(t, 'user');
    const first = await connectOAuthClient(t, user);
    const second = await connectOAuthClient(t, user, { clientId: first.clientId });

    expect(second.clientId).toBe(first.clientId);
    expect(second.tokens.access_token).not.toBe(first.tokens.access_token);
    expect(second.tokens.refresh_token).not.toBe(first.tokens.refresh_token);
    expect((await toolNames(t, second.tokens.access_token)).includes('get_document')).toBe(true);

    // Completing a new authorization for the same client replaces the earlier grant
    // (completeAuthorization revokes it), so a stale token cannot outlive a re-consent.
    const old = await rpc(t, first.tokens.access_token, 'tools/list');
    expect(old.status).toBe(401);
    expectBearerChallenge(old.headers, 'invalid_token');
  });

  it('keeps one grant per client after a reconnect', async () => {
    const user = await seedUser(t, 'user');
    const first = await connectOAuthClient(t, user);
    await connectOAuthClient(t, user, { clientId: first.clientId });
    const grants = await t.env.OAUTH_PROVIDER.listUserGrants(user.id);
    expect(grants.items.filter((g) => g.clientId === first.clientId)).toHaveLength(1);
  });

  it('exchanges a refresh token for a working access token and a rotated refresh token', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    const refreshed = await refreshTokens(t, { clientId: conn.clientId, refreshToken: conn.tokens.refresh_token! });

    expect(refreshed.status).toBe(200);
    expect(refreshed.json.access_token).toBeTruthy();
    expect(refreshed.json.refresh_token).toBeTruthy();
    expect((await toolNames(t, refreshed.json.access_token)).includes('get_document')).toBe(true);
  });
});

describe('access token expiry', () => {
  it('rejects a token whose stored expiry has passed, with a resource_metadata challenge', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    editTokenRecord(t, conn.tokens.access_token, { expiresAt: Math.floor(Date.now() / 1000) - 1 });

    const r = await rpc(t, conn.tokens.access_token, 'tools/list');
    expect(r.status).toBe(401);
    expectBearerChallenge(r.headers, 'invalid_token');
    expect(r.text.includes(conn.tokens.access_token)).toBe(false);
  });

  it('expires the token after accessTokenTTL, and a refresh token still mints a working access token', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + (ACCESS_TOKEN_TTL_SECONDS + 1) * 1000);

    const expired = await rpc(t, conn.tokens.access_token, 'tools/list');
    expect(expired.status).toBe(401);
    expectBearerChallenge(expired.headers, 'invalid_token');

    const refreshed = await refreshTokens(t, { clientId: conn.clientId, refreshToken: conn.tokens.refresh_token! });
    expect(refreshed.status).toBe(200);
    expect((await toolNames(t, refreshed.json.access_token)).includes('get_document')).toBe(true);
  });
});

describe('revocation', () => {
  it('a grant revoked from the dashboard path fails for its access token and its refresh token', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    const { items } = await t.env.OAUTH_PROVIDER.listUserGrants(user.id);
    expect(items).toHaveLength(1);
    await t.env.OAUTH_PROVIDER.revokeGrant(items[0].id, user.id);

    const r = await rpc(t, conn.tokens.access_token, 'tools/list');
    expect(r.status).toBe(401);
    expectBearerChallenge(r.headers, 'invalid_token');

    const refreshed = await refreshTokens(t, { clientId: conn.clientId, refreshToken: conn.tokens.refresh_token! });
    expect(refreshed.status).toBe(400);
    expect(refreshed.json.error).toBe('invalid_grant');
  });

  it('RFC 7009 revocation of the access token makes the next /mcp call a 401', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    expect((await toolNames(t, conn.tokens.access_token)).includes('get_document')).toBe(true);

    const revoked = await revokeToken(t, { clientId: conn.clientId, token: conn.tokens.access_token, hint: 'access_token' });
    expect(revoked.status).toBe(200);

    const r = await rpc(t, conn.tokens.access_token, 'tools/list');
    expect(r.status).toBe(401);
    expectBearerChallenge(r.headers, 'invalid_token');
  });

  it('revoking the refresh token revokes the whole grant, so the access token stops working too', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    const revoked = await revokeToken(t, { clientId: conn.clientId, token: conn.tokens.refresh_token!, hint: 'refresh_token' });
    expect(revoked.status).toBe(200);

    expect((await rpc(t, conn.tokens.access_token, 'tools/list')).status).toBe(401);
    expect((await refreshTokens(t, { clientId: conn.clientId, refreshToken: conn.tokens.refresh_token! })).status).toBe(400);
  });

  it('revocation by another client is a no-op that leaves the token working', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    const other = await registerClient(t);
    const reply = await revokeToken(t, { clientId: other, token: conn.tokens.access_token, hint: 'access_token' });
    expect(reply.status).toBe(200);
    expect((await toolNames(t, conn.tokens.access_token)).includes('get_document')).toBe(true);
  });
});

describe('audience (RFC 8707 resource)', () => {
  it('refuses an authorization request for a foreign resource and offers the client an invalid_target return link', async () => {
    const user = await seedUser(t, 'user');
    const clientId = await registerClient(t);
    const { token: session } = await seedSession(t, user);
    const { challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CHATGPT_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: DEFAULT_SCOPE,
      resource: 'https://evil.example/mcp',
    });
    const res = await workerFetch(t, `/oauth/authorize?${query}`, { headers: { cookie: `amd_session=${session}` } });
    const to = errorReturnLink(res.status, res.headers.get('location'), await res.text());
    expect(`${to.origin}${to.pathname}`).toBe(CHATGPT_REDIRECT);
    expect(to.searchParams.get('error')).toBe('invalid_target');
    expect(to.searchParams.get('state')).toBe('xyz');
    expect(to.searchParams.get('iss')).toBeTruthy();
    expect(to.searchParams.get('code')).toBeNull();
  });

  it('refuses a token request that names a foreign resource with invalid_target', async () => {
    const user = await seedUser(t, 'user');
    const clientId = await registerClient(t);
    const { token: session } = await seedSession(t, user);
    const { verifier, challenge } = await pkce();
    const pending = await beginAuthorization(t, session, { clientId, codeChallenge: challenge });
    const code = codeFrom((await approveAuthorization(t, session, pending)).headers.get('location'));

    const r = await exchangeCode(t, { clientId, code, verifier, resource: 'https://evil.example/mcp' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_target');
  });

  it('rejects, at /mcp, an access token whose stored audience is another resource', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    editTokenRecord(t, conn.tokens.access_token, { audience: 'https://evil.example/mcp' });

    const r = await rpc(t, conn.tokens.access_token, 'tools/list');
    expect(r.status).toBe(401);
    expectBearerChallenge(r.headers, 'invalid_token');
  });
});

describe('PKCE', () => {
  it('a wrong code_verifier fails with invalid_grant and issues no tokens', async () => {
    const user = await seedUser(t, 'user');
    const clientId = await registerClient(t);
    const { token: session } = await seedSession(t, user);
    const { challenge } = await pkce();
    const pending = await beginAuthorization(t, session, { clientId, codeChallenge: challenge });
    const code = codeFrom((await approveAuthorization(t, session, pending)).headers.get('location'));

    const wrong = await pkce();
    const r = await exchangeCode(t, { clientId, code, verifier: wrong.verifier });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_grant');
    expect(r.json.access_token).toBeUndefined();
    expect(r.text.includes(code)).toBe(false);
  });

  it('refuses code_challenge_method=plain at the authorize endpoint with an invalid_request return link', async () => {
    const user = await seedUser(t, 'user');
    const clientId = await registerClient(t);
    const { token: session } = await seedSession(t, user);
    const { challenge } = await pkce();
    const pending = await beginAuthorization(t, session, { clientId, codeChallenge: challenge, codeChallengeMethod: 'plain' });

    expect(pending.handle).toBeNull();
    expect(pending.bindings).toEqual([]);
    const to = errorReturnLink(pending.status, pending.location, pending.text);
    expect(`${to.origin}${to.pathname}`).toBe(CHATGPT_REDIRECT);
    expect(to.searchParams.get('error')).toBe('invalid_request');
    expect(to.searchParams.get('code')).toBeNull();
  });
});

describe('redirect URI', () => {
  it.each([
    ['another path on the registered host', 'https://chatgpt.com/other'],
    ['an unrelated host', 'https://evil.example/connector_platform_oauth_redirect'],
  ])('refuses an unregistered redirect_uri (%s) without redirecting to it', async (_label, redirectUri) => {
    const user = await seedUser(t, 'user');
    const clientId = await registerClient(t);
    const { token: session } = await seedSession(t, user);
    const { challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: DEFAULT_SCOPE,
      resource: RESOURCE,
    });
    const res = await workerFetch(t, `/oauth/authorize?${query}`, { headers: { cookie: `amd_session=${session}` } });
    const body = await res.text();

    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(body.includes(redirectUri)).toBe(false);
  });
});

describe('scopes', () => {
  it('a grant without library:write hides delete_document and tag_document, and calling delete_document gets a step-up 403', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user, { scope: 'convert library:read' });
    const names = await toolNames(t, conn.tokens.access_token);
    expect(names.includes('get_document')).toBe(true);
    expect(names.includes('delete_document')).toBe(false);
    expect(names.includes('tag_document')).toBe(false);

    const id = insertDocument(user, 'Kept');
    const r = await callTool(t, conn.tokens.access_token, 'delete_document', { id });
    expect(r.status).toBe(403);
    expect(documentRowCount(id)).toBe(1);
  });

  it('the default grant cannot delete: delete_document asks for library:delete, and an argument cannot stand in for it', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    const id = insertDocument(user, 'Kept');

    const r = await callTool(t, conn.tokens.access_token, 'delete_document', { id, confirm: true, force: true });
    expect(r.status).toBe(403);
    const challenge = r.headers.get('www-authenticate') ?? '';
    expectIncludes(challenge, 'error="insufficient_scope"');
    expectIncludes(challenge, 'library:delete');
    expectIncludes(challenge, `resource_metadata="${METADATA_URL}"`);
    expect(r.json.error.data).toMatchObject({ code: 'insufficient_scope', required: ['library:delete'], tool: 'delete_document' });
    expect(documentRowCount(id)).toBe(1);
  });

  it('a grant approved with library:delete lists delete_document and deletes the caller\'s own document', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user, { scope: `${DEFAULT_SCOPE} library:delete` });
    expect(conn.tokens.scope?.split(' ').includes('library:delete')).toBe(true);
    expect((await toolNames(t, conn.tokens.access_token)).includes('delete_document')).toBe(true);

    const id = insertDocument(user, 'Gone');
    const r = await callTool(t, conn.tokens.access_token, 'delete_document', { id });
    expect(r.status).toBe(200);
    expect(r.json.result.isError).not.toBe(true);
    expect(documentRowCount(id)).toBe(0);
  });
});

describe('tenant isolation', () => {
  it("another user's token cannot read or delete a document, and the row survives", async () => {
    const alice = await seedUser(t, 'user');
    const bob = await seedUser(t, 'user');
    const aliceDoc = insertDocument(alice, 'Alice private');
    const bobConn = await connectOAuthClient(t, bob, { scope: `${DEFAULT_SCOPE} library:delete` });

    const read = await callTool(t, bobConn.tokens.access_token, 'get_document', { id: aliceDoc });
    expect(read.json.result.isError).toBe(true);
    expectIncludes(read.text, 'Document not found');
    expect(read.text.includes('Alice private')).toBe(false);

    const del = await callTool(t, bobConn.tokens.access_token, 'delete_document', { id: aliceDoc });
    expect(del.json.result.isError).toBe(true);
    expectIncludes(del.text, 'Document not found');
    expect(documentRowCount(aliceDoc)).toBe(1);

    const listed = await callTool(t, bobConn.tokens.access_token, 'list_documents', {});
    expect(listed.text.includes(aliceDoc)).toBe(false);
  });
});

describe('account state', () => {
  it('a suspended account gets 401 at /mcp, and works again once reactivated', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    expect((await toolNames(t, conn.tokens.access_token)).includes('get_document')).toBe(true);

    t.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);
    const blocked = await rpc(t, conn.tokens.access_token, 'tools/list');
    expect(blocked.status).toBe(401);
    expectBearerChallenge(blocked.headers);

    t.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    expect((await toolNames(t, conn.tokens.access_token)).includes('get_document')).toBe(true);
  });

  it('a suspended account cannot refresh its grant', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    t.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);

    const refreshed = await refreshTokens(t, { clientId: conn.clientId, refreshToken: conn.tokens.refresh_token! });
    expect(refreshed.status).toBe(400);
    expect(refreshed.json.error).toBe('invalid_grant');
    expect(refreshed.json.access_token).toBeUndefined();

    // The refused refresh drops the grant, so a reactivated account reconnects rather than reviving it.
    t.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    const again = await refreshTokens(t, { clientId: conn.clientId, refreshToken: conn.tokens.refresh_token! });
    expect(again.status).toBe(400);
    const reconnected = await connectOAuthClient(t, user, { clientId: conn.clientId });
    expect((await toolNames(t, reconnected.tokens.access_token)).includes('get_document')).toBe(true);
  });

  it('a deleted account gets 401 at /mcp and its grants are gone', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    expect((await t.env.OAUTH_PROVIDER.listUserGrants(user.id)).items).toHaveLength(1);

    await deleteAccount(t.env, user.id);

    expect(await getUser(t.env, user.id)).toBeNull();
    expect((await t.env.OAUTH_PROVIDER.listUserGrants(user.id)).items).toHaveLength(0);
    const r = await rpc(t, conn.tokens.access_token, 'tools/list');
    expect(r.status).toBe(401);
    expectBearerChallenge(r.headers, 'invalid_token');
  });
});

describe('credentials that are not valid OAuth tokens', () => {
  const SECRET = 'amd_test_SECRETVALUE123';

  it('answers 401 with a challenge when no token is sent', async () => {
    const r = await mcp(t, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(401);
    expectBearerChallenge(r.headers);
  });

  it('answers 401 with a challenge for malformed and forged OAuth-shaped tokens, and never echoes the token', async () => {
    const user = await seedUser(t, 'user');
    const forged = `${user.id}:not-a-grant:${SECRET}`;
    for (const presented of ['garbage', forged, `${user.id}:x:y`]) {
      const r = await rpc(t, presented, 'tools/list');
      expect(r.status, presented).toBe(401);
      expectBearerChallenge(r.headers, 'invalid_token');
      expect(r.text.includes(presented), presented).toBe(false);
    }
  });

  it('answers 401 to an invalid API-key-shaped token with an OAuth discovery challenge, without echoing it', async () => {
    const r = await rpc(t, SECRET, 'tools/list');
    expect(r.status).toBe(401);
    expectBearerChallenge(r.headers, 'invalid_token');
    expect(r.json?.error?.code).toBe('invalid_api_key');
    expect(r.text.includes(SECRET)).toBe(false);
  });
});
