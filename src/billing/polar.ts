/**
 * Polar.sh integration: checkout, customer portal, Standard Webhooks, and usage-event ingestion
 * for metered overage. Everything is gated on BILLING_PROVIDER=polar plus POLAR_ACCESS_TOKEN /
 * POLAR_WEBHOOK_SECRET. Products are discovered by metadata (`anymd_plan` = pro|scale) so no product ids live in config.
 */
import type { Env } from '../env';
import { newId, now } from '../lib/util';
import { extraCredits } from '../lib/usage';
import { meteredUnits, usedBeforeCharge } from './grant-covered-usage';
import { getPlan, type PlanId } from './plans';

export function polarEnabled(env: Env): boolean {
  return env.BILLING_PROVIDER === 'polar' && Boolean(env.POLAR_ACCESS_TOKEN);
}

function apiBase(env: Env): string {
  return env.POLAR_SERVER === 'production' ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh';
}

async function polarFetch<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(apiBase(env) + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Polar ${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface PolarProduct {
  id: string;
  name: string;
  is_archived: boolean;
  recurring_interval: 'month' | 'year' | null;
  metadata: Record<string, string | number | boolean>;
}

export async function planProducts(env: Env): Promise<{ plan: string; interval: string; id: string }[]> {
  const cached = await env.CACHE.get<{ plan: string; interval: string; id: string }[]>('polar:products', 'json');
  if (cached) return cached;
  const body = await polarFetch<{ items: PolarProduct[] }>(env, '/v1/products/?limit=100&is_archived=false');
  const mapped = body.items
    .filter((p) => p.metadata?.anymd_plan && p.recurring_interval)
    .map((p) => ({ plan: String(p.metadata.anymd_plan), interval: p.recurring_interval!, id: p.id }));
  await env.CACHE.put('polar:products', JSON.stringify(mapped), { expirationTtl: 600 });
  return mapped;
}

export async function createCheckout(
  env: Env,
  user: { id: string; email: string; name: string },
  plan: PlanId,
  interval: 'month' | 'year',
): Promise<string> {
  const products = await planProducts(env);
  const product = products.find((p) => p.plan === plan && p.interval === interval);
  if (!product) throw new Error(`No Polar product configured for ${plan}/${interval}. Run scripts/polar-setup.mjs.`);
  const checkout = await polarFetch<{ url: string }>(env, '/v1/checkouts/', {
    method: 'POST',
    body: JSON.stringify({
      products: [product.id],
      customer_email: user.email,
      customer_name: user.name || undefined,
      external_customer_id: user.id,
      allow_discount_codes: true,
      success_url: `${env.PUBLIC_URL}/dashboard/billing?checkout=success&checkout_id={CHECKOUT_ID}`,
      metadata: { user_id: user.id, plan, interval },
    }),
  });
  return checkout.url;
}

export async function customerPortalUrl(env: Env, userId: string): Promise<string> {
  const session = await polarFetch<{ customer_portal_url: string }>(env, '/v1/customer-sessions/', {
    method: 'POST',
    body: JSON.stringify({ external_customer_id: userId }),
  });
  return session.customer_portal_url;
}

/**
 * Report spent credits so Polar's meter can bill overage on paid plans. Units covered by active
 * credit grants are left out (see `meteredUnits`): Polar's benefit covers the plan's included
 * credits, but it does not know about grants. `chargeId` locates the conversion within the month.
 */
export async function ingestPolarUsage(env: Env, userId: string, credits: number, kind: string, chargeId?: string): Promise<void> {
  if (!polarEnabled(env)) return;
  const user = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(userId).first<{ plan: string }>();
  if (!user || user.plan === 'free') return;
  const [usedBefore, granted] = await Promise.all([usedBeforeCharge(env, userId, credits, chargeId), extraCredits(env, userId)]);
  const units = meteredUnits({ usedBefore, credits, included: getPlan(user.plan).credits, granted });
  if (!units) return;
  await polarFetch(env, '/v1/events/ingest', {
    method: 'POST',
    body: JSON.stringify({ events: [{ name: 'anymd_credits', external_customer_id: userId, metadata: { credits: units, kind } }] }),
  });
}

// ─── Webhooks (Standard Webhooks signature) ──────────────────────────────────

function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPolarWebhook(env: Env, headers: Headers, body: string): Promise<boolean> {
  const secret = env.POLAR_WEBHOOK_SECRET;
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!secret || !id || !timestamp || !signatures) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  // Polar signs with the raw secret bytes (its SDK base64-encodes the secret before handing it to standardwebhooks).
  const keyBytes = secret.startsWith('whsec_') ? b64ToBytes(secret.slice(6)) : new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return signatures.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig && timingSafeEqual(b64ToBytes(sig), mac);
  });
}

interface PolarSubscription {
  id: string;
  status: string;
  product_id: string;
  recurring_interval: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  metadata?: Record<string, unknown>;
  customer: { id: string; external_id: string | null; email: string };
  product?: { metadata?: Record<string, unknown> };
}

const ACTIVE = new Set(['active', 'trialing']);

/** The plan a Polar subscription status entitles the user to. */
export function polarPlanForStatus(status: string, plan: string): string {
  return ACTIVE.has(status) ? plan : 'free';
}

export async function handlePolarEvent(env: Env, webhookId: string, event: { type: string; data: unknown }): Promise<string> {
  const seen = await env.DB.prepare('SELECT id FROM webhook_events WHERE id = ?').bind(webhookId).first();
  if (seen) return 'duplicate';
  await env.DB.prepare('INSERT INTO webhook_events (id,type,received_at,provider) VALUES (?,?,?,?)').bind(webhookId, event.type, now(), 'polar').run();

  if (event.type.startsWith('subscription.')) {
    const sub = event.data as PolarSubscription;
    const userId =
      sub.customer.external_id ??
      (sub.metadata?.user_id as string | undefined) ??
      (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(sub.customer.email.toLowerCase()).first<{ id: string }>())?.id;
    if (!userId) return 'unknown_customer';
    const products = await planProducts(env).catch(() => []);
    const plan = String(sub.product?.metadata?.anymd_plan ?? products.find((p) => p.id === sub.product_id)?.plan ?? 'pro');
    const ts = now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subscriptions (id,user_id,product_id,plan,billing_interval,status,current_period_start,current_period_end,cancel_at_period_end,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, plan=excluded.plan, product_id=excluded.product_id, billing_interval=excluded.billing_interval,
           current_period_start=excluded.current_period_start, current_period_end=excluded.current_period_end,
           cancel_at_period_end=excluded.cancel_at_period_end, updated_at=excluded.updated_at`,
      ).bind(
        sub.id, userId, sub.product_id, plan, sub.recurring_interval, sub.status,
        sub.current_period_start ? Date.parse(sub.current_period_start) : null,
        sub.current_period_end ? Date.parse(sub.current_period_end) : null,
        sub.cancel_at_period_end ? 1 : 0, ts, ts,
      ),
      env.DB.prepare('UPDATE users SET plan = ?, polar_customer_id = ?, updated_at = ? WHERE id = ?').bind(polarPlanForStatus(sub.status, plan), sub.customer.id, ts, userId),
      env.DB.prepare("INSERT INTO audit_log (id,actor,action,target,meta,created_at,auth_kind,target_type,via) VALUES (?,?,?,?,?,?,'system','user','webhook:polar')").bind(
        newId('aud_'), 'polar', event.type, userId, JSON.stringify({ subscription: sub.id, status: sub.status, plan }), ts,
      ),
    ]);
    return 'subscription_synced';
  }
  return 'ignored';
}
