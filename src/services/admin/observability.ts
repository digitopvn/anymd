/**
 * Operations views. System-wide views need `system:read` and are bounded by time window and row
 * limits so they stay cheap on D1. The caller's own traces need `usage:read` and are scoped to them.
 */
import { z } from 'zod';
import type { Env, Principal } from '../../env';
import { now, safeJson } from '../../lib/util';
import { AdminError, assertScope, clampLimit, cursorClause, decodeCursor, iso, page, parseInput, Timestamp, type Paged } from './shared';

const DAY = 86_400_000;
/** The longest window any system-wide view reads. */
export const MAX_WINDOW_DAYS = 30;
/** Latency percentiles come from the newest events in the window, at most this many. */
export const LATENCY_SAMPLE = 10_000;
/** sort=slowest ranks at most this many of the newest traces in the window. */
export const SLOWEST_SCAN = 5_000;

/** Source kind from the target URL; usage rows do not store it, so it is derived for reporting. */
const SOURCE_SQL = `CASE
  WHEN target = '' THEN 'none'
  WHEN target LIKE '%github.com/%' OR target LIKE '%gist.github%' THEN 'github'
  WHEN target LIKE '%youtube.com/%' OR target LIKE '%youtu.be/%' THEN 'youtube'
  WHEN target LIKE '%reddit.com/%' THEN 'reddit'
  WHEN target LIKE '%news.ycombinator.com/%' THEN 'hackernews'
  WHEN target LIKE '%://x.com/%' OR target LIKE '%twitter.com/%' THEN 'x'
  WHEN lower(target) LIKE '%.pdf' OR lower(target) LIKE '%.pdf?%' THEN 'pdf'
  WHEN lower(target) LIKE '%.docx' OR lower(target) LIKE '%.xlsx' OR lower(target) LIKE '%.pptx' THEN 'office'
  WHEN lower(target) LIKE '%.png' OR lower(target) LIKE '%.jpg' OR lower(target) LIKE '%.jpeg' OR lower(target) LIKE '%.webp' THEN 'image'
  ELSE 'web' END`;

/** Headline numbers for the whole deployment. */
export async function systemOverview(env: Env, actor: Principal) {
  assertScope(actor, 'system:read');
  const ts = now();
  const [users, byRole, signups, subs, usage24, usage7, docs, audits, webhookFailures, optouts] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended FROM users").first<{ total: number; suspended: number | null }>(),
    env.DB.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role ORDER BY n DESC').all<{ role: string; n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?').bind(ts - 7 * DAY).first<{ n: number }>(),
    env.DB.prepare("SELECT plan, COUNT(*) AS n FROM users WHERE plan != 'free' GROUP BY plan ORDER BY n DESC").all<{ plan: string; n: number }>(),
    usageTotals(env, ts - DAY),
    usageTotals(env, ts - 7 * DAY),
    env.DB.prepare('SELECT COUNT(*) AS n FROM documents').first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ?').bind(ts - DAY).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'billing.webhook_failed' AND created_at >= ?").bind(ts - 7 * DAY).first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM site_optouts').first<{ n: number }>(),
  ]);
  return {
    generated_at: iso(ts),
    environment: env.ENVIRONMENT,
    users: { total: users?.total ?? 0, suspended: users?.suspended ?? 0, signups_7d: signups?.n ?? 0, by_role: byRole.results, paid_by_plan: subs.results },
    usage: { last_24h: usage24, last_7d: usage7 },
    library: { documents: docs?.n ?? 0 },
    audit: { events_24h: audits?.n ?? 0 },
    billing: { webhook_failures_7d: webhookFailures?.n ?? 0 },
    site_optouts: optouts?.n ?? 0,
  };
}

async function usageTotals(env: Env, since: number, filter = '', binds: unknown[] = []) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(credits),0) AS credits, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
       SUM(CASE WHEN status='cached' THEN 1 ELSE 0 END) AS cached, COUNT(DISTINCT user_id) AS users
     FROM usage_events WHERE created_at >= ?${filter}`,
  )
    .bind(since, ...binds)
    .first<{ requests: number; credits: number; errors: number | null; cached: number | null; users: number }>();
  const requests = row?.requests ?? 0;
  const errors = row?.errors ?? 0;
  return { requests, credits: row?.credits ?? 0, errors, cached: row?.cached ?? 0, users: row?.users ?? 0, error_rate: requests ? Math.round((errors / requests) * 10_000) / 10_000 : 0 };
}

export const SystemUsageQuery = z.object({
  days: z.number().int().min(1).max(MAX_WINDOW_DAYS).optional().describe('Window in days, default 7, at most 30'),
  channel: z.enum(['web', 'api', 'mcp', 'cli', 'webmcp']).optional(),
  kind: z.string().max(40).optional(),
});

interface UsageGroup {
  channel: string;
  kind: string;
  source: string;
  day: string;
  n: number;
  credits: number;
  errors: number;
  cached: number;
}

type Breakdown = { n: number; credits: number; errors: number };

/** Sums the grouped rows by one dimension, largest first (or by key for the daily series). */
function rollUp(groups: UsageGroup[], key: 'channel' | 'kind' | 'source' | 'day') {
  const out = new Map<string, Breakdown>();
  for (const g of groups) {
    const b = out.get(g[key]) ?? { n: 0, credits: 0, errors: 0 };
    b.n += g.n;
    b.credits += g.credits;
    b.errors += g.errors;
    out.set(g[key], b);
  }
  const rows = [...out].sort(([ka, a], [kb, b]) => (key === 'day' ? ka.localeCompare(kb) : b.n - a.n));
  return rows.map(([k, b]) => ({ [key]: k, ...b }));
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * Usage across all users: totals, latency percentiles, breakdowns, daily series, top errors.
 * Totals and every breakdown come from one grouped pass over the window; latency percentiles from
 * a bounded sample of the newest events, read through the created_at index.
 */
export async function systemUsage(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'system:read');
  const q = parseInput(SystemUsageQuery, raw);
  const days = q.days ?? 7;
  const since = now() - days * DAY;
  let filter = '';
  const binds: unknown[] = [];
  if (q.channel) (filter += ' AND channel = ?'), binds.push(q.channel);
  if (q.kind) (filter += ' AND kind = ?'), binds.push(q.kind);
  const where = `WHERE created_at >= ?${filter}`;
  const all = [since, ...binds];
  const [grouped, users, sample, topErrors, failed] = await Promise.all([
    env.DB.prepare(
      `SELECT channel, kind, ${SOURCE_SQL} AS source, strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n, COALESCE(SUM(credits),0) AS credits,
         SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors, SUM(CASE WHEN status='cached' THEN 1 ELSE 0 END) AS cached
       FROM usage_events ${where} GROUP BY 1, 2, 3, 4`,
    )
      .bind(...all)
      .all<UsageGroup>(),
    env.DB.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM usage_events ${where}`).bind(...all).first<{ n: number }>(),
    env.DB.prepare(`SELECT duration_ms AS v FROM usage_events ${where} ORDER BY created_at DESC LIMIT ?`).bind(...all, LATENCY_SAMPLE).all<{ v: number }>(),
    env.DB.prepare(`SELECT substr(COALESCE(error,''),1,200) AS error, COUNT(*) AS n, MAX(created_at) AS last_at FROM usage_events ${where} AND status = 'error' GROUP BY 1 ORDER BY n DESC LIMIT 10`).bind(...all).all(),
    env.DB.prepare(`SELECT id, user_id, channel, kind, target, http_status, substr(COALESCE(error,''),1,300) AS error, trace_id, created_at FROM usage_events ${where} AND status = 'error' AND kind = 'convert' ORDER BY created_at DESC LIMIT 10`)
      .bind(...all)
      .all(),
  ]);
  const groups = grouped.results;
  const requests = groups.reduce((s, g) => s + g.n, 0);
  const errors = groups.reduce((s, g) => s + g.errors, 0);
  const durations = sample.results.map((r) => r.v).sort((a, b) => a - b);
  return {
    window: { days, since: iso(since) },
    filters: { channel: q.channel ?? null, kind: q.kind ?? null },
    totals: {
      requests,
      credits: groups.reduce((s, g) => s + g.credits, 0),
      errors,
      cached: groups.reduce((s, g) => s + g.cached, 0),
      users: users?.n ?? 0,
      error_rate: requests ? Math.round((errors / requests) * 10_000) / 10_000 : 0,
    },
    latency_ms: { p50: percentile(durations, 0.5), p90: percentile(durations, 0.9), p99: percentile(durations, 0.99), sample_size: durations.length },
    by_channel: rollUp(groups, 'channel').map(({ errors: _e, ...r }) => r),
    by_kind: rollUp(groups, 'kind').map(({ errors: _e, ...r }) => r),
    by_source: rollUp(groups, 'source').map(({ credits: _c, ...r }) => r),
    daily: rollUp(groups, 'day'),
    top_errors: topErrors.results,
    recent_failed_conversions: failed.results,
  };
}

interface TraceRow {
  id: string;
  user_id: string | null;
  kind: string;
  target: string;
  status: string;
  duration_ms: number;
  spans?: string;
  meta: string;
  created_at: number;
}

function traceSummary(r: TraceRow) {
  return { id: r.id, user_id: r.user_id, kind: r.kind, target: r.target, status: r.status, duration_ms: r.duration_ms, created_at: r.created_at, at: iso(r.created_at), meta: safeJson<Record<string, unknown>>(r.meta, {}) };
}

function traceDetail(r: TraceRow) {
  return { ...traceSummary(r), spans: safeJson<unknown[]>(r.spans, []) };
}

export const SystemTraceQuery = z.object({
  sort: z.enum(['recent', 'slowest']).optional().describe('recent (default, paginated) or slowest in the window'),
  status: z.string().max(20).optional(),
  kind: z.string().max(40).optional(),
  userId: z.string().max(80).optional(),
  since: Timestamp.optional().describe('Default: 7 days ago; at most 30 days ago'),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export async function listSystemTraces(env: Env, actor: Principal, raw: unknown): Promise<Paged<ReturnType<typeof traceSummary>>> {
  assertScope(actor, 'system:read');
  const q = parseInput(SystemTraceQuery, raw);
  const limit = clampLimit(q.limit, 25, 100);
  const ts = now();
  const oldest = ts - MAX_WINDOW_DAYS * DAY;
  if (q.since !== undefined && q.since < oldest) {
    throw new AdminError(`since must be within the last ${MAX_WINDOW_DAYS} days (on or after ${iso(oldest)}).`, 422, 'invalid_request', [{ path: 'since', message: `At most ${MAX_WINDOW_DAYS} days ago` }]);
  }
  const parts = ['created_at >= ?'];
  const binds: unknown[] = [q.since ?? ts - 7 * DAY];
  if (q.status) parts.push('status = ?'), binds.push(q.status);
  if (q.kind) parts.push('kind = ?'), binds.push(q.kind);
  if (q.userId) parts.push('user_id = ?'), binds.push(q.userId);
  const cols = 'id,user_id,kind,target,status,duration_ms,meta,created_at';
  if (q.sort === 'slowest') {
    if (q.cursor) throw new AdminError('sort=slowest returns a single page; narrow the window with since instead of a cursor.', 400, 'invalid_cursor');
    // Rank only the newest SLOWEST_SCAN traces of the window, reading just the columns stored before
    // the large spans blob, then fetch the full summary for the winners.
    const { results } = await env.DB.prepare(
      `SELECT ${cols.split(',').map((c) => `t.${c}`).join(',')} FROM (SELECT id, duration_ms FROM traces WHERE ${parts.join(' AND ')} ORDER BY created_at DESC LIMIT ?) w
       JOIN traces t ON t.id = w.id ORDER BY w.duration_ms DESC, w.id LIMIT ?`,
    )
      .bind(...binds, SLOWEST_SCAN, limit)
      .all<TraceRow>();
    return { items: results.map(traceSummary), next_cursor: null };
  }
  const c = cursorClause(decodeCursor(q.cursor));
  if (c.sql) parts.push(c.sql), binds.push(...c.binds);
  const { results } = await env.DB.prepare(`SELECT ${cols} FROM traces WHERE ${parts.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...binds, limit + 1).all<TraceRow>();
  const paged = page(results, limit);
  return { items: paged.items.map(traceSummary), next_cursor: paged.next_cursor };
}

export async function getSystemTrace(env: Env, actor: Principal, traceId: string) {
  assertScope(actor, 'system:read');
  const row = await env.DB.prepare('SELECT * FROM traces WHERE id = ?').bind(traceId).first<TraceRow>();
  if (!row) throw new AdminError('Trace not found. List them with list_system_traces.', 404, 'not_found');
  return traceDetail(row);
}

// ─── The caller's own traces (usage:read) ───────────────────────────────────

export const OwnTraceQuery = z.object({ cursor: z.string().max(400).optional(), limit: z.number().int().min(1).max(200).optional() });

export async function listOwnTraces(env: Env, actor: Principal, raw: unknown): Promise<Paged<ReturnType<typeof traceSummary>>> {
  assertScope(actor, 'usage:read');
  const q = parseInput(OwnTraceQuery, raw);
  const limit = clampLimit(q.limit, 50, 200);
  const c = cursorClause(decodeCursor(q.cursor));
  const { results } = await env.DB.prepare(`SELECT id,user_id,kind,target,status,duration_ms,meta,created_at FROM traces WHERE user_id = ?${c.sql ? ` AND ${c.sql}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(actor.userId, ...c.binds, limit + 1)
    .all<TraceRow>();
  const paged = page(results, limit);
  return { items: paged.items.map(traceSummary), next_cursor: paged.next_cursor };
}

export async function getOwnTrace(env: Env, actor: Principal, traceId: string) {
  assertScope(actor, 'usage:read');
  const row = await env.DB.prepare('SELECT * FROM traces WHERE id = ? AND user_id = ?').bind(traceId, actor.userId).first<TraceRow>();
  if (!row) throw new AdminError('Trace not found', 404, 'not_found');
  return traceDetail(row);
}
