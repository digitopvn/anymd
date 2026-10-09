import type { Env, Principal } from '../env';
import { getPlan } from '../billing/plans';
import type { Tracer } from './tracer';
import { newId, now } from './util';
import { CHARGES_SQL, UNRESERVED_USAGE_SQL } from './conversion-budget';

export type Channel = 'web' | 'api' | 'mcp' | 'cli' | 'webmcp' | 'url';

export interface UsageInput {
  principal: Principal;
  channel: Channel;
  kind: string;
  target: string;
  status: 'ok' | 'error' | 'cached';
  httpStatus: number;
  credits: number;
  durationMs: number;
  bytesOut?: number;
  traceId?: string;
  error?: string;
}

export function monthStart(ts = now()): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Credits used this calendar month (UTC). */
export async function creditsUsedThisMonth(env: Env, userId: string): Promise<number> {
  const ts = now();
  const row = await env.DB.prepare(`SELECT (${UNRESERVED_USAGE_SQL}) + (${CHARGES_SQL}) AS used`)
    .bind(userId, monthStart(ts), ts, userId, monthStart(ts))
    .first<{ used: number }>();
  return row?.used ?? 0;
}

export async function extraCredits(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(credits),0) AS c FROM credit_grants WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  )
    .bind(userId, now())
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export interface QuotaState {
  plan: string;
  included: number;
  extra: number;
  used: number;
  remaining: number;
  overage: boolean; // true when the plan bills beyond the included amount
}

export async function quotaState(env: Env, userId: string, planId: string): Promise<QuotaState> {
  const plan = getPlan(planId);
  const [used, extra] = await Promise.all([creditsUsedThisMonth(env, userId), extraCredits(env, userId)]);
  const total = plan.credits + extra;
  return { plan: plan.id, included: plan.credits, extra, used, remaining: Math.max(0, total - used), overage: plan.overagePer1k !== null };
}

/** Whether a signed-in user may spend `cost` credits now. Plans with overage pricing continue past the allowance. */
export async function canSpend(env: Env, userId: string, planId: string, cost: number): Promise<{ ok: boolean; state: QuotaState }> {
  const state = await quotaState(env, userId, planId);
  return { ok: state.overage || state.remaining >= cost, state };
}

export async function recordUsage(env: Env, input: UsageInput, tracer?: Tracer): Promise<void> {
  const ts = now();
  const stmts = [
    env.DB.prepare(
      'INSERT INTO usage_events (id,user_id,api_key_id,channel,kind,target,status,http_status,credits,duration_ms,bytes_out,trace_id,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(
      newId('evt_'),
      input.principal.userId,
      input.principal.apiKeyId ?? null,
      input.channel,
      input.kind,
      input.target.slice(0, 500),
      input.status,
      input.httpStatus,
      input.credits,
      input.durationMs,
      input.bytesOut ?? 0,
      input.traceId ?? null,
      input.error?.slice(0, 500) ?? null,
      ts,
    ),
  ];
  if (input.kind === 'convert' && input.status !== 'error') {
    stmts.push(env.DB.prepare("UPDATE stats SET value = value + 1 WHERE key = 'conversions_total'"));
  }
  // Traces are kept for signed-in users only; anonymous traffic keeps just the usage row.
  if (tracer && input.principal.userId) {
    stmts.push(
      env.DB.prepare('INSERT INTO traces (id,user_id,kind,target,status,duration_ms,spans,meta,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(
        tracer.id,
        input.principal.userId,
        input.kind,
        input.target.slice(0, 500),
        input.status,
        input.durationMs,
        JSON.stringify(tracer.spans),
        JSON.stringify({ channel: input.channel, credits: input.credits, http_status: input.httpStatus, error: input.error ?? null }),
        ts,
      ),
    );
  }
  await env.DB.batch(stmts);
}

export async function totalConversions(env: Env): Promise<number> {
  const cached = await env.CACHE.get('stats:conversions_total');
  if (cached) return Number(cached);
  const row = await env.DB.prepare("SELECT value FROM stats WHERE key = 'conversions_total'").first<{ value: number }>();
  const value = row?.value ?? 0;
  await env.CACHE.put('stats:conversions_total', String(value), { expirationTtl: 300 });
  return value;
}
