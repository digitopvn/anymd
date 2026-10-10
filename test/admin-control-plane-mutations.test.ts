import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { principalFromApiKey, userFromSession } from '../src/auth/identity';
import { scopesForRole } from '../src/auth/roles';
import type { Principal } from '../src/env';
import { getSettings } from '../src/lib/settings';
import { extraCredits } from '../src/lib/usage';
import { callTool } from './helpers/mcp-client';
import { auditRows, createTestEnv, seedKey, seedSession, seedUser, sessionOf, type TestEnv } from './helpers/sqlite-env';

let t: TestEnv;
beforeEach(() => {
  t = createTestEnv();
});
afterEach(() => t.close());

async function owner(): Promise<Principal> {
  const u = await seedUser(t, 'owner');
  return { kind: 'api_key', userId: u.id, role: 'owner', scopes: scopesForRole('owner'), apiKeyId: 'key_owner', requestId: 'req-1' };
}

const ok = (r: { result: { isError?: boolean; structuredContent?: any; content: { text: string }[] } }) => {
  if (r.result.isError) throw new Error(r.result.content[0].text);
  return r.result.structuredContent;
};
const errorCode = (r: { result: { structuredContent?: any } }) => r.result.structuredContent?.error?.code;

describe('role changes', () => {
  it('changes a role with an audit row naming the tool, credential and request', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'user');
    const out = ok(await callTool(t.env, actor, 'update_user_role', { userId: target.id, role: 'editor', expectedRole: 'user' }));
    expect(out.changed).toBe(true);
    const [row] = auditRows(t, 'user.role.update');
    expect(row).toMatchObject({ actor_user_id: actor.userId, auth_kind: 'api_key', credential_id: 'key_owner', target_type: 'user', target: target.id, via: 'mcp:update_user_role', request_id: 'req-1' });
    expect(JSON.parse(String(row.meta)).diff).toEqual({ role: { from: 'user', to: 'editor' } });
  });

  it('refuses a stale expectedRole with role_conflict and writes no audit row', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'author');
    const res = await callTool(t.env, actor, 'update_user_role', { userId: target.id, role: 'editor', expectedRole: 'user' });
    expect(errorCode(res)).toBe('role_conflict');
    expect(auditRows(t, 'user.role.update')).toHaveLength(0);
  });

  it('replays an idempotent retry and rejects a reused key with another payload', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'user');
    const first = ok(await callTool(t.env, actor, 'update_user_role', { userId: target.id, role: 'viewer', idempotencyKey: 'role-change-1' }));
    expect(first.replayed).toBe(false);
    const again = ok(await callTool(t.env, actor, 'update_user_role', { userId: target.id, role: 'viewer', idempotencyKey: 'role-change-1' }));
    expect(again.replayed).toBe(true);
    expect(auditRows(t, 'user.role.update')).toHaveLength(1);
    const other = await callTool(t.env, actor, 'update_user_role', { userId: target.id, role: 'editor', idempotencyKey: 'role-change-1' });
    expect(errorCode(other)).toBe('idempotency_mismatch');
  });
});

describe('suspension and credential revocation', () => {
  it('suspension ends sessions and stops API keys; reactivation restores keys', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'user');
    const session = await seedSession(t, target);
    const { key } = await seedKey(t, target, ['convert']);
    const out = ok(await callTool(t.env, actor, 'set_user_status', { userId: target.id, status: 'suspended', reason: 'abuse report' }));
    expect(out.sessionsRevoked).toBe(1);
    expect(await userFromSession(t.env, session.token)).toBeNull();
    expect(await principalFromApiKey(t.env, key)).toBeNull();
    expect(JSON.parse(String(auditRows(t, 'user.suspend')[0].meta)).reason).toBe('abuse report');

    ok(await callTool(t.env, actor, 'set_user_status', { userId: target.id, status: 'active', reason: 'appeal accepted' }));
    expect(await principalFromApiKey(t.env, key)).not.toBeNull();
    expect(auditRows(t, 'user.reactivate')).toHaveLength(1);
  });

  it('revokes sessions, one API key and an OAuth grant of a lower-ranked user', async () => {
    const admin = await seedUser(t, 'admin');
    const actor = sessionOf(admin, scopesForRole('admin'));
    const target = await seedUser(t, 'user');
    await seedSession(t, target);
    await seedSession(t, target);
    const { key, row } = await seedKey(t, target, ['convert']);
    t.grants.push({ id: 'grant-1', clientId: 'client-1', userId: target.id, scope: ['convert'], metadata: {}, createdAt: Date.now() });

    const creds = ok(await callTool(t.env, actor, 'list_user_credentials', { userId: target.id }));
    expect(JSON.stringify(creds)).not.toMatch(/key_hash|amd_[A-Za-z0-9]{20}/);

    expect(ok(await callTool(t.env, actor, 'revoke_user_sessions', { userId: target.id })).revoked).toBe(2);
    expect(ok(await callTool(t.env, actor, 'revoke_user_api_key', { userId: target.id, keyId: row.id })).revoked).toBe(true);
    expect(ok(await callTool(t.env, actor, 'revoke_user_api_key', { userId: target.id, keyId: row.id })).alreadyRevoked).toBe(true);
    expect(await principalFromApiKey(t.env, key)).toBeNull();
    expect(ok(await callTool(t.env, actor, 'revoke_oauth_grant', { userId: target.id, grantId: 'grant-1' })).revoked).toBe(true);
    expect(t.grants).toHaveLength(0);
    expect(auditRows(t, 'user.sessions.revoke')).toHaveLength(1);
    expect(auditRows(t, 'api_key.revoke')).toHaveLength(1);
  });
});

describe('credit grants', () => {
  it('grants once per idempotency key, counts while active and stops counting when revoked', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'user');
    const args = { userId: target.id, credits: 250, reason: 'support goodwill', idempotencyKey: 'grant-abc' };
    const first = ok(await callTool(t.env, actor, 'grant_credits', args));
    expect(first.replayed).toBe(false);
    const again = ok(await callTool(t.env, actor, 'grant_credits', args));
    expect(again.replayed).toBe(true);
    expect(again.grant.id).toBe(first.grant.id);
    expect(errorCode(await callTool(t.env, actor, 'grant_credits', { ...args, credits: 999 }))).toBe('idempotency_mismatch');
    expect(auditRows(t, 'credits.grant')).toHaveLength(1);
    expect(await extraCredits(t.env, target.id)).toBe(250);

    const revoked = ok(await callTool(t.env, actor, 'revoke_credit_grant', { grantId: first.grant.id, reason: 'granted by mistake' }));
    expect(revoked.changed).toBe(true);
    expect(revoked.grant.state).toBe('revoked');
    expect(await extraCredits(t.env, target.id)).toBe(0);
    expect(ok(await callTool(t.env, actor, 'revoke_credit_grant', { grantId: first.grant.id, reason: 'granted by mistake' })).alreadyRevoked).toBe(true);
    expect(auditRows(t, 'credits.revoke')).toHaveLength(1);
  });

  it('leaves billing-issued grants to the billing provider', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'user');
    t.db.prepare("INSERT INTO credit_grants (id,user_id,source,reference,credits,created_at) VALUES ('cg_order',?, 'polar_order','ord_1',100,?)").run(target.id, Date.now());
    expect(errorCode(await callTool(t.env, actor, 'revoke_credit_grant', { grantId: 'cg_order', reason: 'refund' }))).toBe('billing_owned');
  });

  it('rejects an expiry in the past', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'user');
    const res = await callTool(t.env, actor, 'grant_credits', { userId: target.id, credits: 5, reason: 'promo', idempotencyKey: 'grant-past', expiresAt: Date.now() - 1000 });
    expect(errorCode(res)).toBe('invalid_request');
  });
});

describe('settings and opt-outs', () => {
  it('updates settings with a version check, an audit diff and a fresh cache', async () => {
    const actor = await owner();
    await t.cache.put('settings:v1', JSON.stringify({ announcement: 'stale' }));
    const before = ok(await callTool(t.env, actor, 'get_settings'));
    expect(before.version).toBe(1);
    const out = ok(await callTool(t.env, actor, 'update_settings', { patch: { announcement: 'Maintenance at 22:00' }, expectedVersion: 1 }));
    expect(out.version).toBe(2);
    expect(out.changed).toEqual(['announcement']);
    expect(t.cache.store.has('settings:v1')).toBe(false);
    expect((await getSettings(t.env)).announcement).toBe('Maintenance at 22:00');
    expect(JSON.parse(String(auditRows(t, 'settings.update')[0].meta)).diff).toEqual({ announcement: { from: null, to: 'Maintenance at 22:00' } });

    const stale = await callTool(t.env, actor, 'update_settings', { patch: { announcement: 'Other' }, expectedVersion: 1 });
    expect(errorCode(stale)).toBe('settings_conflict');
    expect(auditRows(t, 'settings.update')).toHaveLength(1);
    expect(errorCode(await callTool(t.env, actor, 'update_settings', { patch: { support_email: 'not-an-email' } }))).toBe('invalid_setting');
  });

  it('adds and removes site opt-outs with audit rows', async () => {
    const actor = await owner();
    const added = ok(await callTool(t.env, actor, 'add_site_optout', { domain: 'https://www.Example.com/path', reason: 'owner request' }));
    expect(added.existed).toBe(false);
    const list = ok(await callTool(t.env, actor, 'list_site_optouts', { search: 'example' }));
    expect(list.total).toBe(1);
    const domain = list.items[0].domain;
    ok(await callTool(t.env, actor, 'remove_site_optout', { domain }));
    expect(ok(await callTool(t.env, actor, 'list_site_optouts', {})).total).toBe(0);
    expect(auditRows(t, 'optout.add')).toHaveLength(1);
    expect(auditRows(t, 'optout.remove')).toHaveLength(1);
  });
});

describe('reads', () => {
  it('pages through users with a cursor', async () => {
    const actor = await owner();
    for (let i = 0; i < 5; i += 1) await seedUser(t, 'user');
    const first = ok(await callTool(t.env, actor, 'list_users', { limit: 2, role: 'user' }));
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = ok(await callTool(t.env, actor, 'list_users', { limit: 2, role: 'user', cursor: first.next_cursor }));
    const third = ok(await callTool(t.env, actor, 'list_users', { limit: 2, role: 'user', cursor: second.next_cursor }));
    const ids = [...first.items, ...second.items, ...third.items].map((u: { id: string }) => u.id);
    expect(new Set(ids).size).toBe(5);
    expect(third.next_cursor).toBeNull();
  });

  it('answers the overview, usage, audit and billing diagnostics without exposing secret values', async () => {
    const actor = await owner();
    const env = { ...t.env, POLAR_ACCESS_TOKEN: 'polar-token-value-for-test' } as typeof t.env;
    expect(ok(await callTool(env, actor, 'system_overview'))).toBeTruthy();
    expect(ok(await callTool(env, actor, 'list_system_usage', { days: 30 })).window.days).toBe(30);
    const tooWide = await callTool(env, actor, 'list_system_usage', { days: 31 });
    expect(tooWide.result.isError).toBe(true);
    expect(tooWide.result.content[0].text).toMatch('days');
    expect(ok(await callTool(env, actor, 'list_audit_events', { limit: 5 })).items).toEqual([]);
    const diag = await callTool(env, actor, 'get_billing_diagnostics');
    expect(ok(diag).secrets.POLAR_ACCESS_TOKEN).toBe(true);
    expect(JSON.stringify(diag.result)).not.toMatch('polar-token-value-for-test');
  });
});
