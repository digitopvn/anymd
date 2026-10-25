/**
 * Billing, read-only. Subscriptions and plans are owned by the billing provider (webhooks write
 * them); admins can inspect state and diagnose drift, but changes happen in the provider.
 * Diagnostics report whether secrets are configured as booleans and never return their values.
 */
import { z } from 'zod';
import { planForStatus as creemPlanForStatus } from '../../billing/creem';
import { polarPlanForStatus } from '../../billing/polar';
import { billingEnabled, providerName } from '../../billing/provider';
import type { Env, Principal } from '../../env';
import { now, safeJson } from '../../lib/util';
import { AdminError, assertScope, clampLimit, decodeCursor, encodeCursor, iso, parseInput, Timestamp, type Paged } from './shared';
import { redactUrls } from './stats';

interface SubscriptionRow {
  id: string;
  user_id: string;
  product_id: string;
  plan: string;
  billing_interval: string;
  status: string;
  current_period_start: number | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  created_at: number;
  updated_at: number;
  email?: string;
  user_plan?: string;
}

/** The plan the subscription entitles its user to under the live provider's status rules. */
export function entitledPlan(env: Env, sub: Pick<SubscriptionRow, 'status' | 'plan'>): string {
  return providerName(env) === 'Polar' ? polarPlanForStatus(sub.status, sub.plan) : creemPlanForStatus(sub.status, sub.plan);
}

function subscriptionView(env: Env, s: SubscriptionRow) {
  return {
    id: s.id,
    user_id: s.user_id,
    email: s.email ?? null,
    plan: s.plan,
    status: s.status,
    billing_interval: s.billing_interval,
    product_id: s.product_id,
    current_period_start: s.current_period_start,
    current_period_end: s.current_period_end,
    period_ends: iso(s.current_period_end),
    cancel_at_period_end: Boolean(s.cancel_at_period_end),
    created_at: s.created_at,
    updated_at: s.updated_at,
    entitled_plan: entitledPlan(env, s),
    ...(s.user_plan !== undefined ? { user_plan: s.user_plan } : {}),
  };
}

export const SubscriptionQuery = z.object({
  status: z.string().max(40).optional(),
  plan: z.string().max(40).optional(),
  userId: z.string().max(80).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/** Newest first (by creation, a stable order for keyset pagination). Needs `billing:read`. */
export async function listSubscriptions(env: Env, actor: Principal, raw: unknown): Promise<Paged<ReturnType<typeof subscriptionView>>> {
  assertScope(actor, 'billing:read');
  const q = parseInput(SubscriptionQuery, raw);
  const limit = clampLimit(q.limit, 25, 100);
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (q.status) parts.push('s.status = ?'), binds.push(q.status);
  if (q.plan) parts.push('s.plan = ?'), binds.push(q.plan);
  if (q.userId) parts.push('s.user_id = ?'), binds.push(q.userId);
  const cursor = decodeCursor(q.cursor);
  if (cursor) parts.push('(s.created_at < ? OR (s.created_at = ? AND s.id < ?))'), binds.push(cursor.ts, cursor.ts, cursor.id);
  const { results } = await env.DB.prepare(
    `SELECT s.*, u.email AS email, u.plan AS user_plan FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<SubscriptionRow>();
  const more = results.length > limit;
  const items = more ? results.slice(0, limit) : results;
  const last = items[items.length - 1];
  return { items: items.map((s) => subscriptionView(env, s)), next_cursor: more && last ? encodeCursor(last.created_at, last.id) : null };
}

/** One subscription with a plan-consistency check against the user's current plan. */
export async function getSubscription(env: Env, actor: Principal, subscriptionId: string) {
  assertScope(actor, 'billing:read');
  const s = await env.DB.prepare('SELECT s.*, u.email AS email, u.plan AS user_plan FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?').bind(subscriptionId).first<SubscriptionRow>();
  if (!s) throw new AdminError('Subscription not found. List them with list_subscriptions.', 404, 'not_found');
  const view = subscriptionView(env, s);
  const latest = await env.DB.prepare('SELECT id FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1').bind(s.user_id).first<{ id: string }>();
  const isLatest = latest?.id === s.id;
  return {
    subscription: view,
    consistency: {
      latest_for_user: isLatest,
      user_plan: s.user_plan ?? null,
      entitled_plan: view.entitled_plan,
      // Only the user's latest subscription decides their plan.
      consistent: !isLatest || s.user_plan === view.entitled_plan,
    },
  };
}

/**
 * Billing health without secrets: which provider is live, which secrets are configured (booleans),
 * recent webhook outcomes and users whose plan disagrees with their latest subscription.
 */
export async function getBillingDiagnostics(env: Env, actor: Principal) {
  assertScope(actor, 'billing:read');
  const since = now() - 7 * 86_400_000;
  const [webhooks, outcomes, failures, byStatus, latestSubs] = await Promise.all([
    env.DB.prepare('SELECT id, type, provider, outcome, received_at FROM webhook_events ORDER BY received_at DESC LIMIT 20').all<{ id: string; type: string; provider: string | null; outcome: string | null; received_at: number }>(),
    env.DB.prepare("SELECT COALESCE(outcome,'unknown') AS outcome, COUNT(*) AS n FROM webhook_events WHERE received_at >= ? GROUP BY 1 ORDER BY n DESC").bind(since).all<{ outcome: string; n: number }>(),
    env.DB.prepare("SELECT created_at, meta FROM audit_log WHERE action = 'billing.webhook_failed' AND created_at >= ? ORDER BY created_at DESC LIMIT 10").bind(since).all<{ created_at: number; meta: string }>(),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status ORDER BY n DESC').all<{ status: string; n: number }>(),
    // The latest subscription per user, to spot plan drift. Bounded to the most recently updated 500.
    env.DB.prepare(
      `SELECT s.id, s.user_id, s.plan, s.status, s.updated_at, u.plan AS user_plan, u.email AS email FROM subscriptions s JOIN users u ON u.id = s.user_id
       WHERE s.id = (SELECT s2.id FROM subscriptions s2 WHERE s2.user_id = s.user_id ORDER BY s2.updated_at DESC, s2.id DESC LIMIT 1)
       ORDER BY s.updated_at DESC LIMIT 500`,
    ).all<SubscriptionRow>(),
  ]);
  const drift = latestSubs.results
    .map((s) => ({ user_id: s.user_id, email: s.email ?? null, subscription: s.id, status: s.status, user_plan: s.user_plan ?? null, entitled_plan: entitledPlan(env, s) }))
    .filter((d) => d.user_plan !== d.entitled_plan)
    .slice(0, 50);
  return {
    provider: providerName(env),
    enabled: billingEnabled(env),
    server: providerName(env) === 'Polar' ? env.POLAR_SERVER : env.CREEM_SERVER,
    secrets: {
      POLAR_ACCESS_TOKEN: Boolean(env.POLAR_ACCESS_TOKEN),
      POLAR_WEBHOOK_SECRET: Boolean(env.POLAR_WEBHOOK_SECRET),
      CREEM_API_KEY: Boolean(env.CREEM_API_KEY),
      CREEM_WEBHOOK_SECRET: Boolean(env.CREEM_WEBHOOK_SECRET),
    },
    webhooks: {
      recent: webhooks.results.map((w) => ({ ...w, at: iso(w.received_at) })),
      outcomes_7d: outcomes.results,
      failures_7d: failures.results.map((f) => ({ at: iso(f.created_at), ...safeJson<Record<string, unknown>>(f.meta, {}) })),
    },
    subscriptions_by_status: byStatus.results,
    plan_drift: drift,
    notes: 'Read-only. Plans and subscriptions change only through the billing provider; use credit grants for support allowances.',
  };
}

// ─── Customer billing summary (support) ─────────────────────────────────────

/** `jane@example.com` → `j***@example.com`: enough to confirm an account without copying the address around. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** What anymd cannot answer about money, said once instead of returning placeholders. */
export const UNSUPPORTED_BILLING_RECORDS = {
  supported: false,
  records: ['orders', 'invoices', 'payments', 'refunds', 'customers'],
  reason: 'anymd stores subscriptions synced by webhook, not orders, invoices or payments. Look these up in the billing provider dashboard.',
} as const;

/**
 * One user's billing picture for support: stored plan, subscriptions with what they entitle, renewal
 * or cancellation, the provider customer link (present or not) and, with credits:read, recent grants.
 * Read-only; it composes the same rows list_subscriptions and list_credit_grants read.
 */
export async function getCustomerBillingSummary(env: Env, actor: Principal, userId: string) {
  assertScope(actor, 'billing:read');
  const user = await env.DB.prepare('SELECT id, email, role, status, plan, polar_customer_id, creem_customer_id, created_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; role: string; status: string; plan: string; polar_customer_id: string | null; creem_customer_id: string | null; created_at: number }>();
  if (!user) throw new AdminError('User not found. Find them with list_users.', 404, 'not_found');
  const withCredits = actor.scopes.includes('credits:read');
  const [subs, grants] = await Promise.all([
    env.DB.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 10').bind(userId).all<SubscriptionRow>(),
    withCredits
      ? env.DB.prepare('SELECT id, source, credits, reason, created_at, expires_at, revoked_at, recurring FROM credit_grants WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10')
          .bind(userId)
          .all<{ id: string; source: string; credits: number; reason: string; created_at: number; expires_at: number | null; revoked_at: number | null; recurring: number | null }>()
      : null,
  ]);
  const views = subs.results.map((s) => subscriptionView(env, s));
  const latest = views[0] ?? null;
  const entitled = latest?.entitled_plan ?? 'free';
  const ts = now();
  return {
    generated_at: iso(ts),
    provider: providerName(env),
    user: {
      id: user.id,
      email: maskEmail(user.email),
      role: user.role,
      status: user.status,
      stored_plan: user.plan,
      created_at: iso(user.created_at),
      provider_customer: { polar: Boolean(user.polar_customer_id), creem: Boolean(user.creem_customer_id) },
    },
    entitlement: {
      entitled_plan: entitled,
      consistent: user.plan === entitled,
      source: latest ? `subscription ${latest.id}` : 'no subscription',
      renewal: latest
        ? {
            status: latest.status,
            period_ends: latest.period_ends,
            cancel_at_period_end: latest.cancel_at_period_end,
            next: latest.cancel_at_period_end ? (latest.current_period_end && latest.current_period_end <= ts ? 'ended' : 'cancels at period end') : latest.current_period_end && latest.current_period_end > ts && entitled !== 'free' ? 'renews at period end' : 'not renewing',
          }
        : null,
    },
    subscriptions: views,
    credit_grants: grants
      ? grants.results.map((g) => ({
          ...g,
          recurring: Boolean(g.recurring),
          state: g.revoked_at ? 'revoked' : g.expires_at && g.expires_at <= ts ? 'expired' : 'active',
          created: iso(g.created_at),
          expires: iso(g.expires_at),
        }))
      : null,
    ...(grants ? {} : { credit_grants_note: 'Needs credits:read.' }),
    last_payment: { available: false, reason: 'Payments are not stored; check the billing provider.' },
    unsupported: UNSUPPORTED_BILLING_RECORDS,
    notes: 'Read-only. Plans change only through the billing provider; use grant_credits (owner) for support allowances.',
  };
}

// ─── Billing webhook events ─────────────────────────────────────────────────

export const BillingEventQuery = z.object({
  status: z.enum(['processed', 'failed']).optional().describe('processed (default): deliveries recorded with their outcome; failed: deliveries whose handling threw (kept in the audit log, retried by the provider)'),
  provider: z.enum(['polar', 'creem']).optional(),
  type: z.string().max(80).optional().describe('Exact event type, e.g. subscription.updated'),
  outcome: z.string().max(80).optional().describe('processed only: exact outcome'),
  since: Timestamp.optional().describe('Default: 30 days ago; at most 90 days ago'),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/** Webhook rows are kept; the window keeps scans bounded. */
const EVENT_WINDOW_DAYS = 90;

/** Provider errors can echo response bodies: URLs and email addresses are redacted before they are returned. */
const errorText = (v: unknown) => (typeof v === 'string' ? redactUrls(v.slice(0, 300))!.replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi, '[email]') : null);

export async function listBillingEvents(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'billing:read');
  const q = parseInput(BillingEventQuery, raw);
  const limit = clampLimit(q.limit, 25, 100);
  const ts = now();
  const oldest = ts - EVENT_WINDOW_DAYS * 86_400_000;
  if (q.since !== undefined && q.since < oldest) throw new AdminError(`since must be within the last ${EVENT_WINDOW_DAYS} days.`, 422, 'invalid_request', [{ path: 'since', message: `At most ${EVENT_WINDOW_DAYS} days ago` }]);
  const since = q.since ?? ts - 30 * 86_400_000;
  const cursor = decodeCursor(q.cursor);
  if ((q.status ?? 'processed') === 'processed') {
    const parts = ['received_at >= ?'];
    const binds: unknown[] = [since];
    if (q.provider) parts.push('provider = ?'), binds.push(q.provider);
    if (q.type) parts.push('type = ?'), binds.push(q.type);
    if (q.outcome) parts.push('outcome = ?'), binds.push(q.outcome);
    if (cursor) parts.push('(received_at < ? OR (received_at = ? AND id < ?))'), binds.push(cursor.ts, cursor.ts, cursor.id);
    const { results } = await env.DB.prepare(`SELECT id, type, provider, outcome, received_at FROM webhook_events WHERE ${parts.join(' AND ')} ORDER BY received_at DESC, id DESC LIMIT ?`)
      .bind(...binds, limit + 1)
      .all<{ id: string; type: string; provider: string | null; outcome: string | null; received_at: number }>();
    const more = results.length > limit;
    const items = more ? results.slice(0, limit) : results;
    const last = items[items.length - 1];
    return {
      status: 'processed',
      items: items.map((e) => ({ id: e.id, status: 'processed', provider: e.provider, type: e.type, outcome: e.outcome ?? 'unknown', at: iso(e.received_at) })),
      next_cursor: more && last ? encodeCursor(last.received_at, last.id) : null,
    };
  }
  if (q.outcome) throw new AdminError('outcome filters processed events only.', 422, 'invalid_request', [{ path: 'outcome', message: 'Only with status=processed' }]);
  const parts = ["action = 'billing.webhook_failed'", 'created_at >= ?'];
  const binds: unknown[] = [since];
  if (q.provider) parts.push("json_extract(meta, '$.provider') = ?"), binds.push(q.provider);
  if (q.type) parts.push("json_extract(meta, '$.event_type') = ?"), binds.push(q.type);
  if (cursor) parts.push('(created_at < ? OR (created_at = ? AND id < ?))'), binds.push(cursor.ts, cursor.ts, cursor.id);
  const { results } = await env.DB.prepare(`SELECT id, target, meta, created_at FROM audit_log WHERE ${parts.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<{ id: string; target: string; meta: string; created_at: number }>();
  const more = results.length > limit;
  const items = more ? results.slice(0, limit) : results;
  const last = items[items.length - 1];
  return {
    status: 'failed',
    items: items.map((r) => {
      const meta = safeJson<Record<string, unknown>>(r.meta, {});
      return { id: r.target, status: 'failed', provider: meta.provider ?? null, type: meta.event_type ?? null, error: errorText(meta.error), audit_id: r.id, at: iso(r.created_at) };
    }),
    next_cursor: more && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/**
 * One webhook delivery by its provider event id: the recorded outcome and every failed attempt.
 * A failure with no recorded row means the provider has not yet delivered it successfully.
 */
export async function getBillingEvent(env: Env, actor: Principal, eventId: string) {
  assertScope(actor, 'billing:read');
  const [row, failures] = await Promise.all([
    env.DB.prepare('SELECT id, type, provider, outcome, received_at FROM webhook_events WHERE id = ?').bind(eventId).first<{ id: string; type: string; provider: string | null; outcome: string | null; received_at: number }>(),
    env.DB.prepare("SELECT id, meta, created_at, request_id FROM audit_log WHERE target = ? AND action = 'billing.webhook_failed' ORDER BY created_at DESC LIMIT 20")
      .bind(eventId)
      .all<{ id: string; meta: string; created_at: number; request_id: string | null }>(),
  ]);
  if (!row && !failures.results.length) throw new AdminError('Billing event not found. List them with list_billing_events.', 404, 'not_found');
  const attempts = failures.results.map((f) => {
    const meta = safeJson<Record<string, unknown>>(f.meta, {});
    return { audit_id: f.id, at: iso(f.created_at), provider: meta.provider ?? null, type: meta.event_type ?? null, error: errorText(meta.error) };
  });
  return {
    id: eventId,
    status: row ? (attempts.length ? 'processed_after_failures' : 'processed') : 'failed_awaiting_retry',
    provider: row?.provider ?? attempts[0]?.provider ?? null,
    type: row?.type ?? attempts[0]?.type ?? null,
    outcome: row ? (row.outcome ?? 'unknown') : null,
    received_at: iso(row?.received_at),
    failed_attempts: attempts,
    notes: 'Payloads and signatures are not stored. Failed deliveries are retried by the provider; anymd keeps no copy to replay.',
  };
}
