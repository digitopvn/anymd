import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { principalFromApiKey } from '../src/auth/identity';
import { capScopes, OAUTH_GRANT_VERSION, oauthPrincipalScopes, ROLE_TEMPLATES, scopesForRole } from '../src/auth/roles';
import type { Principal, RoleName } from '../src/env';
import { MCP_TOOL_CATALOG } from '../src/mcp/server';
import { callTool, rpc, toolNames } from './helpers/mcp-client';
import { createTestEnv, seedKey, seedUser, sessionOf, type TestEnv } from './helpers/sqlite-env';

const ROLES = Object.keys(ROLE_TEMPLATES) as RoleName[];
const ADMIN_TOOL_NAMES = [
  'system_overview', 'list_users', 'get_user', 'list_roles', 'list_user_credentials', 'list_audit_events', 'list_system_usage', 'list_system_traces',
  'get_system_trace', 'list_subscriptions', 'get_subscription', 'get_billing_diagnostics', 'list_credit_grants', 'list_site_optouts', 'get_settings',
  'update_user_role', 'set_user_status', 'revoke_user_sessions', 'revoke_user_api_key', 'revoke_oauth_grant', 'grant_credits', 'revoke_credit_grant',
  'add_site_optout', 'remove_site_optout', 'update_settings',
];
const OWNER_ONLY_TOOLS = ['update_user_role', 'grant_credits', 'revoke_credit_grant'];

let t: TestEnv;
beforeEach(() => {
  t = createTestEnv();
});
afterEach(() => t.close());

const principal = (role: RoleName, kind: Principal['kind'], scopes: Principal['scopes'], extra: Partial<Principal> = {}): Principal => ({ kind, userId: `u-${role}`, role, scopes, ...extra });

describe('tool catalog', () => {
  it('declares every annotation explicitly on every tool', () => {
    for (const tool of MCP_TOOL_CATALOG) {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        expect(typeof tool.annotations[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
    }
  });

  it('includes every admin tool, and marks the irreversible or access-removing ones destructive', () => {
    const names = MCP_TOOL_CATALOG.map((x) => x.name);
    for (const n of ADMIN_TOOL_NAMES) expect(names).toEqual(expect.arrayContaining([n]));
    expect(new Set(names).size).toBe(names.length);
    const destructive = ['set_user_status', 'revoke_user_sessions', 'revoke_user_api_key', 'revoke_oauth_grant', 'revoke_credit_grant', 'remove_site_optout', 'update_settings', 'delete_post', 'archive_page', 'revoke_api_key'];
    for (const n of destructive) expect(MCP_TOOL_CATALOG.find((x) => x.name === n)?.annotations.destructiveHint, n).toBe(true);
    for (const n of ['read_url', 'convert_url']) expect(MCP_TOOL_CATALOG.find((x) => x.name === n)?.annotations.openWorldHint).toBe(true);
    for (const tool of MCP_TOOL_CATALOG.filter((x) => x.name.startsWith('list_') || x.name.startsWith('get_'))) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
    }
  });
});

describe('tool visibility matrix', () => {
  it('shows admin tools only to admins and owners, and owner-only tools only to owners (session)', async () => {
    for (const role of ROLES) {
      const names = await toolNames(t.env, principal(role, 'session', scopesForRole(role)));
      const admin = names.filter((n) => ADMIN_TOOL_NAMES.includes(n));
      if (role === 'owner') expect(admin.sort()).toEqual([...ADMIN_TOOL_NAMES].sort());
      else if (role === 'admin') expect(admin.sort()).toEqual(ADMIN_TOOL_NAMES.filter((n) => !OWNER_ONLY_TOOLS.includes(n)).sort());
      else expect(admin, role).toEqual([]);
      expect(names, role).toEqual(expect.arrayContaining(['read_url']));
    }
  });

  it('narrows to the scopes of a down-scoped API key', async () => {
    for (const role of ROLES) {
      const scopes = capScopes(role, ['convert', 'users:read']);
      const names = await toolNames(t.env, principal(role, 'api_key', scopes, { apiKeyId: 'key_x' }));
      const expected = role === 'owner' || role === 'admin' ? ['get_user', 'list_roles', 'list_user_credentials', 'list_users'] : [];
      expect(names.filter((n) => ADMIN_TOOL_NAMES.includes(n)).sort(), role).toEqual(expected);
      expect(names).not.toEqual(expect.arrayContaining(['update_settings']));
      expect(names).not.toEqual(expect.arrayContaining(['list_documents']));
    }
  });

  it('narrows to the scopes of a down-scoped OAuth grant and hides admin tools from legacy grants', async () => {
    for (const role of ROLES) {
      const modern = oauthPrincipalScopes(role, ['convert', 'library:read', 'audit:read'], OAUTH_GRANT_VERSION);
      const names = await toolNames(t.env, principal(role, 'oauth', modern, { clientId: 'client_x' }));
      expect(names.includes('list_audit_events'), role).toBe(role === 'owner' || role === 'admin');
      const legacy = oauthPrincipalScopes(role, scopesForRole(role), undefined);
      const legacyNames = await toolNames(t.env, principal(role, 'oauth', legacy, { clientId: 'client_x' }));
      expect(legacyNames.filter((n) => ADMIN_TOOL_NAMES.includes(n)), role).toEqual([]);
    }
  });
});

describe('MCP authorization', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await rpc(t.env, { kind: 'anonymous', userId: null, role: 'user', scopes: ['convert'] }, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(-32001);
  });

  it('stops revoked, expired and suspended-owner keys, and caps a demoted owner key', async () => {
    const admin = await seedUser(t, 'admin');
    const { key, row } = await seedKey(t, admin, ['users:read', 'audit:read', 'convert']);
    const p = await principalFromApiKey(t.env, key);
    expect(p?.scopes).toEqual(expect.arrayContaining(['users:read', 'audit:read']));

    t.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(admin.id);
    const demoted = await principalFromApiKey(t.env, key);
    expect(demoted?.scopes).toEqual(['convert']);
    expect(await toolNames(t.env, demoted!)).not.toEqual(expect.arrayContaining(['list_users']));

    t.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(admin.id);
    expect(await principalFromApiKey(t.env, key)).toBeNull();
    t.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(admin.id);

    t.db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, row.id);
    expect(await principalFromApiKey(t.env, key)).toBeNull();
    t.db.prepare('UPDATE api_keys SET expires_at = NULL, revoked_at = ? WHERE id = ?').run(Date.now(), row.id);
    expect(await principalFromApiKey(t.env, key)).toBeNull();
  });

  it('asks an OAuth client to step up when its role allows the missing scope', async () => {
    const admin = await seedUser(t, 'admin');
    const p: Principal = { kind: 'oauth', userId: admin.id, role: 'admin', scopes: ['convert', 'library:read'], clientId: 'client_a' };
    const res = await callTool(t.env, p, 'list_audit_events');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(-32003);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch('error="insufficient_scope"');
    expect(challenge).toMatch('scope="convert library:read audit:read"');
    expect(challenge).toMatch('resource_metadata="https://anymd.test/.well-known/oauth-protected-resource/mcp"');
  });

  it('returns a structured insufficient_scope tool error for an API key, and forbidden when the role lacks it', async () => {
    const admin = await seedUser(t, 'admin');
    const keyPrincipal: Principal = { kind: 'api_key', userId: admin.id, role: 'admin', scopes: ['convert'], apiKeyId: 'key_a' };
    const missing = await callTool(t.env, keyPrincipal, 'list_users');
    expect(missing.status).toBe(200);
    expect(missing.result.isError).toBe(true);
    expect(missing.result.structuredContent.error.code).toBe('insufficient_scope');
    expect(missing.result.structuredContent.error.required).toEqual(['users:read']);

    const ownerOnly = await callTool(t.env, sessionOf(admin, scopesForRole('admin')), 'grant_credits', { userId: 'x', credits: 1, reason: 'test', idempotencyKey: 'k-1' });
    expect(ownerOnly.result.structuredContent.error.code).toBe('forbidden');
    const oauthOwnerOnly = await callTool(t.env, { ...keyPrincipal, kind: 'oauth', clientId: 'c', apiKeyId: undefined }, 'update_user_role', { userId: 'x', role: 'user' });
    expect(oauthOwnerOnly.status).toBe(200);
    expect(oauthOwnerOnly.result.structuredContent.error.code).toBe('forbidden');
  });

  it('enforces rank and self rules inside admin mutations', async () => {
    const admin = await seedUser(t, 'admin');
    const peer = await seedUser(t, 'admin');
    const owner = await seedUser(t, 'owner');
    const p = sessionOf(admin, scopesForRole('admin'));
    const onPeer = await callTool(t.env, p, 'revoke_user_sessions', { userId: peer.id });
    expect(onPeer.result.structuredContent.error.code).toBe('forbidden_rank');
    const onOwner = await callTool(t.env, p, 'set_user_status', { userId: owner.id, status: 'suspended', reason: 'nope' });
    expect(onOwner.result.structuredContent.error.code).toBe('forbidden_rank');
    const onSelf = await callTool(t.env, sessionOf(owner, scopesForRole('owner')), 'update_user_role', { userId: owner.id, role: 'user' });
    expect(onSelf.result.structuredContent.error.code).toBe('forbidden_self');
  });
});
