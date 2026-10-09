/**
 * Credentials: your own API keys and connected OAuth apps (`keys:manage`), and the credential
 * inventory and revocation of other users' access (`users:read`, `users:sessions:write`,
 * `users:credentials:write`). Secrets are returned once at creation and never stored or logged.
 */
import { z } from 'zod';
import { createApiKey, getUser, type ApiKeyRow, type UserRow } from '../../auth/identity';
import { expandScopes, isRole, KEY_PRESETS } from '../../auth/roles';
import type { Env, Principal } from '../../env';
import { now, safeJson } from '../../lib/util';
import { auditStatement, recordAudit } from './audit';
import { withIdempotency } from './idempotency';
import { AdminError, assertCanManage, assertScope, IdempotencyKey, parseInput, type Actor } from './shared';

export function keyView(k: ApiKeyRow) {
  return { id: k.id, name: k.name, prefix: k.prefix, scopes: safeJson<string[]>(k.scopes, []), created_at: k.created_at, last_used_at: k.last_used_at, expires_at: k.expires_at, revoked_at: k.revoked_at };
}

export interface GrantView {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: number;
}

/** OAuth grants of one user; empty when the OAuth store is unavailable (e.g. tests, misconfigured KV). */
export async function grantsOf(env: Env, userId: string): Promise<GrantView[]> {
  try {
    const { items } = await env.OAUTH_PROVIDER.listUserGrants(userId);
    return items.map((g) => ({
      id: g.id,
      clientId: g.clientId,
      clientName: String((g.metadata as { clientName?: string } | undefined)?.clientName ?? g.clientId),
      scopes: g.scope,
      createdAt: g.createdAt * (g.createdAt < 1e12 ? 1000 : 1),
    }));
  } catch {
    return [];
  }
}

// ─── Own credentials (keys:manage) ──────────────────────────────────────────

export async function activeKeyCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').bind(userId, now()).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Free accounts get 2 active keys; paid plans and staff are unlimited. */
export function keyLimit(plan: string, role: string): number {
  return plan === 'free' && !['owner', 'admin'].includes(role) ? 2 : Infinity;
}

export function scopesForPreset(preset: string | undefined, explicit: string[] | undefined): string[] | null {
  if (explicit?.length) return explicit;
  const p = KEY_PRESETS.find((k) => k.id === preset);
  return p ? p.scopes : null;
}

export async function listOwnKeys(env: Env, actor: Principal) {
  assertScope(actor, 'keys:manage');
  const { results } = await env.DB.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC LIMIT 200').bind(actor.userId).all<ApiKeyRow>();
  return { items: results.map(keyView), presets: KEY_PRESETS };
}

export const CreateKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  preset: z.string().max(40).optional(),
  scopes: z.array(z.string().max(40)).max(40).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

/**
 * Create a key for the acting user. It never gets scopes the creating credential lacks, and the
 * owner's current role caps it again on every use. Returns the secret exactly once.
 */
export async function createOwnKey(env: Env, actor: Principal, raw: unknown): Promise<{ key: string } & ReturnType<typeof keyView>> {
  assertScope(actor, 'keys:manage');
  // A key minted through an OAuth connection would outlive the grant (revoking the app would not
  // revoke the key), so connected apps never create keys; the user does, in the dashboard.
  if (actor.kind === 'oauth') {
    throw new AdminError('Connected apps cannot create API keys. Create keys in the dashboard (API keys page) instead.', 403, 'oauth_key_creation_forbidden');
  }
  const input = parseInput(CreateKeyInput, raw);
  const user = await getUser(env, actor.userId);
  if (!user) throw new AdminError('Account not found', 401, 'unauthorized');
  if ((await activeKeyCount(env, user.id)) >= keyLimit(user.plan, user.role)) throw new AdminError('Free accounts can have 2 active API keys. Revoke one or upgrade.', 403, 'key_limit');
  if (input.preset && !input.scopes?.length && !KEY_PRESETS.some((p) => p.id === input.preset)) throw new AdminError(`Unknown preset. Use one of: ${KEY_PRESETS.map((p) => p.id).join(', ')}`, 422, 'unknown_preset');
  // Legacy names (`users:write`) translate before filtering, as they do for stored keys.
  const requested = expandScopes(scopesForPreset(input.preset, input.scopes) ?? actor.scopes);
  const scopes = requested.filter((s) => actor.scopes.includes(s as never));
  if (!scopes.length) throw new AdminError('None of the requested scopes are available to this credential.', 422, 'no_scopes');
  const { key, row } = await createApiKey(env, user, { name: input.name, scopes, expiresInDays: input.expiresInDays });
  try {
    await recordAudit(env, actor, { action: 'api_key.create', targetType: 'api_key', target: row.id, meta: { owner: user.id, scopes: safeJson<string[]>(row.scopes, []), expires_at: row.expires_at } });
  } catch (err) {
    // Never leave an unaudited key whose secret the caller never saw.
    await env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').bind(now(), row.id).run();
    throw err;
  }
  return { key, ...keyView(row) };
}

export async function revokeOwnKey(env: Env, actor: Principal, keyId: string): Promise<{ revoked: boolean }> {
  assertScope(actor, 'keys:manage');
  const ts = now();
  const [res] = await env.DB.batch([
    env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(ts, keyId, actor.userId),
    auditStatement(env, actor, { action: 'api_key.revoke', targetType: 'api_key', target: keyId, meta: { owner: actor.userId } }, ts, { sql: 'EXISTS (SELECT 1 FROM api_keys WHERE id = ? AND revoked_at = ?)', binds: [keyId, ts] }),
  ]);
  if (!res.meta.changes) throw new AdminError('Key not found or already revoked', 404, 'not_found');
  return { revoked: true };
}

export async function listOwnGrants(env: Env, actor: Principal) {
  assertScope(actor, 'keys:manage');
  return { items: await grantsOf(env, actor.userId) };
}

export async function revokeOwnGrant(env: Env, actor: Principal, grantId: string): Promise<{ revoked: boolean }> {
  assertScope(actor, 'keys:manage');
  return revokeGrantOf(env, actor, actor.userId, grantId);
}

async function revokeGrantOf(env: Env, actor: Actor, userId: string, grantId: string): Promise<{ revoked: boolean }> {
  const grant = (await grantsOf(env, userId)).find((g) => g.id === grantId);
  if (!grant) throw new AdminError('OAuth grant not found for this user. List them with list_user_credentials or list_oauth_grants.', 404, 'not_found');
  await env.OAUTH_PROVIDER.revokeGrant(grantId, userId);
  await recordAudit(env, actor, { action: 'oauth_grant.revoke', targetType: 'oauth_grant', target: grantId, meta: { owner: userId, client: grant.clientName, scopes: grant.scopes } });
  return { revoked: true };
}

// ─── Other users' credentials ───────────────────────────────────────────────

async function managedUser(env: Env, actor: Actor, userId: string): Promise<UserRow> {
  const user = await getUser(env, userId);
  if (!user) throw new AdminError('User not found. Find ids with list_users.', 404, 'not_found');
  assertCanManage(actor, { id: user.id, role: isRole(user.role) ? user.role : 'user' });
  return user;
}

/** API keys (metadata only), active sessions (short handles, never tokens) and OAuth grants of a user. */
export async function listUserCredentials(env: Env, actor: Principal, userId: string) {
  assertScope(actor, 'users:read');
  const user = await getUser(env, userId);
  if (!user) throw new AdminError('User not found. Find ids with list_users.', 404, 'not_found');
  const [keys, sessions, grants] = await Promise.all([
    env.DB.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC LIMIT 100').bind(user.id).all<ApiKeyRow>(),
    env.DB.prepare('SELECT id, created_at, expires_at, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 50').bind(user.id, now()).all<{ id: string; created_at: number; expires_at: number; user_agent: string | null }>(),
    grantsOf(env, user.id),
  ]);
  return {
    user_id: user.id,
    api_keys: keys.results.map(keyView),
    // Session ids are SHA-256 hashes of the cookie; a 12-char prefix is enough to pick one to revoke.
    sessions: sessions.results.map((s) => ({ handle: s.id.slice(0, 12), created_at: s.created_at, expires_at: s.expires_at, user_agent: s.user_agent })),
    oauth_grants: grants,
  };
}

export const RevokeSessionsInput = z.object({
  userId: z.string().min(1).max(80),
  sessionHandle: z.string().min(8).max(64).optional().describe('One session handle from list_user_credentials; omit to sign out every session'),
  idempotencyKey: IdempotencyKey.optional(),
});

export async function revokeUserSessions(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'users:sessions:write');
  const input = parseInput(RevokeSessionsInput, raw);
  return withIdempotency(env, actor, 'user.sessions.revoke', input.idempotencyKey, { userId: input.userId, sessionHandle: input.sessionHandle ?? null }, async () => {
    const user = await managedUser(env, actor, input.userId);
    const match = input.sessionHandle ? "user_id = ? AND id LIKE ? ESCAPE '\\'" : 'user_id = ?';
    const matchBinds = input.sessionHandle ? [user.id, `${input.sessionHandle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`] : [user.id];
    const sameRole = { sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ?)', binds: [user.id, user.role] };
    const count = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${match}`).bind(...matchBinds).first<number>('n')) ?? 0;
    if (!count) return { userId: user.id, revoked: 0 };
    // The audit row and the delete commit together, and neither applies if the role changed after the rank check.
    const [, del] = await env.DB.batch([
      auditStatement(env, actor, { action: 'user.sessions.revoke', targetType: 'user', target: user.id, diff: { sessions_revoked: count }, meta: { session: input.sessionHandle ?? 'all' }, idempotencyKey: input.idempotencyKey }, now(), {
        sql: `EXISTS (SELECT 1 FROM sessions WHERE ${match}) AND ${sameRole.sql}`,
        binds: [...matchBinds, ...sameRole.binds],
      }),
      env.DB.prepare(`DELETE FROM sessions WHERE ${match} AND ${sameRole.sql}`).bind(...matchBinds, ...sameRole.binds),
    ]);
    const revoked = del.meta.changes ?? 0;
    if (!revoked) await managedUser(env, actor, input.userId);
    return { userId: user.id, revoked };
  });
}

export const RevokeUserKeyInput = z.object({ userId: z.string().min(1).max(80), keyId: z.string().min(1).max(80), idempotencyKey: IdempotencyKey.optional() });

/** Revoke another user's API key. Repeating it is safe: an already revoked key reports `alreadyRevoked`. */
export async function revokeUserApiKey(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'users:credentials:write');
  const input = parseInput(RevokeUserKeyInput, raw);
  const user = await managedUser(env, actor, input.userId);
  const key = await env.DB.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').bind(input.keyId, user.id).first<ApiKeyRow>();
  if (!key) throw new AdminError('API key not found for this user.', 404, 'not_found');
  if (key.revoked_at) return { keyId: key.id, revoked: false, alreadyRevoked: true };
  const ts = now();
  const [res] = await env.DB.batch([
    env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ?)').bind(ts, key.id, user.id, user.role),
    auditStatement(env, actor, { action: 'api_key.revoke', targetType: 'api_key', target: key.id, meta: { owner: user.id, name: key.name }, idempotencyKey: input.idempotencyKey }, ts, { sql: 'EXISTS (SELECT 1 FROM api_keys WHERE id = ? AND revoked_at = ?)', binds: [key.id, ts] }),
  ]);
  if (!res.meta.changes) {
    // Either revoked meanwhile or the owner's role changed after the rank check: re-check before reporting.
    await managedUser(env, actor, input.userId);
    const fresh = await env.DB.prepare('SELECT revoked_at FROM api_keys WHERE id = ?').bind(key.id).first<{ revoked_at: number | null }>();
    if (!fresh?.revoked_at) throw new AdminError('The account changed meanwhile. Re-read and retry.', 409, 'role_conflict');
  }
  return { keyId: key.id, revoked: Boolean(res.meta.changes), alreadyRevoked: !res.meta.changes };
}

export const RevokeUserGrantInput = z.object({ userId: z.string().min(1).max(80), grantId: z.string().min(1).max(200) });

export async function revokeUserOAuthGrant(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'users:credentials:write');
  const input = parseInput(RevokeUserGrantInput, raw);
  const user = await managedUser(env, actor, input.userId);
  return revokeGrantOf(env, actor, user.id, input.grantId);
}
