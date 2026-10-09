/** The REST adapters under /api/v1/admin, through the real Hono app and an in-memory database. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../src/auth/identity';
import { app } from '../src/worker';
import { counter, createTestEnv, seedKey, seedUser, type TestEnv } from './helpers/sqlite-env';

const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException: () => {} };

let t: TestEnv;
let ownerKey: string;
let target: UserRow;

beforeEach(async () => {
  t = createTestEnv({ RL_MCP: counter(), RL_MCP_MUTATION: counter() } as never);
  const owner = await seedUser(t, 'owner');
  ownerKey = (await seedKey(t, owner, ['users:read', 'users:roles:write', 'audit:read', 'settings:read', 'settings:write', 'credits:write'])).key;
  target = await seedUser(t, 'user');
});
afterEach(() => t.close());

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, key = ownerKey) {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers } };
  if (body) init.body = JSON.stringify(body);
  return app.fetch(new Request(`https://anymd.test/api/v1${path}`, init), t.env, ctx as never);
}

describe('admin REST', () => {
  it('changes a role and refuses plan edits with plan_managed_by_billing', async () => {
    const role = await call('PATCH', `/admin/users/${target.id}`, { role: 'editor' });
    expect(role.status).toBe(200);
    expect(await role.json()).toMatchObject({ ok: true, changed: true });
    const plan = await call('PATCH', `/admin/users/${target.id}`, { plan: 'pro' });
    expect(plan.status).toBe(422);
    expect(((await plan.json()) as { error: { code: string } }).error.code).toBe('plan_managed_by_billing');
  });

  it('records via and credential on audit rows and exports them as NDJSON', async () => {
    await call('PATCH', `/admin/users/${target.id}`, { role: 'viewer' });
    const res = await call('GET', '/admin/audit/export?action=user.*');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch('application/x-ndjson');
    expect(res.headers.get('x-anymd-count')).toBe('1');
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ action: 'user.role.update', target: target.id, auth_kind: 'api_key' });
    expect(lines[0].via).toMatch(/^api:PATCH /);
  });

  it('takes the Idempotency-Key header for credit grants and reports a replay with 200', async () => {
    const body = { userId: target.id, credits: 10, reason: 'support' };
    const first = await call('POST', '/admin/credits', body, { 'Idempotency-Key': 'rest-grant-1' });
    expect(first.status).toBe(201);
    const again = await call('POST', '/admin/credits', body, { 'Idempotency-Key': 'rest-grant-1' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
  });

  it('updates settings with expectedVersion and returns 409 on a stale version', async () => {
    const ok = await call('PATCH', '/admin/settings', { patch: { announcement: 'Hello' }, expectedVersion: 1 });
    expect(ok.status).toBe(200);
    const stale = await call('PATCH', '/admin/settings', { patch: { announcement: 'Again' }, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('settings_conflict');
  });

  it('requires the right scope on each route', async () => {
    const limited = (await seedKey(t, target, ['convert'])).key;
    const res = await call('GET', '/admin/users', undefined, {}, limited);
    expect(res.status).toBe(403);
    const optouts = await call('GET', '/admin/optouts');
    expect(optouts.status).toBe(403);
  });

  it('counts REST traffic in the REST bucket, not the MCP buckets', async () => {
    const auth = counter();
    const mcp = counter();
    t.env.RL_AUTH = auth;
    t.env.RL_MCP = mcp;
    await call('GET', '/admin/users');
    expect(auth.calls.some((k) => k.startsWith('u:'))).toBe(true);
    expect(mcp.calls).toHaveLength(0);
  });
});
