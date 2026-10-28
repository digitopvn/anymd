/**
 * An OAuth 2.1 client for tests. Every request goes through the Worker's default export, so the
 * real @cloudflare/workers-oauth-provider answers discovery, dynamic registration, token, revocation
 * and the bearer checks on /mcp. Browser state (the session cookie and the consent transaction
 * cookie) is carried by hand, as a browser would carry it.
 *
 * Use `oauthTestEnv()` for the environment: `createTestEnv()` stubs OAUTH_PROVIDER with fakes, and the
 * provider only attaches its real helpers when that field is empty.
 */
import worker from '../../src/worker';
import type { Env } from '../../src/env';
import { OAUTH_DEFAULT_SCOPES } from '../../src/auth/roles';
import type { UserRow } from '../../src/auth/identity';
import { createTestEnv, seedSession, type TestEnv } from './sqlite-env';

export const PUBLIC_URL = 'https://anymd.test';
export const RESOURCE = `${PUBLIC_URL}/mcp`;
export const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
export const DEFAULT_SCOPE = OAUTH_DEFAULT_SCOPES.join(' ');

export function oauthTestEnv(overrides: Partial<Env> = {}): TestEnv {
  return createTestEnv({ OAUTH_PROVIDER: undefined, ...overrides });
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  /** The body parsed as JSON, or null when it is empty or not JSON. */
  json: any;
}

async function reply(res: Response): Promise<Reply> {
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Send one request through the Worker's default export with the test bindings. */
export function workerFetch(t: TestEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
  return worker.fetch(new Request(new URL(path, PUBLIC_URL), init), t.env, ctx as unknown as ExecutionContext);
}

/** The `name=value` pairs of a response's Set-Cookie headers, ready for a Cookie request header. */
function cookiePairs(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]);
}

function form(values: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) body.set(k, v);
  return body;
}

// ─── PKCE ───────────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Pkce {
  verifier: string;
  /** S256 challenge: base64url(SHA-256(verifier)). */
  challenge: string;
}

export async function pkce(): Promise<Pkce> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}

// ─── Dynamic client registration ────────────────────────────────────────────

/** Registers a public client (token_endpoint_auth_method none) and returns its client_id. */
export async function registerClient(t: TestEnv, redirectUris: string[] = [CHATGPT_REDIRECT]): Promise<string> {
  const r = await reply(
    await workerFetch(t, '/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    }),
  );
  if (r.status < 200 || r.status > 299 || typeof r.json?.client_id !== 'string') throw new Error(`client registration failed: ${r.status} ${r.text}`);
  return r.json.client_id;
}

// ─── Authorization and consent ──────────────────────────────────────────────

export interface AuthorizeParams {
  clientId: string;
  codeChallenge: string;
  /** Defaults to S256. */
  codeChallengeMethod?: string;
  redirectUri?: string;
  /** Space-separated scopes. Defaults to the OAuth baseline. */
  scope?: string;
  /** The RFC 8707 resource. Defaults to the MCP endpoint; null omits the parameter. */
  resource?: string | null;
  state?: string;
}

export function authorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri ?? CHATGPT_REDIRECT,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod ?? 'S256',
    state: p.state ?? 'xyz',
    scope: p.scope ?? DEFAULT_SCOPE,
  });
  if (p.resource !== null) q.set('resource', p.resource ?? RESOURCE);
  return `/oauth/authorize?${q.toString()}`;
}

export interface PendingConsent {
  status: number;
  text: string;
  /** The consent handle (the hidden `state` field), or null when no consent page was shown. */
  handle: string | null;
  /** Cookies the provider set for this consent transaction, as Cookie request pairs. */
  bindings: string[];
  /** Where an error redirect sent the browser, when the request was refused. */
  location: string | null;
}

/** Step 1: the signed-in user opens the authorize URL and sees the consent page. */
export async function beginAuthorization(t: TestEnv, session: string, params: AuthorizeParams): Promise<PendingConsent> {
  const res = await workerFetch(t, authorizeUrl(params), { headers: { cookie: `amd_session=${session}` } });
  const r = await reply(res);
  const handle = /<input[^>]*name="state"[^>]*value="([^"]+)"/.exec(r.text)?.[1] ?? null;
  return { status: r.status, text: r.text, handle, bindings: cookiePairs(res), location: res.headers.get('location') };
}

/**
 * Step 2: the user submits the consent form. `form` adds or overrides fields, such as `decision`
 * or a consent option like `admin_access`.
 */
export async function approveAuthorization(t: TestEnv, session: string, pending: PendingConsent, fields: Record<string, string> = {}): Promise<Reply> {
  const body = form({ state: pending.handle ?? '', decision: 'allow' });
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return reply(
    await workerFetch(t, '/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: PUBLIC_URL,
        cookie: [`amd_session=${session}`, ...pending.bindings].join('; '),
      },
      body,
    }),
  );
}

/** The code, state and iss from a successful authorization redirect. Throws on any other reply. */
export function callbackOf(r: Reply): { code: string; state: string | null; iss: string | null; location: string } {
  const location = r.headers.get('location');
  if (r.status !== 302 || !location) throw new Error(`authorization did not redirect: ${r.status} ${r.text.slice(0, 300)}`);
  const url = new URL(location);
  const code = url.searchParams.get('code');
  if (!code) throw new Error(`redirect carries no code: ${location}`);
  return { code, state: url.searchParams.get('state'), iss: url.searchParams.get('iss'), location };
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

/** POST /oauth/token with a form body. */
export async function tokenRequest(t: TestEnv, fields: Record<string, string | undefined>): Promise<Reply> {
  return reply(await workerFetch(t, '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(fields) }));
}

export function exchangeCode(
  t: TestEnv,
  p: { clientId: string; code: string; verifier: string; redirectUri?: string; resource?: string },
): Promise<Reply> {
  return tokenRequest(t, {
    grant_type: 'authorization_code',
    code: p.code,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri ?? CHATGPT_REDIRECT,
    client_id: p.clientId,
    resource: p.resource ?? RESOURCE,
  });
}

export function refreshTokens(t: TestEnv, p: { clientId: string; refreshToken: string; resource?: string }): Promise<Reply> {
  return tokenRequest(t, { grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId, resource: p.resource ?? RESOURCE });
}

/** RFC 7009 revocation at the token endpoint (the revocation_endpoint in discovery). */
export function revokeToken(t: TestEnv, p: { clientId: string; token: string; hint?: 'access_token' | 'refresh_token' }): Promise<Reply> {
  return tokenRequest(t, { token: p.token, client_id: p.clientId, token_type_hint: p.hint });
}

/**
 * Overwrites top-level fields of the provider's stored access-token record, to simulate a stale
 * expiry or a token bound to another resource. The record is found by the token's grant id.
 */
export function editTokenRecord(t: TestEnv, accessToken: string, patch: Record<string, unknown>): void {
  const [userId, grantId] = accessToken.split(':');
  const prefix = `token:${userId}:${grantId}:`;
  const keys = [...t.oauthKv.store.keys()].filter((k) => k.startsWith(prefix));
  if (keys.length !== 1) throw new Error(`expected one token record under ${prefix}, found ${keys.length}`);
  const record = JSON.parse(t.oauthKv.store.get(keys[0]) as string);
  t.oauthKv.store.set(keys[0], JSON.stringify({ ...record, ...patch }));
}

// ─── MCP ────────────────────────────────────────────────────────────────────

/** A JSON-RPC request to /mcp (legacy era: no protocol header). `bearer` omitted sends no Authorization header. */
export function mcp(t: TestEnv, body: unknown, bearer?: string, extraHeaders: Record<string, string> = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return workerFetch(t, '/mcp', { method: 'POST', headers, body: JSON.stringify(body) }).then(reply);
}

export function rpc(t: TestEnv, bearer: string | undefined, method: string, params?: Record<string, unknown>): Promise<Reply> {
  return mcp(t, { jsonrpc: '2.0', id: 1, method, params }, bearer);
}

export function callTool(t: TestEnv, bearer: string | undefined, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  return rpc(t, bearer, 'tools/call', { name, arguments: args });
}

/** Tool names visible to the bearer; throws when the call itself is not a 200 with a tool list. */
export async function toolNames(t: TestEnv, bearer: string): Promise<string[]> {
  const r = await rpc(t, bearer, 'tools/list');
  if (r.status !== 200 || !Array.isArray(r.json?.result?.tools)) throw new Error(`tools/list failed: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.result.tools.map((tool: { name: string }) => tool.name);
}

// ─── Whole flow ─────────────────────────────────────────────────────────────

export interface ConnectOptions {
  /** Reuse a registered client (a reconnect). Omit to register a new one. */
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  /** The RFC 8707 resource. Defaults to the MCP endpoint; null omits the parameter. */
  resource?: string | null;
  state?: string;
  /** Extra consent-form fields, e.g. `{ admin_access: 'support' }` or a future `{ read_only: '1' }`. */
  consent?: Record<string, string>;
}

export interface Connection {
  clientId: string;
  /** The session token the consent was given under. */
  session: string;
  verifier: string;
  redirectUri: string;
  code: string;
  /** The `iss` the provider put on the redirect (RFC 9207). */
  iss: string | null;
  state: string | null;
  tokens: TokenSet;
}

/**
 * The complete connection a client makes for `user`: register (unless a clientId is given), sign in
 * with a fresh session, consent, redirect, exchange the code. Throws if any step does not succeed;
 * negative cases call the steps above directly.
 */
export async function connectOAuthClient(t: TestEnv, user: UserRow, opts: ConnectOptions = {}): Promise<Connection> {
  const redirectUri = opts.redirectUri ?? CHATGPT_REDIRECT;
  const clientId = opts.clientId ?? (await registerClient(t, [redirectUri]));
  const { token: session } = await seedSession(t, user);
  const { verifier, challenge } = await pkce();
  const params: AuthorizeParams = { clientId, codeChallenge: challenge, redirectUri, scope: opts.scope, resource: opts.resource, state: opts.state };
  const pending = await beginAuthorization(t, session, params);
  if (!pending.handle) throw new Error(`consent page not shown: ${pending.status} ${pending.text.slice(0, 300)}`);
  const cb = callbackOf(await approveAuthorization(t, session, pending, opts.consent));
  const tokenReply = await exchangeCode(t, { clientId, code: cb.code, verifier, redirectUri, resource: opts.resource ?? undefined });
  if (tokenReply.status !== 200) throw new Error(`token exchange failed: ${tokenReply.status} ${tokenReply.text}`);
  return { clientId, session, verifier, redirectUri, code: cb.code, iss: cb.iss, state: cb.state, tokens: tokenReply.json as TokenSet };
}
