/** Least-privilege defaults and abuse bounds around the admin control plane. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scopesForRole } from '../src/auth/roles';
import type { Principal } from '../src/env';
import { app } from '../src/worker';
import { callTool, send } from './helpers/mcp-client';
import { counter, createTestEnv, seedUser, type TestEnv } from './helpers/sqlite-env';

let t: TestEnv;
beforeEach(() => {
  t = createTestEnv();
});
afterEach(() => t.close());

const ok = (r: { result: { isError?: boolean; structuredContent?: any; content: { text: string }[] } }) => {
  if (r.result.isError) throw new Error(r.result.content[0].text);
  return r.result.structuredContent;
};

describe('OAuth discovery advertises only the baseline', () => {
  it('names the least-privilege scopes in the 401 challenge for unauthenticated MCP calls', async () => {
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    const res = await app.fetch(new Request('https://anymd.test/mcp', { method: 'POST', body: '{}' }), t.env, ctx as never);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch('scope="convert library:read library:write"');
  });
});

describe('API keys and OAuth connections', () => {
  it('never lets a connected app mint a key, since the key would outlive the grant', async () => {
    const owner = await seedUser(t, 'owner');
    const p: Principal = { kind: 'oauth', userId: owner.id, role: 'owner', scopes: scopesForRole('owner'), clientId: 'client_a' };
    for (const args of [{ name: 'from agent', preset: 'full' }, { name: 'convert', preset: 'convert-only' }]) {
      const res = await callTool(t.env, p, 'create_api_key', args);
      expect(res.result.isError).toBe(true);
      expect(res.result.structuredContent.error.code).toBe('oauth_key_creation_forbidden');
    }
    expect(await t.env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys').first('n')).toBe(0);
  });

  it('translates legacy scope names before checking what the creating credential holds', async () => {
    const owner = await seedUser(t, 'owner');
    const p: Principal = { kind: 'session', userId: owner.id, role: 'owner', scopes: scopesForRole('owner') };
    const out = ok(await callTool(t.env, p, 'create_api_key', { name: 'legacy names', scopes: ['users:write', 'settings:write'] }));
    expect(out.scopes.sort()).toEqual(['settings:read', 'settings:write', 'users:roles:write']);
  });
});

describe('legacy batches', () => {
  it('are capped in size', async () => {
    const admin = await seedUser(t, 'admin');
    const p: Principal = { kind: 'session', userId: admin.id, role: 'admin', scopes: scopesForRole('admin') };
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    expect((await send(t.env, p, batch)).status).toBe(400);
    expect((await send(t.env, p, [])).status).toBe(400);
  });

  it('charge the rate limits once per message, so a batch cannot multiply mutations', async () => {
    const admin = await seedUser(t, 'admin');
    const p: Principal = { kind: 'session', userId: admin.id, role: 'admin', scopes: scopesForRole('admin') };
    t.env.RL_MCP = counter();
    t.env.RL_MCP_MUTATION = counter(2);
    const batch = ['a', 'b', 'c'].map((d, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'add_site_optout', arguments: { domain: `${d}.example` } } }));
    const res = await send(t.env, p, batch);
    expect(res.status).toBe(429);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((r: { id: number }) => r.id)).toEqual([0, 1, 2]);
    expect(res.body[0].error.data.bucket).toBe('mutation');
  });

  it('are refused for protocol versions that dropped batching, and kept for older ones', async () => {
    const admin = await seedUser(t, 'admin');
    const p: Principal = { kind: 'session', userId: admin.id, role: 'admin', scopes: scopesForRole('admin') };
    const batch = [{ jsonrpc: '2.0', id: 1, method: 'ping' }];
    for (const v of ['2025-06-18', '2025-11-25']) {
      const res = await send(t.env, p, batch, { 'MCP-Protocol-Version': v });
      expect(res.status, v).toBe(400);
      expect(res.body.error.code, v).toBe(-32600);
    }
    for (const headers of [{ 'MCP-Protocol-Version': '2025-03-26' }, {}] as Record<string, string>[]) {
      const res = await send(t.env, p, batch, headers);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    }
  });

  it('answer non-object messages with -32600 without spending the rate limit', async () => {
    const admin = await seedUser(t, 'admin');
    const p: Principal = { kind: 'session', userId: admin.id, role: 'admin', scopes: scopesForRole('admin') };
    const limiter = counter();
    t.env.RL_MCP = limiter;
    for (const payload of [null, 7, 'x']) {
      const res = await send(t.env, p, payload);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32600);
    }
    const mixed = await send(t.env, p, [null, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
    expect(mixed.status).toBe(200);
    expect(mixed.body).toEqual([expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32600 }) }), expect.objectContaining({ id: 2, result: {} })]);
    expect(limiter.calls).toHaveLength(1);
  });
});

describe('audit filters', () => {
  it('matches action prefixes containing underscores literally', async () => {
    const admin = await seedUser(t, 'admin');
    const target = await seedUser(t, 'user');
    const p: Principal = { kind: 'session', userId: admin.id, role: 'admin', scopes: scopesForRole('admin') };
    const { createApiKey } = await import('../src/auth/identity');
    const { row } = await createApiKey(t.env, target, { name: 'k', scopes: ['convert'] });
    ok(await callTool(t.env, p, 'revoke_user_api_key', { userId: target.id, keyId: row.id }));
    // A row whose action would only match if "_" were a wildcard.
    t.db.prepare("INSERT INTO audit_log (id, actor, action, target, meta, created_at) VALUES ('aud_x', 'system', 'apiXkey.revoke', 'x', '{}', ?)").run(Date.now());
    const events = ok(await callTool(t.env, p, 'list_audit_events', { action: 'api_key.*' }));
    expect(events.items.map((e: { action: string }) => e.action)).toEqual(['api_key.revoke']);
  });
});
