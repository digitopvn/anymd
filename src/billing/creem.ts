/**
 * Creem.io integration: checkout, customer portal and signed webhooks. Gated on BILLING_PROVIDER=creem
 * plus CREEM_API_KEY / CREEM_WEBHOOK_SECRET. Creem has no usage meter, so paid plans stop at their
 * included credits. Products are found by name (`anymd Pro (monthly)` …), created by scripts/creem-setup.mjs.
 */
import type { Env } from '../env';
import { newId, now } from '../lib/util';
import type { PlanId } from './plans';

export function creemEnabled(env: Env): boolean {
  return env.BILLING_PROVIDER === 'creem' && Boolean(env.CREEM_API_KEY);
}

function apiBase(env: Env): string {
  return env.CREEM_SERVER === 'production' ? 'https://api.creem.io' : 'https://test-api.creem.io';
}

async function creemFetch<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(apiBase(env) + path, {
    ...init,
    headers: { 'x-api-key': env.CREEM_API_KEY!, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Creem ${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface CreemProduct {
  id: string;
  name: string;
  status?: string;
  billing_type?: string;
  billing_period?: string;
}

type PlanProduct = { plan: string; interval: 'month' | 'year'; id: string };

/** `anymd Pro (monthly)` → { plan: 'pro', interval: 'month' }. Shared with the setup script's naming. */
export function parseProductName(name: string): { plan: string; interval: 'month' | 'year' } | null {
  const m = /^anymd (pro|scale) \((monthly|yearly)\)$/i.exec(name.trim());
  return m ? { plan: m[1].toLowerCase(), interval: m[2].toLowerCase() === 'yearly' ? 'year' : 'month' } : null;
}

export async function planProducts(env: Env): Promise<PlanProduct[]> {
  const cached = await env.CACHE.get<PlanProduct[]>('creem:products', 'json');
  if (cached) return cached;
  const body = await creemFetch<{ items: CreemProduct[] }>(env, '/v1/products/search?page_number=1&page_size=100');
  const mapped = body.items
    .filter((p) => p.status !== 'archived' && p.billing_type === 'recurring')
    .flatMap((p) => {
      const parsed = parseProductName(p.name);
      return parsed ? [{ ...parsed, id: p.id }] : [];
    });
  await env.CACHE.put('creem:products', JSON.stringify(mapped), { expirationTtl: 600 });
  return mapped;
}

export async function createCheckout(
  env: Env,
  user: { id: string; email: string },
  plan: PlanId,
  interval: 'month' | 'year',
): Promise<string> {
  const product = (await planProducts(env)).find((p) => p.plan === plan && p.interval === interval);
  if (!product) throw new Error(`No Creem product configured for ${plan}/${interval}. Run scripts/creem-setup.mjs.`);
  const checkout = await creemFetch<{ checkout_url: string }>(env, '/v1/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      product_id: product.id,
      request_id: newId('chk_'),
      success_url: `${env.PUBLIC_URL}/dashboard/billing?checkout=success`,
      customer: { email: user.email },
      metadata: { referenceId: user.id, plan, interval },
    }),
  });
  return checkout.checkout_url;
}

export async function customerPortalUrl(env: Env, userId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT creem_customer_id FROM users WHERE id = ?').bind(userId).first<{ creem_customer_id: string | null }>();
  if (!row?.creem_customer_id) throw new Error('No Creem customer for this user');
  const portal = await creemFetch<{ customer_portal_link: string }>(env, '/v1/customers/billing', {
    method: 'POST',
    body: JSON.stringify({ customer_id: row.creem_customer_id }),
  });
  return portal.customer_portal_link;
}

// ─── Webhooks (HMAC-SHA256 of the raw body, hex, in `creem-signature`) ──────

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyCreemWebhook(env: Env, signature: string | undefined | null, body: string): Promise<boolean> {
  const secret = env.CREEM_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(hex, signature.trim().toLowerCase());
}

type Ref = string | { id: string; email?: string; name?: string; billing_period?: string } | null | undefined;

interface CreemSubscription {
  id: string;
  object?: string;
  status: string;
  product: Ref;
  customer: Ref;
  current_period_start_date?: string | null;
  current_period_end_date?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreemEvent {
  id: string;
  eventType: string;
  created_at?: number;
  object: Record<string, unknown>;
}

/** Statuses that keep the paid plan: paying, trialing, retrying a failed charge, or cancelling at period end. */
const KEEPS_ACCESS = new Set(['active', 'trialing', 'paid', 'past_due', 'scheduled_cancel']);

export function planForStatus(status: string, plan: string): string {
  return KEEPS_ACCESS.has(status) ? plan : 'free';
}

const refId = (r: Ref) => (typeof r === 'string' ? r : r?.id ?? null);

async function resolveUser(env: Env, metadata: Record<string, unknown> | null | undefined, customer: Ref): Promise<string | null> {
  const ref = metadata?.referenceId;
  if (typeof ref === 'string' && ref && (await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(ref).first())) return ref;
  const customerId = refId(customer);
  if (customerId) {
    const row = await env.DB.prepare('SELECT id FROM users WHERE creem_customer_id = ?').bind(customerId).first<{ id: string }>();
    if (row) return row.id;
  }
  const email = typeof customer === 'object' ? customer?.email : undefined;
  if (email) return (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first<{ id: string }>())?.id ?? null;
  return null;
}

export async function handleCreemEvent(env: Env, event: CreemEvent): Promise<string> {
  const seen = await env.DB.prepare('SELECT id FROM webhook_events WHERE id = ?').bind(event.id).first();
  if (seen) return 'duplicate';
  await env.DB.prepare('INSERT INTO webhook_events (id,type,received_at) VALUES (?,?,?)').bind(event.id, event.eventType, now()).run();
  const ts = now();

  if (event.eventType === 'checkout.completed') {
    // Links the Creem customer to the user so the portal works; the plan itself follows subscription events.
    const obj = event.object as { customer?: Ref; metadata?: Record<string, unknown> | null };
    const userId = await resolveUser(env, obj.metadata, obj.customer);
    const customerId = refId(obj.customer);
    if (!userId || !customerId) return 'unknown_customer';
    await env.DB.prepare('UPDATE users SET creem_customer_id = ?, updated_at = ? WHERE id = ?').bind(customerId, ts, userId).run();
    return 'customer_linked';
  }

  if (event.eventType.startsWith('subscription.')) {
    const sub = event.object as unknown as CreemSubscription;
    const userId = await resolveUser(env, sub.metadata, sub.customer);
    if (!userId) return 'unknown_customer';
    const productId = refId(sub.product);
    const productName = typeof sub.product === 'object' ? sub.product?.name : undefined;
    const known = (await planProducts(env).catch(() => [])).find((p) => p.id === productId);
    const parsed = productName ? parseProductName(productName) : null;
    const plan = known?.plan ?? parsed?.plan ?? (typeof sub.metadata?.plan === 'string' ? sub.metadata.plan : 'pro');
    const interval =
      known?.interval ?? parsed?.interval ?? (typeof sub.product === 'object' && sub.product?.billing_period === 'every-year' ? 'year' : 'month');
    const at = (d?: string | null) => (d ? Date.parse(d) : null);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subscriptions (id,user_id,product_id,plan,billing_interval,status,current_period_start,current_period_end,cancel_at_period_end,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, plan=excluded.plan, product_id=excluded.product_id, billing_interval=excluded.billing_interval,
           current_period_start=excluded.current_period_start, current_period_end=excluded.current_period_end,
           cancel_at_period_end=excluded.cancel_at_period_end, updated_at=excluded.updated_at`,
      ).bind(
        sub.id, userId, productId, plan, interval, sub.status,
        at(sub.current_period_start_date), at(sub.current_period_end_date),
        sub.status === 'scheduled_cancel' ? 1 : 0, ts, ts,
      ),
      env.DB.prepare('UPDATE users SET plan = ?, creem_customer_id = COALESCE(?, creem_customer_id), updated_at = ? WHERE id = ?').bind(
        planForStatus(sub.status, plan), refId(sub.customer), ts, userId,
      ),
      env.DB.prepare('INSERT INTO audit_log (id,actor,action,target,meta,created_at) VALUES (?,?,?,?,?,?)').bind(
        newId('aud_'), 'creem', event.eventType, userId, JSON.stringify({ subscription: sub.id, status: sub.status, plan }), ts,
      ),
    ]);
    return 'subscription_synced';
  }
  return 'ignored';
}
