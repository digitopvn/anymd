/**
 * Credit grant pools across billing periods. A recurring grant renews its full credits every period
 * it is active. A one-time grant is a single pool of N credits over its whole lifetime: in each
 * period it covers at most what is left after the earlier periods, so a grant that straddles a
 * period boundary is never counted twice.
 *
 * Grants stored before the `recurring` column existed (NULL) keep the behavior they were created
 * under and renew every period.
 *
 * Within a period, credits are consumed in this order: the plan's included credits, then grants
 * (oldest first), then paid overage. A grant covers usage from the moment it starts counting, never
 * retroactively: its band of usage positions starts at the latest of the included credits, the
 * usage when it was created and the end of the previous grant's band, runs for its available
 * credits, and is cut where it expired or was revoked.
 */
import type { Env } from '../env';
import { CHARGES_SQL, UNRESERVED_USAGE_SQL } from '../lib/conversion-budget';

/** Usage positions `[start, end)` within a period that a grant pays for. */
export type Band = [start: number, end: number];

export interface GrantSpan {
  /** Credits the grant can still cover in this period. */
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

/** Units of `[from, to)` that fall inside a band. */
export function overlap([start, end]: Band, from: number, to: number): number {
  return Math.max(0, Math.min(to, end) - Math.max(from, start));
}

export interface Period {
  start: number;
  end: number;
}

/** The billing period containing `ts`. */
export type PeriodResolver = (ts: number) => Promise<Period>;

export interface GrantRecord {
  id: string;
  credits: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  recurring: number | null;
}

const renews = (g: GrantRecord) => g.recurring !== 0;
const stopOf = (g: GrantRecord) => Math.min(g.expires_at ?? Infinity, g.revoked_at ?? Infinity);
/** A one-time grant runs for about two months at most; this bounds a malformed history. */
const MAX_PAST_PERIODS = 24;

/** Credits used in the period starting at `periodStart`, before `ts`; with `chargeId`, ties at `ts` are ordered by charge id. */
export async function usedBefore(env: Env, userId: string, periodStart: number, ts: number, chargeId?: string): Promise<number> {
  if (ts <= periodStart) return 0;
  const tie = chargeId ? ' OR (created_at = ? AND id < ?)' : '';
  const row = await env.DB.prepare(`SELECT (${UNRESERVED_USAGE_SQL} AND u.created_at < ?) + (${CHARGES_SQL} AND (created_at < ?${tie})) AS used`)
    .bind(userId, periodStart, ts, ts, userId, periodStart, ts, ...(chargeId ? [ts, chargeId] : []))
    .first<{ used: number }>();
  return row?.used ?? 0;
}

/** Grants of a user that count at some point in `[from, to]`, oldest first. */
async function grantsBetween(env: Env, userId: string, from: number, to: number): Promise<GrantRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, credits, created_at, expires_at, revoked_at, recurring FROM credit_grants
     WHERE user_id = ? AND created_at <= ? AND (expires_at IS NULL OR expires_at > ?) AND (revoked_at IS NULL OR revoked_at > ?)
     ORDER BY created_at, id LIMIT 200`,
  )
    .bind(userId, to, from, from)
    .all<GrantRecord>();
  return results;
}

/** Spans of the grants that count in the period `[start, end)`, sized from `available`. */
async function spansIn(env: Env, userId: string, period: Period, grants: GrantRecord[], available: Map<string, number>) {
  const live = grants.filter((g) => g.created_at < period.end && stopOf(g) > period.start);
  const at = (moment: number) => usedBefore(env, userId, period.start, moment);
  const spans = await Promise.all(
    live.map(async (g): Promise<GrantSpan> => {
      const stop = stopOf(g);
      return {
        credits: renews(g) ? g.credits : (available.get(g.id) ?? g.credits),
        usedAtStart: await at(g.created_at),
        usedAtStop: stop < period.end ? await at(stop) : null,
      };
    }),
  );
  return { live, spans };
}

/**
 * Grants counting at some point up to `ts` and, for one-time grants, the credits left when
 * `current` begins. One-time grants created before `current` have the earlier periods replayed
 * with the same band rules to find what they already covered.
 */
async function poolsAt(env: Env, userId: string, ts: number, current: Period, included: number, resolve: PeriodResolver) {
  const recent = await grantsBetween(env, userId, current.start, ts);
  const firstOneTime = recent.find((g) => !renews(g) && g.created_at < current.start);
  const from = firstOneTime ? firstOneTime.created_at : current.start;
  const grants = firstOneTime ? await grantsBetween(env, userId, from, ts) : recent;
  const available = new Map(grants.filter((g) => !renews(g)).map((g) => [g.id, g.credits]));

  let cursor = from;
  for (let i = 0; cursor < current.start && i < MAX_PAST_PERIODS; i++) {
    const found = await resolve(cursor);
    const period = { start: found.start, end: Math.min(found.end > cursor ? found.end : current.start, current.start) };
    const { live, spans } = await spansIn(env, userId, period, grants, available);
    const used = await usedBefore(env, userId, period.start, period.end);
    grantBands(included, spans).forEach((band, k) => {
      const g = live[k];
      if (!renews(g)) available.set(g.id, Math.max(0, (available.get(g.id) ?? 0) - overlap(band, 0, used)));
    });
    cursor = period.end;
  }
  return { grants: grants.filter((g) => g.created_at <= ts), available };
}

/** The grants counting in `current` (the period containing `ts`) and the span each owns there. */
export async function grantSpansForPeriod(env: Env, userId: string, ts: number, current: Period, included: number, resolve: PeriodResolver) {
  const { grants, available } = await poolsAt(env, userId, ts, current, included, resolve);
  return spansIn(env, userId, current, grants, available);
}

/**
 * Credits active grants add to the allowance of `current` at `ts`: a recurring grant its full
 * credits, a one-time grant what is left of its pool after earlier periods.
 */
export async function grantAllowance(env: Env, userId: string, ts: number, current: Period, included: number, resolve: PeriodResolver): Promise<number> {
  const { grants, available } = await poolsAt(env, userId, ts, current, included, resolve);
  return grants.filter((g) => stopOf(g) > ts).reduce((sum, g) => sum + (renews(g) ? g.credits : (available.get(g.id) ?? g.credits)), 0);
}
