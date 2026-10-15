/**
 * Product KPIs and per-user activity for owners and admins. Every number states what it counts:
 * the response carries its definitions, the windows (rolling, UTC, ending at `generated_at`) and
 * what the data cannot see. Nothing is estimated; revenue is not reported because anymd does not
 * store orders or invoices (the billing provider does).
 */
import { z } from 'zod';
import type { Env, Principal } from '../../env';
import { now } from '../../lib/util';
import { entitledPlan } from './billing';
import { MAX_WINDOW_DAYS, SOURCE_SQL, usageTotals } from './observability';
import { AdminError, assertScope, clampLimit, cursorClause, decodeCursor, iso, page, parseInput, Timestamp } from './shared';

const DAY = 86_400_000;
/** Latest-subscription rows read for the plan and subscription mix. */
export const SUBSCRIPTION_SCAN = 5_000;

export const KPI_DEFINITIONS = {
  registered_users: 'Every row in users, including suspended accounts (reported separately). No accounts are excluded.',
  new_signups: 'Accounts whose created_at falls in the window.',
  active_users:
    'Distinct signed-in users with qualifying activity in the window: any usage event with a user (conversions, searches, library and API/MCP/CLI calls, success or error) or a browser sign-in. Anonymous usage is not attributable and is excluded.',
  usage_active_users: 'Distinct users with at least one usage event in the window (sign-ins not counted). Kept separate from active_users.',
  activated_users: 'Distinct users who have at least one saved library document (first saved read). Account creation alone is not activation.',
  stored_plan: 'users.plan as stored. It follows billing webhooks but is not proof of payment.',
  paying_accounts: "Users whose latest subscription entitles a paid plan under the live billing provider's status rules.",
  plan_conflicts: 'Users whose stored plan differs from what their latest subscription entitles, plus users on a paid stored plan with no subscription at all.',
  usage: 'Requests, credits and error rate from usage_events (all channels), as in list_system_usage.',
} as const;

const DATA_COVERAGE = [
  'Windows are rolling (last 24 hours, 7 days, 30 days) in UTC, ending at generated_at.',
  'Sign-ins come from the sessions table: sessions are deleted at sign-out and expiry, so sign-in activity can be undercounted. Usage events are kept as recorded.',
  'Users who delete every library document no longer count as activated.',
  'No bot, internal or test accounts are excluded; the role breakdown in system_overview shows staff accounts.',
  'Revenue, MRR, orders and invoices are not reported: anymd stores subscriptions synced by webhook, not payments.',
];

export async function getUserStats(env: Env, actor: Principal) {
  assertScope(actor, 'system:read');
  const ts = now();
  const d1 = ts - DAY;
  const d7 = ts - 7 * DAY;
  const d30 = ts - 30 * DAY;
  const [users, signups, active, usageActive, anonymous, activated, cohort, plans, latestSubs, paidNoSub, u1, u7, u30] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended FROM users").first<{ total: number; suspended: number | null }>(),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS d1, SUM(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END) AS d7, SUM(CASE WHEN created_at >= ?3 THEN 1 ELSE 0 END) AS d30,
         SUM(CASE WHEN created_at >= ?4 AND created_at < ?1 THEN 1 ELSE 0 END) AS prev_d1, SUM(CASE WHEN created_at >= ?5 AND created_at < ?2 THEN 1 ELSE 0 END) AS prev_d7,
         SUM(CASE WHEN created_at < ?3 THEN 1 ELSE 0 END) AS prev_d30
       FROM users WHERE created_at >= ?6`,
    )
      .bind(d1, d7, d30, ts - 2 * DAY, ts - 14 * DAY, ts - 60 * DAY)
      .first<Record<'d1' | 'd7' | 'd30' | 'prev_d1' | 'prev_d7' | 'prev_d30', number | null>>(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT CASE WHEN at >= ?1 THEN uid END) AS dau, COUNT(DISTINCT CASE WHEN at >= ?2 THEN uid END) AS wau, COUNT(DISTINCT uid) AS mau
       FROM (SELECT user_id AS uid, created_at AS at FROM usage_events WHERE created_at >= ?3 AND user_id IS NOT NULL
             UNION ALL SELECT user_id AS uid, created_at AS at FROM sessions WHERE created_at >= ?3)`,
    )
      .bind(d1, d7, d30)
      .first<{ dau: number; wau: number; mau: number }>(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT CASE WHEN created_at >= ?1 THEN user_id END) AS d1, COUNT(DISTINCT CASE WHEN created_at >= ?2 THEN user_id END) AS d7, COUNT(DISTINCT user_id) AS d30
       FROM usage_events WHERE created_at >= ?3 AND user_id IS NOT NULL`,
    )
      .bind(d1, d7, d30)
      .first<{ d1: number; d7: number; d30: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE created_at >= ? AND user_id IS NULL').bind(d30).first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM users u WHERE EXISTS (SELECT 1 FROM documents d WHERE d.user_id = u.id)').first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS signups, SUM(CASE WHEN EXISTS (SELECT 1 FROM documents d WHERE d.user_id = u.id) THEN 1 ELSE 0 END) AS activated FROM users u WHERE u.created_at >= ?')
      .bind(d30)
      .first<{ signups: number; activated: number | null }>(),
    env.DB.prepare('SELECT plan, COUNT(*) AS n FROM users GROUP BY plan ORDER BY n DESC').all<{ plan: string; n: number }>(),
    env.DB.prepare(
      `SELECT s.user_id, s.plan, s.status, u.plan AS user_plan FROM subscriptions s JOIN users u ON u.id = s.user_id
       WHERE s.id = (SELECT s2.id FROM subscriptions s2 WHERE s2.user_id = s.user_id ORDER BY s2.updated_at DESC, s2.id DESC LIMIT 1)
       ORDER BY s.updated_at DESC LIMIT ?`,
    )
      .bind(SUBSCRIPTION_SCAN + 1)
      .all<{ user_id: string; plan: string; status: string; user_plan: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users u WHERE u.plan != 'free' AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id)").first<{ n: number }>(),
    usageTotals(env, d1),
    usageTotals(env, d7),
    usageTotals(env, d30),
  ]);

  const truncated = latestSubs.results.length > SUBSCRIPTION_SCAN;
  const subs = latestSubs.results.slice(0, SUBSCRIPTION_SCAN);
  const byStatus = new Map<string, number>();
  const entitled = new Map<string, number>();
  let conflicts = 0;
  for (const s of subs) {
    byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
    const plan = entitledPlan(env, s);
    if (plan !== 'free') entitled.set(plan, (entitled.get(plan) ?? 0) + 1);
    if (plan !== s.user_plan) conflicts += 1;
  }
  const sortedCounts = (m: Map<string, number>, key: string) => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ [key]: k, users: n }));
  const paying = [...entitled.values()].reduce((a, b) => a + b, 0);
  const n = (v: number | null | undefined) => v ?? 0;

  return {
    generated_at: iso(ts),
    environment: env.ENVIRONMENT,
    windows: { last_24h: { since: iso(d1) }, last_7d: { since: iso(d7) }, last_30d: { since: iso(d30) }, until: iso(ts), timezone: 'UTC' },
    registered_users: { total: n(users?.total), suspended: n(users?.suspended), non_suspended: n(users?.total) - n(users?.suspended) },
    new_signups: {
      last_24h: n(signups?.d1),
      last_7d: n(signups?.d7),
      last_30d: n(signups?.d30),
      previous: { prior_24h: n(signups?.prev_d1), prior_7d: n(signups?.prev_d7), prior_30d: n(signups?.prev_d30) },
    },
    active_users: { dau: n(active?.dau), wau: n(active?.wau), mau: n(active?.mau), sources: ['usage_events (signed-in)', 'sessions (sign-ins)'] },
    usage_active_users: { last_24h: n(usageActive?.d1), last_7d: n(usageActive?.d7), last_30d: n(usageActive?.d30), anonymous_requests_30d: n(anonymous?.n) },
    activation: {
      activated_users: n(activated?.n),
      signups_last_30d: n(cohort?.signups),
      activated_of_signups_last_30d: n(cohort?.activated),
      rate_last_30d: cohort?.signups ? Math.round((n(cohort.activated) / cohort.signups) * 10_000) / 10_000 : null,
    },
    plans: {
      stored_plan: plans.results,
      paying_accounts: { total: paying, by_plan: sortedCounts(entitled, 'plan') },
      subscriptions_by_status: sortedCounts(byStatus, 'status'),
      plan_conflicts: { subscription_mismatch: conflicts, paid_plan_without_subscription: n(paidNoSub?.n) },
      subscription_scan: { users_read: subs.length, truncated },
    },
    usage: { last_24h: u1, last_7d: u7, last_30d: u30 },
    definitions: KPI_DEFINITIONS,
    data_coverage: DATA_COVERAGE,
  };
}

// ─── One user's activity (support context) ─────────────────────────────────

export const UserActivityQuery = z.object({
  userId: z.string().min(1).max(80),
  since: Timestamp.optional().describe('Default: 30 days ago; at most 30 days ago'),
  until: Timestamp.optional().describe('Default: now'),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(100).optional().describe('Events per page, default 20'),
});

/** Error texts can quote the URL that failed; the user's targets stay private. */
export function redactUrls(text: string | null): string | null {
  // Trailing sentence punctuation stays outside the redaction so the text still reads.
  return text ? text.replace(/\bhttps?:\/\/[^\s"'<>)]*[^\s"'<>).,;:!?]/gi, '[url]') : text;
}

interface EventRow {
  id: string;
  channel: string;
  kind: string;
  source: string;
  status: string;
  http_status: number;
  credits: number;
  duration_ms: number;
  trace_id: string | null;
  error: string | null;
  created_at: number;
}

/**
 * Aggregated activity of one user plus a page of event metadata. Targets (URLs and search queries)
 * are never returned: events carry a derived source category instead, and errors are truncated.
 */
export async function getUserActivity(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'users:read');
  const q = parseInput(UserActivityQuery, raw);
  const ts = now();
  const oldest = ts - MAX_WINDOW_DAYS * DAY;
  const since = q.since ?? ts - MAX_WINDOW_DAYS * DAY;
  const until = q.until ?? ts;
  if (since < oldest) throw new AdminError(`since must be within the last ${MAX_WINDOW_DAYS} days (on or after ${iso(oldest)}).`, 422, 'invalid_request', [{ path: 'since', message: `At most ${MAX_WINDOW_DAYS} days ago` }]);
  if (until <= since) throw new AdminError('until must be after since.', 422, 'invalid_request', [{ path: 'until', message: 'Must be after since' }]);
  const limit = clampLimit(q.limit, 20, 100);
  const user = await env.DB.prepare('SELECT id, role, status, plan, created_at, last_login_at FROM users WHERE id = ?')
    .bind(q.userId)
    .first<{ id: string; role: string; status: string; plan: string; created_at: number; last_login_at: number | null }>();
  if (!user) throw new AdminError('User not found. Find them with list_users.', 404, 'not_found');

  const where = 'user_id = ? AND created_at >= ? AND created_at < ?';
  const binds = [q.userId, since, until];
  const c = cursorClause(decodeCursor(q.cursor));
  const [groups, daily, last, docs, events] = await Promise.all([
    env.DB.prepare(
      `SELECT kind, channel, COUNT(*) AS n, COALESCE(SUM(credits),0) AS credits, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN status='cached' THEN 1 ELSE 0 END) AS cached, MIN(created_at) AS first_at, MAX(created_at) AS last_at
       FROM usage_events WHERE ${where} GROUP BY kind, channel ORDER BY n DESC`,
    )
      .bind(...binds)
      .all<{ kind: string; channel: string; n: number; credits: number; errors: number; cached: number; first_at: number; last_at: number }>(),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors FROM usage_events WHERE ${where} GROUP BY 1 ORDER BY 1`)
      .bind(...binds)
      .all<{ day: string; n: number; errors: number }>(),
    env.DB.prepare('SELECT MAX(created_at) AS at FROM usage_events WHERE user_id = ?').bind(q.userId).first<{ at: number | null }>(),
    env.DB.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM documents WHERE user_id = ?').bind(q.userId).first<{ n: number; last_at: number | null }>(),
    env.DB.prepare(
      `SELECT id, channel, kind, ${SOURCE_SQL} AS source, status, http_status, credits, duration_ms, trace_id, substr(error, 1, 200) AS error, created_at
       FROM usage_events WHERE ${where}${c.sql ? ` AND ${c.sql}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(...binds, ...c.binds, limit + 1)
      .all<EventRow>(),
  ]);
  const rows = groups.results;
  const sum = (k: 'n' | 'credits' | 'errors' | 'cached') => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const paged = page(events.results, limit);
  return {
    generated_at: iso(ts),
    window: { since: iso(since), until: iso(until), timezone: 'UTC' },
    user: { id: user.id, role: user.role, status: user.status, plan: user.plan, created_at: iso(user.created_at), last_login_at: iso(user.last_login_at) },
    totals: { requests: sum('n'), credits: sum('credits'), errors: sum('errors'), cached: sum('cached') },
    by_kind_channel: rows.map((r) => ({ kind: r.kind, channel: r.channel, requests: r.n, credits: r.credits, errors: r.errors, cached: r.cached, first_at: iso(r.first_at), last_at: iso(r.last_at) })),
    daily: daily.results,
    last_activity_at: iso(last?.at),
    library: { documents: docs?.n ?? 0, last_saved_at: iso(docs?.last_at) },
    events: { items: paged.items.map((e) => ({ ...e, error: redactUrls(e.error), at: iso(e.created_at) })), next_cursor: paged.next_cursor },
    notes: 'Event targets (URLs, search queries) and document contents are not returned. Use get_system_trace with a trace_id for timings.',
  };
}
