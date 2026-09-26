// Creates (or reuses) everything anymd needs in a Creem store. Safe to re-run.
//
//   node --env-file=.env scripts/creem-setup.mjs --webhook https://staging.anymd.cc/api/webhooks/creem
//   node --env-file=.env scripts/creem-setup.mjs --production --webhook https://anymd.cc/api/webhooks/creem
//
// Reads CREEM_API_KEY against the test API (https://test-api.creem.io). With --production it reads
// CREEM_PRODUCTION_API_KEY against the live API instead, and saves the webhook as
// CREEM_PRODUCTION_WEBHOOK_URL / CREEM_PRODUCTION_WEBHOOK_SECRET (the names sync-secrets.mjs reads). Creates:
//   - Pro and Scale products, monthly and yearly, named `anymd Pro (monthly)` … so the Worker finds them
//   - LAUNCH30 and COMEBACK20 discount codes
//   - the webhook endpoint (with --webhook). Creem returns the signing secret once; it is written to
//     .env (never printed). Push it with `npm run secrets:<env>`.
// Prices come from src/billing/plans.ts; keep them in sync. Creem has no usage meter, so plans are flat.
import { readFileSync, writeFileSync } from 'node:fs';

const production = process.argv.includes('--production');
const prefix = production ? 'CREEM_PRODUCTION_' : 'CREEM_';
const key = process.env[`${prefix}API_KEY`];
const server = production ? 'https://api.creem.io' : 'https://test-api.creem.io';
if (!key) {
  console.error(`${prefix}API_KEY is not set. Run with: node --env-file=.env scripts/creem-setup.mjs`);
  process.exit(1);
}
console.log(`creem: ${new URL(server).host}`);
const webhookArg = process.argv.indexOf('--webhook');
const webhookUrl = webhookArg > -1 ? process.argv[webhookArg + 1] : null;

const PLANS = [
  { plan: 'pro', name: 'anymd Pro', credits: 10_000, monthly: 900, yearly: 8400 },
  { plan: 'scale', name: 'anymd Scale', credits: 100_000, monthly: 4900, yearly: 46800 },
];
const LAUNCH_ENDS = '2026-10-31T23:59:59Z';
const EVENTS = [
  'checkout.completed', 'subscription.active', 'subscription.paid', 'subscription.trialing', 'subscription.update',
  'subscription.canceled', 'subscription.scheduled_cancel', 'subscription.past_due', 'subscription.expired', 'subscription.paused',
];

async function creem(path, init = {}) {
  const res = await fetch(server + path, { ...init, headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
const post = (path, body) => creem(path, { method: 'POST', body: JSON.stringify(body) });
const items = (body) => (Array.isArray(body) ? body : body?.items ?? body?.data ?? []);

// Products
const products = items(await creem('/v1/products/search?page_number=1&page_size=100'));
const productIds = [];
for (const p of PLANS) {
  for (const interval of ['month', 'year']) {
    const name = `${p.name} (${interval === 'month' ? 'monthly' : 'yearly'})`;
    let prod = products.find((x) => x.name === name && x.status !== 'archived');
    if (!prod) {
      prod = await post('/v1/products', {
        name,
        description: `${p.credits.toLocaleString('en-US')} credits every month for converting web pages, videos and documents to Markdown.`,
        price: interval === 'month' ? p.monthly : p.yearly,
        currency: 'USD',
        billing_type: 'recurring',
        billing_period: interval === 'month' ? 'every-month' : 'every-year',
        tax_mode: 'exclusive',
        tax_category: 'saas',
      });
      console.log(`product ${name}: created`);
    } else console.log(`product ${name}: exists`);
    productIds.push(prod.id);
  }
}

// Discount codes (a missing discounts endpoint or scope should not block the rest)
const wanted = [
  { name: 'Launch offer', code: 'LAUNCH30', percentage: 30, expiry_date: LAUNCH_ENDS },
  { name: 'Welcome back', code: 'COMEBACK20', percentage: 20 },
];
for (const d of wanted) {
  const existing = await creem(`/v1/discounts?discount_code=${d.code}`).catch(() => null);
  if (existing?.id) {
    console.log(`discount ${d.code}: exists`);
    continue;
  }
  try {
    await post('/v1/discounts', { ...d, type: 'percentage', duration: 'once', applies_to_products: productIds });
    console.log(`discount ${d.code}: created`);
  } catch (e) {
    console.log(`discount ${d.code}: failed (${e.message.slice(0, 200)})`);
  }
}

// Webhook endpoint
if (webhookUrl) {
  const endpoints = items(await creem('/v1/webhooks').catch(() => []));
  if (endpoints.some((e) => e.url === webhookUrl)) {
    console.log('webhook: exists (secret unchanged)');
  } else {
    const endpoint = await post('/v1/webhooks', { url: webhookUrl, name: 'anymd', events: EVENTS });
    if (endpoint?.secret) {
      const env = readFileSync('.env', 'utf8');
      const set = (src, k, v) => (new RegExp(`^${k}=.*$`, 'm').test(src) ? src.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${src.trimEnd()}\n${k}=${v}\n`);
      writeFileSync('.env', set(set(env, `${prefix}WEBHOOK_URL`, webhookUrl), `${prefix}WEBHOOK_SECRET`, endpoint.secret));
      console.log(`webhook: created; signing secret saved to .env as ${prefix}WEBHOOK_SECRET`);
    } else console.log('webhook: created; copy the signing secret from Creem → Developers → Webhooks');
  }
}
console.log('done');
