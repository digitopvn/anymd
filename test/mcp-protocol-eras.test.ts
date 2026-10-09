import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scopesForRole } from '../src/auth/roles';
import type { Principal } from '../src/env';
import { LEGACY_VERSIONS, META_PROTOCOL_VERSION, META_SERVER_INFO, MODERN_VERSIONS } from '../src/mcp/protocol';
import { rpc, send } from './helpers/mcp-client';
import { counter, createTestEnv, seedUser, type TestEnv } from './helpers/sqlite-env';

const MODERN = MODERN_VERSIONS[0];
let t: TestEnv;
let p: Principal;

beforeEach(async () => {
  t = createTestEnv();
  const admin = await seedUser(t, 'admin');
  p = { kind: 'api_key', userId: admin.id, role: 'admin', scopes: scopesForRole('admin'), apiKeyId: 'key_admin' };
});
afterEach(() => t.close());

function modern(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const body = { jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: { [META_PROTOCOL_VERSION]: MODERN } } };
  const name: Record<string, string> = typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {};
  return send(t.env, p, body, { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...name, ...headers });
}

describe('modern protocol (2026-07-28)', () => {
  it('describes the server through server/discover, even without a version', async () => {
    const res = await send(t.env, p, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('complete');
    expect(res.body.result.supportedVersions).toEqual([MODERN, ...LEGACY_VERSIONS]);
    expect(res.body.result._meta[META_SERVER_INFO].name).toBe('anymd');
    expect(res.body.result.ttlMs).toBe(60000);
    expect(res.body.result.cacheScope).toBe('private');
  });

  it('lists tools with result type and cache hints', async () => {
    const res = await modern('tools/list');
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('complete');
    expect(res.body.result.ttlMs).toBe(60000);
    expect(res.body.result.cacheScope).toBe('private');
    expect(res.body.result.tools.some((x: { name: string }) => x.name === 'system_overview')).toBe(true);
  });

  it('runs a tool call when the headers mirror the body, including a base64-encoded name', async () => {
    const plain = await modern('tools/call', { name: 'list_roles', arguments: {} });
    expect(plain.status).toBe(200);
    expect(plain.body.result.isError).toBeUndefined();
    const encoded = `=?base64?${btoa('list_roles')}?=`;
    const b64 = await modern('tools/call', { name: 'list_roles', arguments: {} }, { 'Mcp-Name': encoded });
    expect(b64.status).toBe(200);
    expect(b64.body.result.resultType).toBe('complete');
  });

  it('rejects header and body mismatches with -32020', async () => {
    const method = await modern('tools/list', {}, { 'Mcp-Method': 'tools/call' });
    expect(method.status).toBe(400);
    expect(method.body.error.code).toBe(-32020);
    const name = await modern('tools/call', { name: 'list_roles', arguments: {} }, { 'Mcp-Name': 'get_settings' });
    expect(name.body.error.code).toBe(-32020);
    expect(name.body.error.data.header).toBe('Mcp-Name');
    const missing = await send(t.env, p, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [META_PROTOCOL_VERSION]: MODERN } } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe(-32020);
  });

  it('rejects an unsupported version with -32022 and lists the supported ones', async () => {
    const res = await send(t.env, p, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [META_PROTOCOL_VERSION]: '2099-01-01' } } }, { 'Mcp-Method': 'tools/list' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32022);
    expect(res.body.error.data.requested).toBe('2099-01-01');
    expect(res.body.error.data.supported).toEqual(expect.arrayContaining([MODERN]));
  });

  it('has no ping or initialize and no batching', async () => {
    const ping = await modern('ping');
    expect(ping.status).toBe(404);
    expect(ping.body.error.code).toBe(-32601);
    const init = await modern('initialize');
    expect(init.status).toBe(404);
    const batch = await send(t.env, p, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], { 'MCP-Protocol-Version': MODERN });
    expect(batch.status).toBe(400);
  });
});

describe('legacy protocol (2025 clients)', () => {
  it('keeps initialize, ping and batches working', async () => {
    const init = await rpc(t.env, p, 'initialize', { protocolVersion: '2025-06-18' });
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(init.body.result.resultType).toBeUndefined();
    const unknown = await rpc(t.env, p, 'initialize', { protocolVersion: '2023-01-01' });
    expect(unknown.body.result.protocolVersion).toBe(LEGACY_VERSIONS[0]);
    expect((await rpc(t.env, p, 'ping')).body.result).toEqual({});
    const batch = await send(t.env, p, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    expect(batch.status).toBe(200);
    expect(batch.body).toHaveLength(2);
    expect(batch.body[1].result.ttlMs).toBeUndefined();
  });

  it('treats a 2025 version header as legacy', async () => {
    const res = await send(t.env, p, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2025-06-18' });
    expect(res.status).toBe(200);
  });
});

describe('MCP rate limits', () => {
  it('returns 429 with Retry-After and -32005 once the request bucket is spent', async () => {
    const rl = counter(2);
    t.env.RL_MCP = rl;
    await rpc(t.env, p, 'tools/list');
    await rpc(t.env, p, 'tools/list');
    const res = await rpc(t.env, p, 'tools/list');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.body.error.code).toBe(-32005);
    expect(res.body.error.data).toEqual({ code: 'rate_limited', bucket: 'request', retryAfter: 60 });
    expect(rl.calls[0]).toBe(`mcp:request:${p.userId}:k:key_admin`);
  });

  it('keys the bucket by credential, so another key of the same user is unaffected', async () => {
    t.env.RL_MCP = counter(1);
    expect((await rpc(t.env, p, 'tools/list')).status).toBe(200);
    expect((await rpc(t.env, p, 'tools/list')).status).toBe(429);
    expect((await rpc(t.env, { ...p, apiKeyId: 'key_other' }, 'tools/list')).status).toBe(200);
  });

  it('limits mutating tools with the stricter bucket only', async () => {
    t.env.RL_MCP = counter();
    const mutation = counter(1);
    t.env.RL_MCP_MUTATION = mutation;
    const add = (domain: string) => rpc(t.env, p, 'tools/call', { name: 'add_site_optout', arguments: { domain } });
    expect((await add('one.example')).body.result.isError).toBeUndefined();
    const blocked = await add('two.example');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.data.bucket).toBe('mutation');
    // Reads keep working while the mutation bucket is spent.
    expect((await rpc(t.env, p, 'tools/call', { name: 'list_site_optouts', arguments: {} })).status).toBe(200);
    expect(mutation.calls).toHaveLength(2);
  });

  it('falls back to RL_AUTH and fails open when the limiter errors', async () => {
    const auth = counter();
    t.env.RL_AUTH = auth;
    await rpc(t.env, p, 'tools/list');
    expect(auth.calls[0]).toMatch(/^mcp:request:/);
    t.env.RL_MCP = { limit: async () => Promise.reject(new Error('down')) };
    expect((await rpc(t.env, p, 'tools/list')).status).toBe(200);
  });
});
