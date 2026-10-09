/**
 * How credit grants interact with metered overage. Within a billing period, credits are consumed in
 * this order: the plan's included credits, then credit grants, then paid overage. The billing meter
 * already knows the included credits (its own benefit covers them, reset every subscription
 * period), but not anymd's grants, so the units a grant covers must never reach the meter.
 *
 * A grant covers usage from the moment it starts counting, never retroactively: overage already
 * reported before the grant stays billed. Each grant therefore owns a band of the period's usage
 * positions that starts at the later of (the included credits, usage when the grant was created,
 * the end of the previous grant's band) and runs for its credits, cut short where it expired or was
 * revoked. Example on a 10,000-credit plan: a 5,000-credit grant created when the account had used
 * 12,000 owns positions [12,000, 17,000); the 2,000 overage before it stays billed.
 */
import type { Env } from '../env';
import { CHARGES_SQL, UNRESERVED_USAGE_SQL } from '../lib/conversion-budget';
import { monthStart } from '../lib/usage';
import { now } from '../lib/util';

/** Usage positions `[start, end)` within the period that a grant pays for. */
export type Band = [start: number, end: number];

export interface GrantSpan {
  credits: number;
  /** Usage in the period when the grant started counting (0 for a grant older than the period). */
  usedAtStart: number;
  /** Usage when the grant stopped counting (expired or revoked), or null while it still counts. */
  usedAtStop: number | null;
}

/** Lays grants (oldest first) after the included credits, each starting no earlier than its own creation. */
export function grantBands(included: number, grants: GrantSpan[]): Band[] {
  let cursor = Math.max(0, Math.floor(included));
  return grants.map((g) => {
    const start = Math.max(cursor, Math.floor(g.usedAtStart));
    let end = start + Math.max(0, Math.floor(g.credits));
    if (g.usedAtStop !== null) end = Math.min(end, Math.max(start, Math.floor(g.usedAtStop)));
    cursor = end;
    return [start, end];
  });
}

export interface MeterWindow {
  /** Credits the account had used this period before this conversion. */
  usedBefore: number;
  /** Credits this conversion spent. */
  credits: number;
  /** Disjoint grant bands of the period (from `grantBands`). */
  bands: Band[];
}

/** Units of one conversion to report to the meter: all of them except those inside a grant band. */
export function meteredUnits({ usedBefore, credits, bands }: MeterWindow): number {
  const spent = Math.max(0, Math.floor(credits));
  if (!spent) return 0;
  const start = Math.max(0, Math.floor(usedBefore));
  const end = start + spent;
  const covered = bands.reduce((sum, [bs, be]) => sum + Math.max(0, Math.min(end, be) - Math.max(start, bs)), 0);
  return spent - covered;
}

/**
 * Start of the billing period the meter's included credits reset on: the current period of an
 * active monthly subscription, or the calendar month (UTC) when there is none (yearly plans, a
 * period the webhooks have not refreshed yet, or no subscription row).
 */
export async function meterPeriodStart(env: Env, userId: string, ts: number): Promise<number> {
  const sub = await env.DB.prepare(
    `SELECT current_period_start AS start FROM subscriptions
     WHERE user_id = ? AND status IN ('active','trialing') AND billing_interval = 'month'
       AND current_period_start IS NOT NULL AND current_period_start <= ? AND (current_period_end IS NULL OR current_period_end > ?)
     ORDER BY current_period_start DESC LIMIT 1`,
  )
    .bind(userId, ts, ts)
    .first<{ start: number }>();
  return sub?.start ?? monthStart(ts);
}

/** Credits used in the period before `ts`; with `chargeId`, ties at `ts` are ordered by charge id. */
async function usedBefore(env: Env, userId: string, periodStart: number, ts: number, chargeId?: string): Promise<number> {
  const tie = chargeId ? ' OR (created_at = ? AND id < ?)' : '';
  const row = await env.DB.prepare(`SELECT (${UNRESERVED_USAGE_SQL} AND u.created_at < ?) + (${CHARGES_SQL} AND (created_at < ?${tie})) AS used`)
    .bind(userId, periodStart, ts, ts, userId, periodStart, ts, ...(chargeId ? [ts, chargeId] : []))
    .first<{ used: number }>();
  return row?.used ?? 0;
}

interface GrantRow {
  credits: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

/**
 * Where one conversion falls in the period and which bands the grants own. `chargeId` locates the
 * conversion by its charge's (created_at, id), so concurrent conversions each see a consistent
 * position; without it (nothing was reserved) the conversion is placed at the end of current usage.
 */
export async function meterWindow(env: Env, userId: string, credits: number, included: number, chargeId?: string): Promise<MeterWindow> {
  const charge = chargeId ? await env.DB.prepare('SELECT created_at FROM conversion_charges WHERE id = ? AND user_id = ?').bind(chargeId, userId).first<{ created_at: number }>() : null;
  const ts = charge?.created_at ?? now();
  const period = await meterPeriodStart(env, userId, ts);
  const position = charge ? await usedBefore(env, userId, period, ts, chargeId) : Math.max(0, (await usedBefore(env, userId, period, ts + 1)) - credits);
  const { results } = await env.DB.prepare(
    `SELECT credits, created_at, expires_at, revoked_at FROM credit_grants
     WHERE user_id = ? AND created_at <= ? AND (expires_at IS NULL OR expires_at > ?) AND (revoked_at IS NULL OR revoked_at > ?)
     ORDER BY created_at, id LIMIT 100`,
  )
    .bind(userId, ts, period, period)
    .all<GrantRow>();
  const at = (moment: number) => (moment <= period ? Promise.resolve(0) : usedBefore(env, userId, period, moment));
  const spans = await Promise.all(
    results.map(async (g): Promise<GrantSpan> => {
      const stops = [g.expires_at, g.revoked_at].filter((v): v is number => v !== null && v <= ts);
      return { credits: g.credits, usedAtStart: await at(g.created_at), usedAtStop: stops.length ? await at(Math.min(...stops)) : null };
    }),
  );
  return { usedBefore: position, credits, bands: grantBands(included, spans) };
}
