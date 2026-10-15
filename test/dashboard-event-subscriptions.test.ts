import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserRow } from '../src/auth/identity';
import type { AppBindings, Env } from '../src/env';
import { encryptSecret } from '../src/events/crypto';
import { dashboardRoutes } from '../src/routes/dashboard';
import { createTestEnv, seedUser, sessionOf, type TestEnv } from './helpers/sqlite-env';

const background: Promise<unknown>[] = [];
const execution = { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const ORIGIN = 'https://anymd.test';
// A public IP literal, so the delivery guard needs no DNS lookup.
const CALLBACK = 'https://93.184.215.14/hooks/anymd?token=query-secret';
const WEBHOOK_SECRET = `whsec_${btoa('w'.repeat(32))}`;

let t: TestEnv | null = null;
let fetchCalls: { url: string; body: string }[] = [];

function setup(overrides: Partial<Env> = { EVENTS_SECRET_KEY: 'test-events-key' }) {
  t = createTestEnv(overrides);
  fetchCalls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input instanceof Request ? input.url : input), body: String(init?.body ?? '') });
    return new Response(null, { status: 204 });
  });
  return t;
}

function client(env: TestEnv, user: UserRow) {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('principal', sessionOf(user, ['convert']));
    c.set('user', user);
    await next();
  });
  app.route('/dashboard', dashboardRoutes);
  // Settle work handed to waitUntil (the terminated notice) before the test looks at it.
  return async (path: string, init: RequestInit = {}) => {
    const res = await app.fetch(new Request(`${ORIGIN}${path}`, init), env.env, execution);
    await Promise.all(background.splice(0));
    return res;
  };
}

async function seedSubscription(env: TestEnv, user: UserRow, id: string, extra: { args?: string; active?: number; expiresAt?: number; lastError?: string | null; principal?: string } = {}) {
  const now = Date.now();
  env.db
    .prepare(
      `INSERT INTO event_subscriptions (id, user_id, principal, principal_hash, name, arguments_json, url, secret_enc, scope, active, expires_at, last_delivery_at, last_error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, user.id, extra.principal ?? 'api_key:key_1', 'hash', 'document.created', extra.args ?? '{}', CALLBACK, await encryptSecret(env.env, WEBHOOK_SECRET), 'library:read', extra.active ?? 1, extra.expiresAt ?? now + 30 * 60_000, null, extra.lastError ?? null, now, now);
}

const POST = { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' } satisfies RequestInit;

afterEach(() => {
  vi.unstubAllGlobals();
  t?.close();
  t = null;
});

describe('dashboard event subscriptions', () => {
  it('lists only the owner’s live subscriptions without secrets or callback query strings', async () => {
    const env = setup();
    const [owner, other] = [await seedUser(env, 'user'), await seedUser(env, 'user')];
    await seedSubscription(env, owner, 'sub_live', { args: '{"tag":"ai"}', lastError: 'http_5xx' });
    await seedSubscription(env, owner, 'sub_suspended', { active: 0, principal: 'oauth:grant_1' });
    await seedSubscription(env, owner, 'sub_expired', { expiresAt: Date.now() - 1000 });
    await seedSubscription(env, other, 'sub_other');

    const res = await client(env, owner)('/dashboard/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const html = await res.text();
    expect(html.includes('href="/dashboard/events"')).toBe(true);
    expect(html.includes('action="/dashboard/events/sub_live/delete"')).toBe(true);
    expect(html.includes('action="/dashboard/events/sub_suspended/delete"')).toBe(true);
    expect(html.includes('sub_expired')).toBe(false);
    expect(html.includes('sub_other')).toBe(false);
    expect(html.includes('93.184.215.14/hooks/anymd')).toBe(true);
    expect(html.includes('query-secret')).toBe(false);
    expect(html.includes('whsec_')).toBe(false);
    expect(html.includes('v1.')).toBe(false);
    expect(html.includes('document.created')).toBe(true);
    expect(html.includes('{&quot;tag&quot;:&quot;ai&quot;}')).toBe(true);
    expect(html.includes('Last error: http_5xx')).toBe(true);
    expect(html.includes('suspended')).toBe(true);
    expect(html.includes('Connected app')).toBe(true);
    expect(html.includes('API key')).toBe(true);
  });

  it('shows an empty state when there are no subscriptions', async () => {
    const env = setup();
    const owner = await seedUser(env, 'user');
    const html = await (await client(env, owner)('/dashboard/events')).text();
    expect(html.includes('No event subscriptions')).toBe(true);
  });

  it('deletes the owner’s subscription and tells its endpoint it was terminated', async () => {
    const env = setup();
    const owner = await seedUser(env, 'user');
    await seedSubscription(env, owner, 'sub_live');
    const call = client(env, owner);

    const res = await call('/dashboard/events/sub_live/delete', POST);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/dashboard/events?deleted=1');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM event_subscriptions').get()).toEqual({ n: 0 });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(CALLBACK);
    expect(JSON.parse(fetchCalls[0].body)).toMatchObject({ type: 'terminated', error: { data: { reason: 'deleted_by_owner' } } });

    const after = await (await call('/dashboard/events?deleted=1')).text();
    expect(after.includes('Subscription deleted.')).toBe(true);
  });

  it('treats another user’s or an unknown id as not found and leaves it in place', async () => {
    const env = setup();
    const [owner, other] = [await seedUser(env, 'user'), await seedUser(env, 'user')];
    await seedSubscription(env, other, 'sub_other');
    const call = client(env, owner);

    for (const id of ['sub_other', 'sub_missing', 'x'.repeat(200)]) {
      const res = await call(`/dashboard/events/${id}/delete`, POST);
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('/dashboard/events?deleted=0');
    }
    expect(env.db.prepare('SELECT id FROM event_subscriptions').all()).toEqual([{ id: 'sub_other' }]);
    expect(fetchCalls).toHaveLength(0);
    expect((await (await call('/dashboard/events?deleted=0')).text()).includes('no longer exists')).toBe(true);
  });

  it('blocks cross-origin deletes', async () => {
    const env = setup();
    const owner = await seedUser(env, 'user');
    await seedSubscription(env, owner, 'sub_live');
    const res = await client(env, owner)('/dashboard/events/sub_live/delete', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM event_subscriptions').get()).toEqual({ n: 1 });
    expect(fetchCalls).toHaveLength(0);
  });

  it('hides the page and nav entry when events are not configured', async () => {
    const env = setup({});
    const owner = await seedUser(env, 'user');
    const call = client(env, owner);
    expect((await call('/dashboard/events')).status).toBe(404);
    expect((await call('/dashboard/events/sub_live/delete', POST)).status).toBe(404);
    const overview = await (await call('/dashboard/traces')).text();
    expect(overview.includes('href="/dashboard/events"')).toBe(false);
  });
});
