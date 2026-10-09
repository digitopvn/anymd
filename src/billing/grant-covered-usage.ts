/**
 * How credit grants interact with metered overage. Within a calendar month credits are consumed in
 * this order: the plan's included credits, then active credit grants, then paid overage. The
 * billing meter already knows the included credits (its own benefit covers them), but not anymd's
 * grants, so the units a grant covers must never reach the meter or the grant would be billed.
 */
import type { Env } from '../env';
import { CHARGES_SQL, UNRESERVED_USAGE_SQL } from '../lib/conversion-budget';
import { creditsUsedThisMonth, monthStart } from '../lib/usage';

export interface MeterWindow {
  /** Credits the account had used this month before this conversion. */
  usedBefore: number;
  /** Credits this conversion spent. */
  credits: number;
  /** The plan's included monthly credits. */
  included: number;
  /** Active granted credits this month. */
  granted: number;
}

/**
 * Units of one conversion to report to the meter: all of them except those falling in the grant
 * band `[included, included + granted)`. A conversion may straddle either boundary, so this is the
 * conversion's range minus its overlap with the band.
 */
export function meteredUnits({ usedBefore, credits, included, granted }: MeterWindow): number {
  const spent = Math.max(0, Math.floor(credits));
  if (!spent) return 0;
  const start = Math.max(0, Math.floor(usedBefore));
  const end = start + spent;
  const bandStart = Math.max(0, Math.floor(included));
  const bandEnd = bandStart + Math.max(0, Math.floor(granted));
  const covered = Math.max(0, Math.min(end, bandEnd) - Math.max(start, bandStart));
  return spent - covered;
}

/**
 * Credits the account used this month before the conversion behind `chargeId`, ordered by the
 * charge's (created_at, id), so concurrent conversions each see a consistent position. Without a
 * charge (nothing was reserved) it falls back to this month's total minus the conversion itself.
 */
export async function usedBeforeCharge(env: Env, userId: string, credits: number, chargeId?: string): Promise<number> {
  if (chargeId) {
    const charge = await env.DB.prepare('SELECT created_at FROM conversion_charges WHERE id = ? AND user_id = ?').bind(chargeId, userId).first<{ created_at: number }>();
    if (charge) {
      const start = monthStart(charge.created_at);
      const row = await env.DB.prepare(
        `SELECT (${UNRESERVED_USAGE_SQL} AND u.created_at < ?) + (${CHARGES_SQL} AND (created_at < ? OR (created_at = ? AND id < ?))) AS used`,
      )
        .bind(userId, start, charge.created_at, charge.created_at, userId, start, charge.created_at, charge.created_at, chargeId)
        .first<{ used: number }>();
      return row?.used ?? 0;
    }
  }
  return Math.max(0, (await creditsUsedThisMonth(env, userId)) - credits);
}
