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
    expect(res.headers.get('www-authenticate')).toMatch('scope="convert library:read"');
  });
});

describe('API keys minted over OAuth', () => {
  it('never carry admin scopes, so they cannot outlive the grant with admin power', async () => {
    const owner = await seedUser(t, 'owner');
    const p: Principal = { kind: 'oauth', userId: owner.id, role: 'owner', scopes: scopesForRole('owner'), clientId: 'client_a' };
    const out = ok(await callTool(t.env, p, 'create_api_key', { name: 'from agent', preset: 'full' }));
    expect(out.scopes).toEqual(expect.arrayContaining(['convert', 'keys:manage']));
    expect(out.scopes.some((s: string) => ['users:read', 'credits:write', 'settings:write', 'audit:read'].includes(s))).toBe(false);
    const onlyAdmin = await callTool(t.env, p, 'create_api_key', { name: 'admin only', scopes: ['users:read'] });
    expect(onlyAdmin.result.structuredContent.error.code).toBe('no_scopes');
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
    expect(res.body.error.data.bucket).toBe('mutation');
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
