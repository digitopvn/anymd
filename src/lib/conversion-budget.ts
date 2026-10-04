import type { Env } from '../env';
import { ConvertError } from '../convert/types';
import { extraCredits, monthStart, quotaState } from './usage';
import { getPlan } from '../billing/plans';

/** Usage rows represented by a charge are excluded to avoid counting settlement twice. */
export const UNRESERVED_USAGE_SQL = `SELECT COALESCE(SUM(u.credits),0) FROM usage_events u
 WHERE u.user_id = ? AND u.created_at >= ?
 AND NOT EXISTS (SELECT 1 FROM conversion_charges c WHERE c.id = u.trace_id)`;
export const CHARGES_SQL = `SELECT COALESCE(SUM(CASE WHEN settled = 1 THEN credits WHEN expires_at > ? THEN reserved ELSE 0 END),0)
 FROM conversion_charges WHERE user_id = ? AND created_at >= ?`;

export async function reserveConversion(env: Env, id: string, userId: string, planId: string, requested: number): Promise<number> {
  const state = await quotaState(env, userId, planId);
  const reserved = state.overage ? requested : Math.min(requested, state.remaining);
  if (reserved < 1) throw new ConvertError('Monthly credits used up', 402, 'quota_exceeded');
  const ts = Date.now();
  const limit = getPlan(planId).credits + await extraCredits(env, userId);
  // A single SQLite statement rechecks the allowance atomically against competing reservations.
  const out = await env.DB.prepare(`INSERT INTO conversion_charges (id,user_id,reserved,created_at,expires_at)
    SELECT ?,?,?,?,? WHERE ? = 1 OR ? - (${UNRESERVED_USAGE_SQL}) - (${CHARGES_SQL}) >= ?`)
    .bind(id, userId, reserved, ts, ts + 300_000, state.overage ? 1 : 0, limit,
      userId, monthStart(ts), ts, userId, monthStart(ts), reserved).run();
  if (!out.meta.changes) throw new ConvertError('Credits are reserved by another conversion. Try again shortly.', 402, 'quota_exceeded');
  return reserved;
}

export async function settleConversion(env: Env, id: string, credits: number): Promise<void> {
  const out = await env.DB.prepare('UPDATE conversion_charges SET credits = ?, settled = 1 WHERE id = ? AND settled = 0 AND reserved >= ?')
    .bind(credits, id, credits).run();
  if (!out.meta.changes) throw new ConvertError('Could not settle conversion credits', 503, 'billing_unavailable');
}
