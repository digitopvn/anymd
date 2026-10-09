/**
 * Users and roles. Roles are authorization only: plans follow the billing provider and support
 * allowances are credit grants, so neither is editable here.
 */
import { z } from 'zod';
import { getUser, type UserRow, type UserStatus } from '../../auth/identity';
import { isRole, KEY_PRESETS, ROLE_TEMPLATES, SCOPE_LABELS } from '../../auth/roles';
import { PLANS } from '../../billing/plans';
import type { Env, Principal, RoleName } from '../../env';
import { quotaState } from '../../lib/usage';
import { now } from '../../lib/util';
import { auditStatement, recentAuditFor, type AuditInput } from './audit';
import { withIdempotency } from './idempotency';
import {
  AdminError,
  assertCanManage,
  assertScope,
  clampLimit,
  cursorClause,
  decodeCursor,
  IdempotencyKey,
  likePattern,
  page,
  parseInput,
  Timestamp,
  type Actor,
  type Paged,
} from './shared';

const ROLES = Object.keys(ROLE_TEMPLATES) as [RoleName, ...RoleName[]];

export function userSummary(u: Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'plan' | 'status' | 'created_at' | 'last_login_at'>) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, plan: u.plan, status: u.status ?? 'active', created_at: u.created_at, last_login_at: u.last_login_at };
}
export type UserSummary = ReturnType<typeof userSummary>;

export const UserQuery = z.object({
  search: z.string().max(200).optional().describe('Email, name or exact user id'),
  role: z.enum(ROLES).optional(),
  plan: z.string().max(40).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  createdAfter: Timestamp.optional(),
  createdBefore: Timestamp.optional(),
  lastLoginAfter: Timestamp.optional(),
  lastLoginBefore: Timestamp.optional(),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/** Cursor-paginated user list, newest first, with filters. Needs `users:read`. */
export async function listUsers(env: Env, actor: Principal, raw: unknown): Promise<Paged<UserSummary>> {
  assertScope(actor, 'users:read');
  const q = parseInput(UserQuery, raw);
  const limit = clampLimit(q.limit, 25, 100);
  const parts: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => (parts.push(sql), binds.push(...v));
  const term = q.search?.trim();
  if (term) add("(id = ? OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')", term, likePattern(term.toLowerCase()), likePattern(term));
  if (q.role) add('role = ?', q.role);
  if (q.plan) add('plan = ?', q.plan);
  if (q.status) add('status = ?', q.status);
  if (q.createdAfter) add('created_at >= ?', q.createdAfter);
  if (q.createdBefore) add('created_at < ?', q.createdBefore);
  if (q.lastLoginAfter) add('last_login_at >= ?', q.lastLoginAfter);
  if (q.lastLoginBefore) add('last_login_at < ?', q.lastLoginBefore);
  const c = cursorClause(decodeCursor(q.cursor));
  if (c.sql) add(c.sql, ...c.binds);
  const { results } = await env.DB.prepare(
    `SELECT id,email,name,role,plan,status,created_at,last_login_at FROM users ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<UserSummary>();
  const paged = page(results, limit);
  return { items: paged.items.map(userSummary), next_cursor: paged.next_cursor };
}

async function userOr404(env: Env, id: string): Promise<UserRow> {
  const user = await getUser(env, id);
  if (!user) throw new AdminError('User not found. Find ids with list_users.', 404, 'not_found');
  return user;
}

/** One user with bounded support context: credentials, quota, subscription, grants, recent audit. */
export async function getUserDetail(env: Env, actor: Principal, userId: string) {
  assertScope(actor, 'users:read');
  const user = await userOr404(env, userId);
  const ts = now();
  const [quota, keys, sessions, docs, subscription, grants, recent] = await Promise.all([
    quotaState(env, user.id, user.plan),
    env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').bind(user.id, ts).first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').bind(user.id, ts).first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?').bind(user.id).first<{ n: number }>(),
    env.DB.prepare('SELECT id,plan,status,billing_interval,current_period_end,cancel_at_period_end FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').bind(user.id).first(),
    env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(credits),0) AS credits FROM credit_grants WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').bind(user.id, ts).first<{ n: number; credits: number }>(),
    actor.scopes.includes('audit:read') ? recentAuditFor(env, user.id, 5) : Promise.resolve(null),
  ]);
  return {
    user: { ...userSummary(user), status_reason: user.status_reason || null, updated_at: user.updated_at },
    quota,
    credentials: { active_api_keys: keys?.n ?? 0, active_sessions: sessions?.n ?? 0 },
    library: { documents: docs?.n ?? 0 },
    subscription: subscription ?? null,
    credit_grants: { active: grants?.n ?? 0, credits: grants?.credits ?? 0 },
    ...(recent ? { recent_audit: recent } : {}),
  };
}

/** Role templates, scope meanings, key presets and plans (plans are informational: billing owns them). */
export function listRoles() {
  return {
    roles: ROLE_TEMPLATES,
    scopes: SCOPE_LABELS,
    presets: KEY_PRESETS,
    plans: PLANS.map((p) => ({ id: p.id, name: p.name, credits: p.credits })),
    notes: 'Roles grant scopes. Plans come from the billing provider and are not editable by admins; use credit grants for support allowances.',
  };
}

export const UpdateRoleInput = z.object({
  userId: z.string().min(1).max(80),
  role: z.enum(ROLES),
  expectedRole: z.enum(ROLES).optional().describe('Current role you read; the change fails with role_conflict if it changed meanwhile'),
  idempotencyKey: IdempotencyKey.optional(),
});

/**
 * Change a user's role. Owner-only by template (`users:roles:write`); never on yourself; anyone
 * but the owner only below their own rank. Guarded by `expectedRole` (or the role just read).
 */
export async function updateUserRole(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'users:roles:write');
  const input = parseInput(UpdateRoleInput, raw);
  return withIdempotency(env, actor, 'user.role', input.idempotencyKey, { userId: input.userId, role: input.role, expectedRole: input.expectedRole }, async () => {
    const target = await userOr404(env, input.userId);
    const current = isRole(target.role) ? target.role : 'user';
    assertCanManage(actor, { id: target.id, role: current }, input.role);
    const expected = input.expectedRole ?? current;
    if (expected !== current) throw new AdminError(`Role conflict: the user is now ${current}, not ${expected}. Re-read with get_user and retry.`, 409, 'role_conflict', { currentRole: current });
    if (input.role === current) return { user: userSummary(target), changed: false, previousRole: current };
    const ts = now();
    // The role guard makes the write atomic against a concurrent change; the audit row only lands with it.
    const [res] = await env.DB.batch([
      env.DB.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ? AND role = ?').bind(input.role, ts, target.id, current),
      auditGuarded(env, actor, { action: 'user.role.update', targetType: 'user', target: target.id, diff: { role: { from: current, to: input.role } }, idempotencyKey: input.idempotencyKey }, ts, target.id, 'role', input.role),
    ]);
    if (!res.meta.changes) {
      const fresh = await userOr404(env, target.id);
      throw new AdminError(`Role conflict: the user is now ${fresh.role}. Re-read and retry.`, 409, 'role_conflict', { currentRole: fresh.role });
    }
    return { user: userSummary({ ...target, role: input.role }), changed: true, previousRole: current };
  });
}

/** Audit only when the guarded UPDATE in the same batch won: the row carries the new value and this write's timestamp. */
function auditGuarded(env: Env, actor: Actor, input: AuditInput, ts: number, userId: string, column: 'role' | 'status', value: string) {
  return auditStatement(env, actor, input, ts, { sql: `EXISTS (SELECT 1 FROM users WHERE id = ? AND ${column} = ? AND updated_at = ?)`, binds: [userId, value, ts] });
}

export const SetStatusInput = z.object({
  userId: z.string().min(1).max(80),
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(3).max(300),
  expectedStatus: z.enum(['active', 'suspended']).optional(),
  idempotencyKey: IdempotencyKey.optional(),
});

/** Suspend (signs the user out; keys and OAuth grants stop working) or reactivate an account. Reversible. */
export async function setUserStatus(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'users:sessions:write');
  const input = parseInput(SetStatusInput, raw);
  return withIdempotency(env, actor, 'user.status', input.idempotencyKey, { userId: input.userId, status: input.status, reason: input.reason, expectedStatus: input.expectedStatus }, async () => {
    const target = await userOr404(env, input.userId);
    const role = isRole(target.role) ? target.role : 'user';
    assertCanManage(actor, { id: target.id, role });
    const current: UserStatus = target.status === 'suspended' ? 'suspended' : 'active';
    const expected = input.expectedStatus ?? current;
    if (expected !== current) throw new AdminError(`Status conflict: the account is ${current}. Re-read and retry.`, 409, 'status_conflict', { currentStatus: current });
    if (input.status === current) return { user: userSummary(target), changed: false, sessionsRevoked: 0 };
    const ts = now();
    const stmts = [
      env.DB.prepare('UPDATE users SET status = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status = ? AND role = ?').bind(input.status, input.status === 'suspended' ? input.reason : '', ts, target.id, current, role),
      auditGuarded(env, actor, { action: input.status === 'suspended' ? 'user.suspend' : 'user.reactivate', targetType: 'user', target: target.id, diff: { status: { from: current, to: input.status } }, meta: { reason: input.reason }, idempotencyKey: input.idempotencyKey }, ts, target.id, 'status', input.status),
    ];
    if (input.status === 'suspended') stmts.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'suspended' AND updated_at = ?)").bind(target.id, target.id, ts));
    const [res, , del] = await env.DB.batch(stmts);
    if (!res.meta.changes) throw new AdminError('Status conflict: the account status or role changed meanwhile. Re-read and retry.', 409, 'status_conflict');
    return { user: userSummary({ ...target, status: input.status }), changed: true, sessionsRevoked: del?.meta.changes ?? 0 };
  });
}
