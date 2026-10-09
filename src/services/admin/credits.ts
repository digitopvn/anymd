/**
 * Credit grants: support allowances on top of a plan. An active grant (not revoked, not expired)
 * raises the user's monthly allowance by its credits in every month it is active. Grants default to
 * expiring at the end of the current month (UTC), or of the next month when fewer than
 * MIN_DEFAULT_GRANT_DAYS remain (so a grant made on the last day still lasts a week or more); only
 * `recurring: true` grants may run longer or forever. Granting and
 * revoking need `credits:write` (owner only by template) and are always audited; grants carry a
 * reason, the granting admin and a required idempotency key, so a retried grant never doubles up.
 */
import { z } from 'zod';
import { getUser } from '../../auth/identity';
import type { Env, Principal } from '../../env';
import { newId, now } from '../../lib/util';
import { monthStart } from '../../lib/usage';

/** The first instant of the next calendar month (UTC): the end of `ts`'s month. */
export function nextMonthStart(ts: number): number {
  const d = new Date(monthStart(ts));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** A default grant lasts at least this many days. */
export const MIN_DEFAULT_GRANT_DAYS = 7;

/** The default expiry of a grant made at `ts`: the end of its month, or of the next month when that is under a week away. */
export function defaultGrantExpiry(ts: number): number {
  const end = nextMonthStart(ts);
  return end - ts < MIN_DEFAULT_GRANT_DAYS * 86_400_000 ? nextMonthStart(end) : end;
}
import { auditStatement } from './audit';
import { AdminError, assertCanManage, assertScope, clampLimit, cursorClause, decodeCursor, IdempotencyKey, iso, page, parseInput, Timestamp, type Paged } from './shared';
import { isRole } from '../../auth/roles';

interface GrantRow {
  id: string;
  user_id: string;
  source: string;
  reference: string | null;
  credits: number;
  created_at: number;
  expires_at: number | null;
  reason: string;
  created_by: string | null;
  idempotency_key: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
  revoke_reason: string;
}

function grantState(g: GrantRow, ts = now()): 'active' | 'expired' | 'revoked' {
  if (g.revoked_at) return 'revoked';
  return g.expires_at && g.expires_at <= ts ? 'expired' : 'active';
}

export function grantView(g: GrantRow) {
  return {
    id: g.id,
    user_id: g.user_id,
    credits: g.credits,
    source: g.source,
    reference: g.reference,
    reason: g.reason,
    state: grantState(g),
    created_at: g.created_at,
    created_by: g.created_by,
    expires_at: g.expires_at,
    expires: iso(g.expires_at),
    revoked_at: g.revoked_at,
    revoked_by: g.revoked_by,
    revoke_reason: g.revoke_reason || null,
  };
}
export type CreditGrantView = ReturnType<typeof grantView>;

export const GrantQuery = z.object({
  userId: z.string().max(80).optional(),
  state: z.enum(['active', 'expired', 'revoked', 'all']).optional().describe('Default all'),
  source: z.enum(['admin', 'promo', 'polar_order']).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export async function listCreditGrants(env: Env, actor: Principal, raw: unknown): Promise<Paged<CreditGrantView>> {
  assertScope(actor, 'credits:read');
  const q = parseInput(GrantQuery, raw);
  const limit = clampLimit(q.limit, 25, 100);
  const ts = now();
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (q.userId) parts.push('user_id = ?'), binds.push(q.userId);
  if (q.source) parts.push('source = ?'), binds.push(q.source);
  if (q.state === 'active') parts.push('revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)'), binds.push(ts);
  if (q.state === 'expired') parts.push('revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?'), binds.push(ts);
  if (q.state === 'revoked') parts.push('revoked_at IS NOT NULL');
  const c = cursorClause(decodeCursor(q.cursor));
  if (c.sql) parts.push(c.sql), binds.push(...c.binds);
  const { results } = await env.DB.prepare(`SELECT * FROM credit_grants ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<GrantRow>();
  const paged = page(results, limit);
  return { items: paged.items.map(grantView), next_cursor: paged.next_cursor };
}

export const GrantCreditsInput = z.object({
  userId: z.string().min(1).max(80),
  credits: z.number().int().min(1).max(1_000_000),
  reason: z.string().trim().min(3).max(300).describe('Why the credits are granted; shown in the audit log'),
  source: z.enum(['admin', 'promo']).optional().describe('Default admin'),
  expiresAt: Timestamp.optional().describe('When the grant stops counting. Default: the end of this month (UTC), or of next month when fewer than 7 days remain. Later than the default needs recurring: true'),
  recurring: z.boolean().optional().describe('true: the credits are added again every month until expiresAt (or forever when it is omitted)'),
  idempotencyKey: IdempotencyKey.describe('Required: retrying with the same key returns the original grant'),
});

/** Grant credits to a user. Retrying with the same idempotency key returns the original grant (`replayed: true`). */
export async function grantCredits(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'credits:write');
  const input = parseInput(GrantCreditsInput, raw);
  const source = input.source ?? 'admin';
  const ts = now();
  if (input.expiresAt !== undefined && input.expiresAt <= ts) throw new AdminError('expiresAt must be in the future.', 422, 'invalid_request');
  const defaultExpiry = defaultGrantExpiry(ts);
  if (!input.recurring && input.expiresAt !== undefined && input.expiresAt > defaultExpiry) {
    throw new AdminError(`A grant adds its credits again in every month it is active. Pass recurring: true to confirm, or an expiresAt no later than ${new Date(defaultExpiry).toISOString()}.`, 422, 'invalid_request');
  }
  const expiresAt = input.expiresAt ?? (input.recurring ? null : defaultExpiry);
  const user = await getUser(env, input.userId);
  if (!user) throw new AdminError('User not found. Find ids with list_users.', 404, 'not_found');
  assertCanManage(actor, { id: user.id, role: isRole(user.role) ? user.role : 'user' });

  const findPrior = () => env.DB.prepare('SELECT * FROM credit_grants WHERE user_id = ? AND idempotency_key = ?').bind(user.id, input.idempotencyKey).first<GrantRow>();
  const replay = (prior: GrantRow) => {
    // A defaulted expiry depends on the month of the first request, so a replay compares the explicit fields only.
    const sameExpiry = input.expiresAt !== undefined ? prior.expires_at === input.expiresAt : input.recurring ? prior.expires_at === null : prior.expires_at !== null;
    const same = prior.credits === input.credits && prior.reason === input.reason && prior.source === source && sameExpiry;
    if (!same) throw new AdminError('idempotencyKey was already used for a different grant to this user. Use a new key for a new grant.', 422, 'idempotency_mismatch', { grantId: prior.id });
    return { grant: grantView(prior), replayed: true };
  };
  const prior = await findPrior();
  if (prior) return replay(prior);

  const id = newId('cg_');
  // INSERT OR IGNORE + the unique (user_id, idempotency_key) index makes a concurrent duplicate a no-op;
  // the audit row is only written when this insert created the grant.
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO credit_grants (id,user_id,source,reference,credits,created_at,expires_at,reason,created_by,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
      id,
      user.id,
      source,
      null,
      input.credits,
      ts,
      expiresAt,
      input.reason,
      actor.userId,
      input.idempotencyKey,
    ),
    auditStatement(
      env,
      actor,
      { action: 'credits.grant', targetType: 'user', target: user.id, diff: { credits: input.credits }, meta: { grant: id, source, reason: input.reason, expires_at: input.expiresAt ?? null }, idempotencyKey: input.idempotencyKey },
      ts,
      { sql: 'EXISTS (SELECT 1 FROM credit_grants WHERE id = ?)', binds: [id] },
    ),
  ]);
  const row = await env.DB.prepare('SELECT * FROM credit_grants WHERE id = ?').bind(id).first<GrantRow>();
  if (!row) {
    const winner = await findPrior();
    if (winner) return replay(winner);
    throw new AdminError('Could not record the grant. Retry with the same idempotencyKey.', 500, 'internal');
  }
  return { grant: grantView(row), replayed: false };
}

export const RevokeGrantInput = z.object({
  grantId: z.string().min(1).max(80),
  reason: z.string().trim().min(3).max(300),
});

/** Revoke an admin or promo grant. Billing-issued grants belong to the billing provider. Repeating is safe. */
export async function revokeCreditGrant(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'credits:write');
  const input = parseInput(RevokeGrantInput, raw);
  const grant = await env.DB.prepare('SELECT * FROM credit_grants WHERE id = ?').bind(input.grantId).first<GrantRow>();
  if (!grant) throw new AdminError('Credit grant not found. List them with list_credit_grants.', 404, 'not_found');
  if (grant.source === 'polar_order') throw new AdminError('This grant comes from a billing order; refund or adjust it in the billing provider.', 409, 'billing_owned');
  const user = await getUser(env, grant.user_id);
  if (user) assertCanManage(actor, { id: user.id, role: isRole(user.role) ? user.role : 'user' });
  if (grant.revoked_at) return { grant: grantView(grant), changed: false, alreadyRevoked: true };
  const ts = now();
  const [res] = await env.DB.batch([
    env.DB.prepare('UPDATE credit_grants SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL').bind(ts, actor.userId, input.reason, grant.id),
    auditStatement(env, actor, { action: 'credits.revoke', targetType: 'user', target: grant.user_id, diff: { credits: -grant.credits }, meta: { grant: grant.id, reason: input.reason, state_before: grantState(grant, ts) } }, ts, {
      sql: 'EXISTS (SELECT 1 FROM credit_grants WHERE id = ? AND revoked_at = ? AND revoked_by = ?)',
      binds: [grant.id, ts, actor.userId],
    }),
  ]);
  const fresh = (await env.DB.prepare('SELECT * FROM credit_grants WHERE id = ?').bind(grant.id).first<GrantRow>()) ?? grant;
  return { grant: grantView(fresh), changed: Boolean(res.meta.changes), alreadyRevoked: !res.meta.changes };
}
