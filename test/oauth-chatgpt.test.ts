/**
 * What ChatGPT (and other public MCP hosts) rely on beyond the core OAuth flow: per-tool
 * securitySchemes, the tool-level step-up challenge, CIMD client identification, the read-only
 * consent, the auth-failure budget and grant cleanup when an account is deleted.
 *
 * Substring checks use `.includes()` for the reason given in oauth-flow.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consentGrantScopes } from '../src/auth/consent';
import { readOnlyScopes } from '../src/auth/roles';
import { deleteAccount } from '../src/lib/account';
import {
  approveAuthorization,
  beginAuthorization,
  CHATGPT_REDIRECT,
  callTool,
  callbackOf,
  connectOAuthClient,
  exchangeCode,
  mcp,
  oauthTestEnv,
  pkce,
  registerClient,
  rpc,
  toolNames,
  workerFetch,
} from './helpers/oauth-flow';
import { counter, createTestEnv, seedSession, seedUser, type TestEnv } from './helpers/sqlite-env';

/** ChatGPT's client metadata document, as served at https://chatgpt.com/oauth/client.json. */
const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_CLIENT_METADATA = {
  client_id: CHATGPT_CLIENT_ID,
  client_uri: 'https://chatgpt.com/',
  redirect_uris: [CHATGPT_REDIRECT],
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'ChatGPT',
  logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
  token_endpoint_auth_signing_alg: 'RS256',
  jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
};

let t: TestEnv;

beforeEach(() => {
  t = oauthTestEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  t.close();
});

interface ListedTool {
  name: string;
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
  securitySchemes?: { type: string; scopes: string[] }[];
}

async function listTools(token: string): Promise<ListedTool[]> {
  const r = await rpc(t, token, 'tools/list');
  expect(r.status).toBe(200);
  return r.json.result.tools as ListedTool[];
}

describe('tools/list for ChatGPT', () => {
  it('every tool declares an oauth2 security scheme naming the scope it needs', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    const tools = await listTools(conn.tokens.access_token);

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.securitySchemes, tool.name).toHaveLength(1);
      expect(tool.securitySchemes![0].type, tool.name).toBe('oauth2');
    }
    const del = tools.find((x) => x.name === 'delete_document');
    expect(del?.securitySchemes?.[0].scopes).toEqual(['library:write']);
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((x) => x.name === 'search_library')?.securitySchemes?.[0].scopes).toEqual(['library:read']);
  });
});

describe('step-up inside a batch', () => {
  it('a tool result refused for a missing scope carries the challenge in _meta["mcp/www_authenticate"]', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    // A JSON-RPC batch cannot answer with HTTP 403 for one entry, so the challenge rides on the result.
    const r = await mcp(
      t,
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'usage_summary', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
      conn.tokens.access_token,
    );
    expect(r.status).toBe(200);
    const denied = (r.json as { id: number; result: { isError?: boolean; _meta?: Record<string, string[]> } }[]).find((m) => m.id === 1)!;
    expect(denied.result.isError).toBe(true);
    const challenges = denied.result._meta?.['mcp/www_authenticate'] ?? [];
    expect(challenges).toHaveLength(1);
    for (const part of ['Bearer ', 'error="insufficient_scope"', 'error_description="', 'usage:read', 'resource_metadata="']) {
      expect(challenges[0].includes(part), `${challenges[0]} lacks ${part}`).toBe(true);
    }
  });

  it('a single call refused for a missing scope is still an HTTP 403 step-up', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user);
    const r = await callTool(t, conn.tokens.access_token, 'usage_summary');
    expect(r.status).toBe(403);
    expect((r.headers.get('www-authenticate') ?? '').includes('error="insufficient_scope"')).toBe(true);
  });
});

describe('read-only connection', () => {
  it('the consent page offers it, and choosing it grants only read scopes', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user, { consent: { read_only: '1' } });

    expect(conn.tokens.scope?.split(' ').sort()).toEqual(['convert', 'library:read']);
    const names = await toolNames(t, conn.tokens.access_token);
    expect(names.includes('search_library')).toBe(true);
    expect(names.includes('delete_document')).toBe(false);
    expect(names.includes('tag_document')).toBe(false);
  });

  it('the server refuses delete_document for a read-only grant, whatever the model sends', async () => {
    const user = await seedUser(t, 'user');
    const conn = await connectOAuthClient(t, user, { consent: { read_only: '1' } });
    const id = crypto.randomUUID();
    const now = Date.now();
    t.db
      .prepare('INSERT INTO documents (id, user_id, url, url_hash, title, markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, user.id, `https://example.com/${id}`, `hash-${id}`, 'Keep me', '# Keep me', now, now);

    const r = await callTool(t, conn.tokens.access_token, 'delete_document', { id, confirm: true });
    expect(r.status).toBe(403);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(id) as { n: number }).n).toBe(1);
  });

  it('shows the read-only option on the consent page', async () => {
    const user = await seedUser(t, 'user');
    const { token: session } = await seedSession(t, user);
    const { challenge } = await pkce();
    const clientId = await registerClient(t);
    const pending = await beginAuthorization(t, session, { clientId, codeChallenge: challenge });
    expect(pending.text.includes('data-read-only')).toBe(true);
    expect(pending.text.includes('name="read_only"')).toBe(true);
  });

  it('readOnlyScopes keeps convert and :read scopes only', () => {
    expect(readOnlyScopes(['convert', 'library:read', 'library:write', 'usage:read', 'pages:write'])).toEqual(['convert', 'library:read', 'usage:read']);
  });

  it('consentGrantScopes drops write scopes when read-only is chosen, including an admin preset', () => {
    const requested = ['convert', 'library:read', 'library:write'] as const;
    expect(consentGrantScopes('user', [...requested], undefined, true).sort()).toEqual(['convert', 'library:read']);
    expect(consentGrantScopes('user', [...requested], undefined, false).includes('library:write')).toBe(true);
    const admin = consentGrantScopes('owner', [...requested], 'support', true);
    expect(admin.every((s) => s === 'convert' || s.endsWith(':read')), admin.join(' ')).toBe(true);
  });
});

describe('CIMD (client ID metadata document)', () => {
  beforeEach(() => {
    // The provider enables CIMD only where outbound fetches are restricted to public addresses.
    vi.stubGlobal('Cloudflare', { compatibilityFlags: { global_fetch_strictly_public: true } });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === CHATGPT_CLIENT_ID) return new Response(JSON.stringify(CHATGPT_CLIENT_METADATA), { headers: { 'content-type': 'application/json' } });
      return realFetch(input, init);
    });
  });

  it('advertises CIMD support in authorization server metadata', async () => {
    const res = await workerFetch(t, '/.well-known/oauth-authorization-server');
    expect(((await res.json()) as { client_id_metadata_document_supported?: boolean }).client_id_metadata_document_supported).toBe(true);
  });

  it("ChatGPT's metadata-document client consents, gets a code with iss, and exchanges it as a public client", async () => {
    const user = await seedUser(t, 'user');
    const { token: session } = await seedSession(t, user);
    const { verifier, challenge } = await pkce();
    const pending = await beginAuthorization(t, session, { clientId: CHATGPT_CLIENT_ID, codeChallenge: challenge });

    expect(pending.handle, pending.text.slice(0, 300)).toBeTruthy();
    expect(pending.text.includes('ChatGPT')).toBe(true);
    expect(pending.text.includes('data-client-metadata')).toBe(true);

    const cb = callbackOf(await approveAuthorization(t, session, pending));
    expect(cb.location.startsWith(CHATGPT_REDIRECT)).toBe(true);
    expect(cb.iss).toBe('https://anymd.test');

    const tokens = await exchangeCode(t, { clientId: CHATGPT_CLIENT_ID, code: cb.code, verifier });
    expect(tokens.status, tokens.text).toBe(200);
    expect((await toolNames(t, tokens.json.access_token)).includes('search_library')).toBe(true);
  });
});

describe('auth failure budget', () => {
  it('counts failed bearer tokens per IP, answers 429 once spent, and never logs the credential', async () => {
    t.close();
    t = oauthTestEnv({ RL_AUTH: counter(2) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const SECRET = 'amd_test_LEAKCHECK0123456789';
    const FORGED = 'usr_x:grant_y:LEAKCHECKOAUTH';
    const statuses: number[] = [];
    for (const token of [SECRET, FORGED, SECRET]) statuses.push((await rpc(t, token, 'tools/list')).status);

    expect(statuses).toEqual([401, 401, 429]);
    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged.includes('"event":"auth_failure"')).toBe(true);
    expect(logged.includes('LEAKCHECK')).toBe(false);
  });

  it('does not count a first contact without any credential', async () => {
    const limiter = counter(0);
    t.close();
    t = oauthTestEnv({ RL_AUTH: limiter });
    const r = await mcp(t, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(401);
    expect(limiter.calls.filter((k) => k.startsWith('authfail:'))).toEqual([]);
  });
});

describe('account deletion', () => {
  it('revokes grants on every page of the OAuth store, not just the first', async () => {
    const revoked: string[] = [];
    const pages: Record<string, { items: { id: string }[]; cursor?: string }> = {
      '': { items: [{ id: 'g1' }, { id: 'g2' }], cursor: 'p2' },
      p2: { items: [{ id: 'g3' }], cursor: 'p3' },
      p3: { items: [{ id: 'g4' }] },
    };
    const env = createTestEnv({
      OAUTH_PROVIDER: {
        async listUserGrants(_userId: string, opts?: { cursor?: string }) {
          return pages[opts?.cursor ?? ''];
        },
        async revokeGrant(grantId: string) {
          revoked.push(grantId);
        },
      } as never,
    });
    try {
      const user = await seedUser(env, 'user');
      await deleteAccount(env.env, user.id);
      expect(revoked).toEqual(['g1', 'g2', 'g3', 'g4']);
    } finally {
      env.close();
    }
  });
});
