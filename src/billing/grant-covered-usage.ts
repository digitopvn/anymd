/**
 * How credit grants interact with metered overage. The billing meter already knows the plan's
 * included credits (its own benefit covers them, reset every subscription period), but not anymd's
 * grants, so the units a grant covers (see `grant-pool-ledger.ts` for the band rules and one-time
 * pools) must never reach the meter. Overage reported before a grant stays billed.
 *
 * Example on a 10,000-credit plan: a one-time 5,000-credit grant created when the account had used
 * 12,000 this period owns positions [12,000, 17,000); the 2,000 overage before it stays billed. If
 * the period ends after 3,000 of it were used, it covers at most the remaining 2,000 next period.
 */
import type { Env } from '../env';
import { monthStart, nextMonthStart } from '../lib/usage';
import { now } from '../lib/util';
import { grantBands, grantSpansForPeriod, overlap, usedBefore, type Band, type Period } from './grant-pool-ledger';

export { grantBands, type Band } from './grant-pool-ledger';

export interface MeterWindow {
  /** Credits the account had used this period before this conversion. */
  usedBefore: number;
  /** Credits this conversion spent. */
  credits: number;
  /** Disjoint grant bands of the period (from `grantBands`). */
  bands: Band[];
}

/** Units of one conversion to report to the meter: all of them except those inside a grant band. */
export function meteredUnits({ usedBefore: start, credits, bands }: MeterWindow): number {
  const spent = Math.max(0, Math.floor(credits));
  if (!spent) return 0;
  const from = Math.max(0, Math.floor(start));
  return spent - bands.reduce((sum, band) => sum + overlap(band, from, from + spent), 0);
}

/** The calendar month (UTC) containing `ts`. */
export function calendarPeriod(ts: number): Period {
  return { start: monthStart(ts), end: nextMonthStart(ts) };
}

/**
 * The billing period the meter's included credits reset on: the current period of an active
 * monthly subscription, or the calendar month (UTC) when there is none (yearly plans, a period the
 * webhooks have not refreshed yet, an earlier period, or no subscription row).
 */
export async function meterPeriod(env: Env, userId: string, ts: number): Promise<Period> {
  const sub = await env.DB.prepare(
    `SELECT current_period_start AS start, current_period_end AS end FROM subscriptions
     WHERE user_id = ? AND status IN ('active','trialing') AND billing_interval = 'month'
       AND current_period_start IS NOT NULL AND current_period_start <= ? AND (current_period_end IS NULL OR current_period_end > ?)
     ORDER BY current_period_start DESC LIMIT 1`,
  )
    .bind(userId, ts, ts)
    .first<{ start: number; end: number | null }>();
  return sub ? { start: sub.start, end: sub.end ?? nextMonthStart(sub.start) } : calendarPeriod(ts);
}

/** Start of the meter period containing `ts`. */
export async function meterPeriodStart(env: Env, userId: string, ts: number): Promise<number> {
  return (await meterPeriod(env, userId, ts)).start;
}

/**
 * Where one conversion falls in its period and which bands the grants own there. `chargeId`
 * locates the conversion by its charge's (created_at, id), so concurrent conversions each see a
 * consistent position; without it (nothing was reserved) it is placed at the end of current usage.
 */
export async function meterWindow(env: Env, userId: string, credits: number, included: number, chargeId?: string): Promise<MeterWindow> {
  const charge = chargeId ? await env.DB.prepare('SELECT created_at FROM conversion_charges WHERE id = ? AND user_id = ?').bind(chargeId, userId).first<{ created_at: number }>() : null;
  const ts = charge?.created_at ?? now();
  const period = await meterPeriod(env, userId, ts);
  const position = charge ? await usedBefore(env, userId, period.start, ts, chargeId) : Math.max(0, (await usedBefore(env, userId, period.start, ts + 1)) - credits);
  const { spans } = await grantSpansForPeriod(env, userId, ts, period, included, (at) => meterPeriod(env, userId, at));
  return { usedBefore: position, credits, bands: grantBands(included, spans) };
}
