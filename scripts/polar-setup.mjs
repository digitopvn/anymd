// Creates (or reuses) everything anymd needs in a Polar organization. Safe to re-run.
//
//   node --env-file=.env scripts/polar-setup.mjs --webhook https://staging.anymd.cc/api/webhooks/polar
//
// Reads POLAR_ACCESS_TOKEN and POLAR_ENVIRONMENT (sandbox | production). Creates:
//   - the `anymd_credits` meter (sum of metadata.credits over `anymd_credits` events)
//   - a monthly credit benefit per plan (the included credits)
//   - Pro and Scale products, monthly and yearly, tagged `anymd_plan` so the Worker finds them
//     (fixed price + metered overage price on the meter)
//   - LAUNCH30 and COMEBACK20 discount codes
//   - the webhook endpoint (with --webhook). Polar generates the signing secret; it is written to
//     .env as POLAR_WEBHOOK_SECRET (never printed). Push it with `wrangler secret put`.
// Prices and credits come from src/billing/plans.ts; keep them in sync.
import { readFileSync, writeFileSync } from 'node:fs';

const token = process.env.POLAR_ACCESS_TOKEN;
const server = process.env.POLAR_ENVIRONMENT === 'production' ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh';
if (!token) {
  console.error('POLAR_ACCESS_TOKEN is not set. Run with: node --env-file=.env scripts/polar-setup.mjs');
  process.exit(1);
}
const webhookArg = process.argv.indexOf('--webhook');
const webhookUrl = webhookArg > -1 ? process.argv[webhookArg + 1] : null;

const PLANS = [
  { plan: 'pro', name: 'anymd Pro', credits: 10_000, monthly: 900, yearly: 8400, overagePerCredit: 0.1 },
  { plan: 'scale', name: 'anymd Scale', credits: 100_000, monthly: 4900, yearly: 46800, overagePerCredit: 0.06 },
];
const METER = 'anymd_credits';
const LAUNCH_ENDS = '2026-10-31T23:59:59Z';
const EVENTS = ['checkout.updated', 'order.paid', 'order.refunded', 'subscription.created', 'subscription.updated', 'subscription.active', 'subscription.canceled', 'subscription.uncanceled', 'subscription.revoked', 'subscription.past_due'];

async function polar(path, init = {}) {
  const res = await fetch(server + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
const post = (path, body) => polar(path, { method: 'POST', body: JSON.stringify(body) });
const list = async (path) => (await polar(path + (path.includes('?') ? '&' : '?') + 'limit=100')).items;

// Meter
let meter = (await list('/v1/meters/')).find((m) => m.name === METER);
if (!meter) {
  meter = await post('/v1/meters/', {
    name: METER,
    filter: { conjunction: 'and', clauses: [{ property: 'name', operator: 'eq', value: METER }] },
    aggregation: { func: 'sum', property: 'metadata.credits' },
  });
  console.log(`meter ${METER}: created`);
} else console.log(`meter ${METER}: exists`);

// Included credits (one benefit per plan)
const benefits = await list('/v1/benefits/?type=meter_credit');
const benefitFor = {};
for (const p of PLANS) {
  const description = `${p.credits.toLocaleString('en-US')} credits / month`;
  let b = benefits.find((x) => x.description === description && x.properties?.meter_id === meter.id);
  if (!b) {
    b = await post('/v1/benefits/', { type: 'meter_credit', description, properties: { meter_id: meter.id, units: p.credits, rollover: false } });
    console.log(`benefit "${description}": created`);
  } else console.log(`benefit "${description}": exists`);
  benefitFor[p.plan] = b.id;
}

// Products
const products = await list('/v1/products/?is_archived=false');
const productIds = [];
for (const p of PLANS) {
  for (const interval of ['month', 'year']) {
    let prod = products.find((x) => x.metadata?.anymd_plan === p.plan && x.recurring_interval === interval);
    if (!prod) {
      prod = await post('/v1/products/', {
        name: `${p.name} (${interval === 'month' ? 'monthly' : 'yearly'})`,
        description: `${p.credits.toLocaleString('en-US')} credits every month. Overage billed per credit, never blocked.`,
        recurring_interval: interval,
        prices: [
          { amount_type: 'fixed', price_amount: interval === 'month' ? p.monthly : p.yearly, price_currency: 'usd' },
          { amount_type: 'metered_unit', meter_id: meter.id, unit_amount: p.overagePerCredit, price_currency: 'usd' },
        ],
        metadata: { anymd_plan: p.plan },
      });
      console.log(`product ${p.plan}/${interval}: created`);
    } else console.log(`product ${p.plan}/${interval}: exists`);
    if (!prod.benefits?.some((b) => b.id === benefitFor[p.plan])) {
      await post(`/v1/products/${prod.id}/benefits`, { benefits: [...(prod.benefits ?? []).map((b) => b.id), benefitFor[p.plan]] });
      console.log(`product ${p.plan}/${interval}: credits benefit attached`);
    }
    productIds.push(prod.id);
  }
}

// Discount codes
const discounts = await list('/v1/discounts/');
const wanted = [
  { name: 'Launch offer', code: 'LAUNCH30', basis_points: 3000, ends_at: LAUNCH_ENDS },
  { name: 'Welcome back', code: 'COMEBACK20', basis_points: 2000 },
];
for (const d of wanted) {
  if (discounts.some((x) => x.code === d.code)) {
    console.log(`discount ${d.code}: exists`);
    continue;
  }
  await post('/v1/discounts/', { ...d, type: 'percentage', duration: 'once', max_redemptions_per_customer: 1, products: productIds });
  console.log(`discount ${d.code}: created`);
}

// Webhook endpoint
if (webhookUrl) {
  const endpoints = await list('/v1/webhooks/endpoints');
  if (endpoints.some((e) => e.url === webhookUrl)) {
    console.log('webhook: exists (secret unchanged)');
  } else {
    const endpoint = await post('/v1/webhooks/endpoints', { url: webhookUrl, format: 'raw', events: EVENTS, name: 'anymd' });
    if (endpoint.secret) {
      const env = readFileSync('.env', 'utf8');
      const set = (src, key, value) => (new RegExp(`^${key}=.*$`, 'm').test(src) ? src.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${src.trimEnd()}\n${key}=${value}\n`);
      writeFileSync('.env', set(set(env, 'POLAR_WEBHOOK_URL', webhookUrl), 'POLAR_WEBHOOK_SECRET', endpoint.secret));
      console.log('webhook: created; signing secret saved to .env as POLAR_WEBHOOK_SECRET');
    } else console.log('webhook: created; copy the signing secret from the Polar dashboard');
  }
}
console.log('done');
