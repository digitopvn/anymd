// Drives the real OAuth + MCP flow against a local `wrangler dev` (https://127.0.0.1:8787, PUBLIC_URL=https://staging.anymd.cc).
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.BASE ?? 'https://127.0.0.1:8787';
const RESOURCE = 'https://staging.anymd.cc/mcp';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const b64url = (b) => Buffer.from(b).toString('base64url');
const cookieJar = new Map();
function keepCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookieJar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}
const cookieHeader = () => [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');
async function req(path, init = {}) {
  const res = await fetch(BASE + path, { redirect: 'manual', ...init, headers: { origin: 'https://staging.anymd.cc', cookie: cookieHeader(), ...(init.headers ?? {}) } });
  keepCookies(res);
  return res;
}
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function mcp(token, method, params) {
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await res.text();
  return { status: res.status, www: res.headers.get('www-authenticate'), body: text ? JSON.parse(text) : null, text };
}

async function signup() {
  const email = `e2e-${Date.now()}@example.test`;
  const res = await req('/signup', { method: 'POST', headers: FORM, body: form({ email, password: 'correct horse battery', name: 'E2E', terms: '1', next: '/' }) });
  return { status: res.status, email };
}

async function register(clientName) {
  const res = await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  return { status: res.status, body: await res.json() };
}

async function authorize(clientId, { scope = 'convert library:read library:write', resource = RESOURCE, readOnly = false } = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', scope, resource });
  const page = await req(`/oauth/authorize?${q}`);
  const html = await page.text();
  const handle = /name="state" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) return { status: page.status, html, location: page.headers.get('location') ?? '', verifier };
  const post = await req('/oauth/authorize', { method: 'POST', headers: FORM, body: form({ state: handle, decision: 'allow', ...(readOnly ? { read_only: '1' } : {}) }) });
  const loc = post.headers.get('location') ?? '';
  const u = loc ? new URL(loc) : null;
  return { status: post.status, html, location: loc, code: u?.searchParams.get('code'), iss: u?.searchParams.get('iss'), state: u?.searchParams.get('state'), verifier };
}

async function token(params) {
  const res = await req('/oauth/token', { method: 'POST', headers: FORM, body: form(params) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function connect(clientId, opts) {
  const a = await authorize(clientId, opts);
  const t = await token({ grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE });
  return { a, t };
}

const s = await signup();
check('signup creates a session', s.status === 302 && cookieJar.has('amd_session') || [...cookieJar.keys()].some((k) => /session/i.test(k)), `status ${s.status}`);

const reg = await register('E2E ChatGPT stand-in');
check('DCR registers a public client', reg.status === 201 && Boolean(reg.body.client_id), `status ${reg.status}`);
const clientId = reg.body.client_id;

const first = await connect(clientId);
check('authorize redirects to the exact ChatGPT redirect with code, state and iss', first.a.status === 302 && first.a.location.startsWith(REDIRECT) && first.a.state === 'st-1' && first.a.iss === 'https://staging.anymd.cc', first.a.location.slice(0, 80));
check('consent page offers a read-only connection', /data-read-only/.test(first.a.html));
check('token exchange with PKCE S256 + resource', first.t.status === 200 && Boolean(first.t.body?.access_token) && Boolean(first.t.body?.refresh_token), `scope=${first.t.body?.scope}`);
const access = first.t.body.access_token;

const list = await mcp(access, 'tools/list');
const tools = list.body?.result?.tools ?? [];
const del = tools.find((t) => t.name === 'delete_document');
check('the default grant does not list delete_document (it needs library:delete)', !del);
check('every listed tool declares securitySchemes', tools.length > 0 && tools.every((t) => Array.isArray(t.securitySchemes)));

const usage = await mcp(access, 'tools/call', { name: 'usage_summary', arguments: {} });
check('missing scope (usage:read) → 403 insufficient_scope step-up', usage.status === 403 && /insufficient_scope/.test(usage.www ?? '') && /resource_metadata=/.test(usage.www ?? ''), usage.www?.slice(0, 90));

const reconnect = await connect(clientId);
check('returning user reconnects (second grant) and the new token works', reconnect.t.status === 200 && (await mcp(reconnect.t.body.access_token, 'tools/list')).status === 200);

const stale = await token({ grant_type: 'refresh_token', refresh_token: first.t.body.refresh_token, client_id: clientId, resource: RESOURCE });
check('reconnect replaces the earlier grant: its refresh token is now invalid_grant', stale.status === 400 && stale.body?.error === 'invalid_grant', JSON.stringify(stale.body));
check('the earlier access token stops working after reconnect', (await mcp(access, 'tools/list')).status === 401);
const refreshed = await token({ grant_type: 'refresh_token', refresh_token: reconnect.t.body.refresh_token, client_id: clientId, resource: RESOURCE });
check('refresh_token grant issues a working token', refreshed.status === 200 && (await mcp(refreshed.body.access_token, 'tools/list')).status === 200, `status ${refreshed.status}`);

const ro = await connect(clientId, { readOnly: true });
const roList = await mcp(ro.t.body.access_token, 'tools/list');
const roNames = (roList.body?.result?.tools ?? []).map((t) => t.name);
check('read-only grant stores only read scopes', ro.t.status === 200 && !/library:write/.test(ro.t.body.scope ?? ''), `scope=${ro.t.body?.scope}`);
check('read-only connection does not list write/delete tools', roNames.includes('search_library') && !roNames.includes('delete_document') && !roNames.includes('tag_document'));
const roDel = await mcp(ro.t.body.access_token, 'tools/call', { name: 'delete_document', arguments: { id: 'anything' } });
check('read-only connection calling delete_document is refused by the server', roDel.status === 403 && /insufficient_scope/.test(roDel.www ?? ''), `status ${roDel.status}`);

const badVerifier = await authorize(clientId);
const bad = await token({ grant_type: 'authorization_code', code: badVerifier.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: b64url(randomBytes(32)), resource: RESOURCE });
check('wrong PKCE verifier → invalid_grant', bad.status === 400 && bad.body?.error === 'invalid_grant', JSON.stringify(bad.body));

const evil = await authorize(clientId, { resource: 'https://evil.example/mcp' });
check('authorize for another resource is refused on an error page whose return link carries invalid_target (no redirect, no code)', evil.status === 400 && !evil.location && /data-oauth-error-return/.test(evil.html) && /error=invalid_target/.test(evil.html), `status ${evil.status}`);

const current = (await connect(clientId)).t.body.access_token;
const revoke = await req('/oauth/token', { method: 'POST', headers: FORM, body: form({ token: current, token_type_hint: 'access_token', client_id: clientId }) });
const afterRevoke = await mcp(current, 'tools/list');
check('revoked token → 401 with resource_metadata challenge, token never echoed', revoke.status === 200 && afterRevoke.status === 401 && /resource_metadata=/.test(afterRevoke.www ?? '') && !afterRevoke.text.includes(current), `revoke ${revoke.status}, then ${afterRevoke.status}`);

const garbageKey = 'amd_' + 'x'.repeat(40);
const gk = await fetch(BASE + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${garbageKey}`, 'content-type': 'application/json' }, body: '{}' });
const gkText = await gk.text();
check('unknown API key → 401 invalid_api_key, key not echoed', gk.status === 401 && gkText.includes('invalid_api_key') && !gkText.includes(garbageKey));

// CIMD with ChatGPT's real client metadata document (the local Worker fetches it from chatgpt.com).
const cimd = await authorize('https://chatgpt.com/oauth/client.json');
check('CIMD: ChatGPT metadata-document client reaches consent and gets a code', Boolean(cimd.code) && /chatgpt\.com\/oauth\/client\.json/.test(cimd.html), cimd.code ? 'code issued' : `status ${cimd.status} ${cimd.html?.slice(0, 160)}`);
if (cimd.code) {
  const ct = await token({ grant_type: 'authorization_code', code: cimd.code, redirect_uri: REDIRECT, client_id: 'https://chatgpt.com/oauth/client.json', code_verifier: cimd.verifier, resource: RESOURCE });
  check('CIMD: token exchange as public client (none) works', ct.status === 200 && (await mcp(ct.body.access_token, 'tools/list')).status === 200, `status ${ct.status} ${ct.status !== 200 ? JSON.stringify(ct.body) : ''}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
