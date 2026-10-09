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
import { AdminError, assertScope, clampLimit, decodeCursor, encodeCursor, iso, parseInput, type Paged } from './shared';

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
