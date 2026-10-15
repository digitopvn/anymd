/**
 * Admin access discovery, KPIs, support billing views and incident diagnostics, over MCP and REST,
 * against every migration in an in-memory database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { principalFromApiKey, type UserRow } from '../src/auth/identity';
import { consentGrantScopes } from '../src/auth/consent';
import { ADMIN_SCOPES, capScopes, KEY_PRESETS, OAUTH_DEFAULT_SCOPES, OAUTH_GRANT_VERSION, oauthPrincipalScopes, scopesForRole } from '../src/auth/roles';
import type { Principal, RoleName, Scope } from '../src/env';
import { MCP_TOOL_CATALOG } from '../src/mcp/server';
import { maskEmail } from '../src/services/admin/billing';
import { redactUrls } from '../src/services/admin/stats';
import { app } from '../src/worker';
import { callTool, ctx, rpc, toolNames } from './helpers/mcp-client';
import { counter, createTestEnv, seedKey, seedUser, type TestEnv } from './helpers/sqlite-env';

const DAY = 86_400_000;
const NEW_READ_TOOLS = ['get_user_stats', 'get_user_activity', 'get_operations_health', 'list_failed_jobs', 'get_job', 'get_customer_billing_summary', 'list_billing_events', 'get_billing_event'];

let t: TestEnv;
let owner: UserRow;
let customer: UserRow;
beforeEach(async () => {
  t = createTestEnv({ RL_MCP: counter(), RL_MCP_MUTATION: counter() } as never);
  owner = await seedUser(t, 'owner');
  customer = await seedUser(t, 'user', { plan: 'pro' });
});
afterEach(() => t.close());

const as = (user: UserRow, kind: Principal['kind'], scopes: Scope[], extra: Partial<Principal> = {}): Principal => ({ kind, userId: user.id, role: user.role as RoleName, scopes, requestId: 'req', ...extra });
const structured = (r: { result: { structuredContent?: any } }) => r.result.structuredContent;

let seq = 0;
function usage(userId: string | null, at: number, extra: { kind?: string; status?: string; target?: string; error?: string; channel?: string } = {}) {
  seq += 1;
  t.db
    .prepare('INSERT INTO usage_events (id,user_id,channel,kind,target,status,credits,created_at,error) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(`ue_${seq}`, userId, extra.channel ?? 'mcp', extra.kind ?? 'convert', extra.target ?? 'https://example.com/private', extra.status ?? 'ok', 1, at, extra.error ?? null);
}
function session(userId: string, at: number) {
  seq += 1;
  t.db.prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(`s_${seq}`, userId, at, at + DAY);
}
function document(userId: string) {
  seq += 1;
  t.db.prepare('INSERT INTO documents (id,user_id,url,url_hash,markdown,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(`d_${seq}`, userId, 'https://example.com', `h${seq}`, '# x', Date.now(), Date.now());
}

describe('get_admin_access_status', () => {
  it('is visible to every signed-in caller, even a key with a single unrelated scope', async () => {
    const tool = MCP_TOOL_CATALOG.find((x) => x.name === 'get_admin_access_status');
    expect(tool?.scope).toBeNull();
    expect(tool?.annotations.readOnlyHint).toBe(true);
    for (const scopes of [['feedback:write'], ['convert'], OAUTH_DEFAULT_SCOPES] as Scope[][]) {
      expect((await toolNames(t.env, as(customer, 'api_key', scopes, { apiKeyId: 'k' }))).includes('get_admin_access_status')).toBe(true);
    }
  });

  it('tells a user-role caller only that the role has no admin access', async () => {
    const r = structured(await callTool(t.env, as(customer, 'oauth', capScopes('user', OAUTH_DEFAULT_SCOPES), { clientId: 'c' }), 'get_admin_access_status'));
    expect(r.state).toBe('not_eligible');
    expect(r.admin).toBeNull();
    expect(JSON.stringify(r).includes('system_overview')).toBe(false);
    expect(r.caller).toMatchObject({ user_id: customer.id, role: 'user', auth_kind: 'oauth' });
  });

  it('distinguishes an owner OAuth grant without admin scopes and gives a step-up scope and consent steps', async () => {
    const scopes = oauthPrincipalScopes('owner', OAUTH_DEFAULT_SCOPES, OAUTH_GRANT_VERSION);
    const r = structured(await callTool(t.env, as(owner, 'oauth', scopes, { clientId: 'c' }), 'get_admin_access_status'));
    expect(r.state).toBe('not_granted');
    expect(r.diagnosis).toMatch(/OAuth connection holds no admin scopes/);
    expect(r.admin.tools_available).toEqual([]);
    expect(r.admin.tools_after_reauthorization.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['system_overview', 'get_user_stats', 'update_user_role']));
    expect(r.admin.how_to_fix.step_up.scope.split(' ')).toEqual(expect.arrayContaining(['convert', 'system:read', 'users:read', 'billing:read']));
    expect(r.admin.how_to_fix.step_up.scope.split(' ').filter((s: string) => ADMIN_SCOPES.has(s as Scope) && s.endsWith(':write'))).toEqual([]);
    expect(r.admin.presets.map((p: { id: string }) => p.id)).toEqual(['admin-read-only', 'support']);
  });

  it('distinguishes an owner API key without admin scopes', async () => {
    const r = structured(await callTool(t.env, as(owner, 'api_key', ['convert'], { apiKeyId: 'k1' }), 'get_admin_access_status'));
    expect(r.state).toBe('not_granted');
    expect(r.diagnosis).toMatch(/API key holds no admin scopes/);
    expect(r.admin.how_to_fix.steps[0]).toMatch(/admin-read-only/);
    expect(r.caller.api_key_id).toBe('k1');
  });

  it('reports partial and full access', async () => {
    const readOnly = capScopes('owner', KEY_PRESETS.find((p) => p.id === 'admin-read-only')!.scopes);
    const partial = structured(await callTool(t.env, as(owner, 'api_key', readOnly, { apiKeyId: 'k' }), 'get_admin_access_status'));
    expect(partial.state).toBe('partial');
    expect(partial.admin.tools_available).toEqual(expect.arrayContaining(['system_overview', 'get_user_stats']));
    expect(partial.admin.missing).toEqual(expect.arrayContaining(['users:roles:write']));
    const full = structured(await callTool(t.env, as(owner, 'session', scopesForRole('owner')), 'get_admin_access_status'));
    expect(full.state).toBe('full');
    expect(full.admin.how_to_fix).toBeNull();
  });

  it('is served over REST to any signed-in caller', async () => {
    const key = (await seedKey(t, customer, ['convert'])).key;
    const res = await app.fetch(new Request('https://anymd.test/api/v1/admin/access', { headers: { authorization: `Bearer ${key}` } }), t.env, ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'not_eligible', admin: null });
    const anon = await app.fetch(new Request('https://anymd.test/api/v1/admin/access'), t.env, ctx as never);
    expect(anon.status).toBe(401);
  });
});

describe('reconnecting with admin consent, and demotion', () => {
  it('exposes admin tools after consent with a preset, returns the real user count, and drops them on demotion', async () => {
    const before = oauthPrincipalScopes('owner', consentGrantScopes('owner', [], undefined), OAUTH_GRANT_VERSION);
    expect((await toolNames(t.env, as(owner, 'oauth', before, { clientId: 'c' }))).includes('system_overview')).toBe(false);
    const granted = consentGrantScopes('owner', [], 'admin-read-only');
    const after = oauthPrincipalScopes('owner', granted, OAUTH_GRANT_VERSION);
    const names = await toolNames(t.env, as(owner, 'oauth', after, { clientId: 'c' }));
    expect(names).toEqual(expect.arrayContaining(['system_overview', ...NEW_READ_TOOLS]));
    expect(names.includes('update_user_role')).toBe(false);
    const overview = structured(await callTool(t.env, as(owner, 'oauth', after, { clientId: 'c' }), 'system_overview'));
    const total = (t.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    expect(overview.users.total).toBe(total);
    // The MCP handler re-caps the stored grant by the current role on every call.
    const demoted = oauthPrincipalScopes('user', granted, OAUTH_GRANT_VERSION);
    expect((await toolNames(t.env, { ...as(owner, 'oauth', demoted, { clientId: 'c' }), role: 'user' })).filter((n) => NEW_READ_TOOLS.includes(n) || n === 'system_overview')).toEqual([]);
  });

  it('never lets a user-role tools/call reach the new tools', async () => {
    const p = as(customer, 'session', scopesForRole('user'));
    for (const name of NEW_READ_TOOLS) {
      const r = await callTool(t.env, p, name, { userId: customer.id, jobId: 'x', eventId: 'x' });
      expect(r.result.isError, name).toBe(true);
      expect(r.result.structuredContent.error.code, name).toBe('forbidden');
    }
  });

  it('keeps a support agent (admin role, support preset) away from roles and money', async () => {
    const admin = await seedUser(t, 'admin');
    const { key } = await seedKey(t, admin, KEY_PRESETS.find((p) => p.id === 'support')!.scopes);
    const p = (await principalFromApiKey(t.env, key, ctx as never))!;
    const names = await toolNames(t.env, p);
    expect(names).toEqual(expect.arrayContaining(['get_customer_billing_summary', 'list_billing_events', 'get_user_activity']));
    for (const n of ['update_user_role', 'grant_credits', 'revoke_credit_grant', 'get_user_stats']) expect(names.includes(n)).toBe(false);
    const summary = structured(await callTool(t.env, p, 'get_customer_billing_summary', { userId: customer.id }));
    expect(summary.user.email).toBe(maskEmail(customer.email));
    const denied = await callTool(t.env, p, 'grant_credits', { userId: customer.id, credits: 5, reason: 'x', idempotencyKey: 'support-grant-1' });
    expect(denied.result.structuredContent.error.code).toBe('forbidden');
  });
});

describe('get_user_stats', () => {
  it('counts registered, signups, DAU/WAU/MAU, usage-active, activation and plans with definitions', async () => {
    const now = Date.now();
    const old = await seedUser(t, 'user', { createdAt: now - 40 * DAY });
    const week = await seedUser(t, 'user', { createdAt: now - 3 * DAY });
    // customer and owner were created within the last day.
    usage(customer.id, now - 2 * 3_600_000);
    usage(customer.id, now - 5 * DAY);
    usage(week.id, now - 3 * DAY);
    usage(null, now - 3_600_000);
    usage(old.id, now - 45 * DAY); // outside every window
    session(old.id, now - 20 * DAY); // sign-in only: active, not usage-active
    document(customer.id);
    document(old.id);
    t.db.prepare("INSERT INTO subscriptions (id,user_id,product_id,plan,status,created_at,updated_at) VALUES ('sub_1',?, 'p','pro','active',?,?)").run(customer.id, now, now);
    t.db.prepare("UPDATE users SET plan = 'scale' WHERE id = ?").run(week.id); // paid stored plan, no subscription

    const r = structured(await callTool(t.env, as(owner, 'session', scopesForRole('owner')), 'get_user_stats'));
    expect(r.registered_users.total).toBe(4);
    expect(r.new_signups).toMatchObject({ last_24h: 2, last_7d: 3, last_30d: 3 });
    expect(r.new_signups.previous.prior_30d).toBe(1);
    expect(r.active_users).toMatchObject({ dau: 1, wau: 2, mau: 3 });
    expect(r.usage_active_users).toMatchObject({ last_24h: 1, last_7d: 2, last_30d: 2, anonymous_requests_30d: 1 });
    expect(r.activation).toMatchObject({ activated_users: 2, signups_last_30d: 3, activated_of_signups_last_30d: 1 });
    expect(r.plans.paying_accounts).toMatchObject({ total: 1, by_plan: [{ plan: 'pro', users: 1 }] });
    expect(r.plans.plan_conflicts).toMatchObject({ subscription_mismatch: 0, paid_plan_without_subscription: 1 });
    expect(r.usage.last_30d.requests).toBe(4);
    expect(Object.keys(r.definitions)).toEqual(expect.arrayContaining(['registered_users', 'active_users', 'usage_active_users', 'activated_users', 'paying_accounts']));
    expect(r.windows.timezone).toBe('UTC');
    expect(typeof r.generated_at).toBe('string');
    expect("revenue" in r || "mrr" in r).toBe(false);
  });

  it('answers on an empty deployment without dividing by zero', async () => {
    t.db.exec('DELETE FROM users');
    const r = structured(await callTool(t.env, as(owner, 'session', scopesForRole('owner')), 'get_user_stats'));
    expect(r.registered_users.total).toBe(0);
    expect(r.activation.rate_last_30d).toBeNull();
    expect(r.active_users).toMatchObject({ dau: 0, wau: 0, mau: 0 });
  });

  it('is served over REST with system:read only', async () => {
    const { key } = await seedKey(t, owner, ['system:read']);
    const ok = await app.fetch(new Request('https://anymd.test/api/v1/admin/system/stats', { headers: { authorization: `Bearer ${key}` } }), t.env, ctx as never);
    expect(ok.status).toBe(200);
    const { key: other } = await seedKey(t, owner, ['users:read']);
    const denied = await app.fetch(new Request('https://anymd.test/api/v1/admin/system/stats', { headers: { authorization: `Bearer ${other}` } }), t.env, ctx as never);
    expect(denied.status).toBe(403);
  });
});

describe('get_user_activity', () => {
  it('aggregates, pages events and never returns targets or URLs from errors', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) usage(customer.id, now - i * 60_000, { kind: i % 2 ? 'search' : 'convert' });
    usage(customer.id, now - 10 * 60_000, { status: 'error', error: 'fetch failed for https://secret.example.com/path?q=1' });
    const p = as(owner, 'session', scopesForRole('owner'));
    const first = structured(await callTool(t.env, p, 'get_user_activity', { userId: customer.id, limit: 4 }));
    expect(first.totals).toMatchObject({ requests: 6, errors: 1 });
    expect(first.by_kind_channel.length).toBe(2);
    expect(first.events.items).toHaveLength(4);
    expect(first.events.next_cursor).toBeTruthy();
    const second = structured(await callTool(t.env, p, 'get_user_activity', { userId: customer.id, limit: 4, cursor: first.events.next_cursor }));
    expect(second.events.items).toHaveLength(2);
    expect(second.events.next_cursor).toBeNull();
    const text = JSON.stringify([first, second]);
    expect(text.includes('example.com')).toBe(false);
    expect(second.events.items.find((e: { status: string }) => e.status === 'error').error).toBe('fetch failed for [url]');
  });

  it('validates the window and the user', async () => {
    const p = as(owner, 'session', scopesForRole('owner'));
    const tooOld = await callTool(t.env, p, 'get_user_activity', { userId: customer.id, since: Date.now() - 31 * DAY });
    expect(tooOld.result.structuredContent.error.code).toBe('invalid_request');
    const inverted = await callTool(t.env, p, 'get_user_activity', { userId: customer.id, since: Date.now() - DAY, until: Date.now() - 2 * DAY });
    expect(inverted.result.structuredContent.error.code).toBe('invalid_request');
    const missing = await callTool(t.env, p, 'get_user_activity', { userId: 'usr_missing' });
    expect(missing.result.structuredContent.error.code).toBe('not_found');
  });

  it('redacts URLs in free text', () => {
    expect(redactUrls('a http://x.y/z b https://q.r/s?t=1, done')).toBe('a [url] b [url], done');
    expect(redactUrls(null)).toBeNull();
  });
});

describe('billing support views', () => {
  it('summarizes one customer, hides grants without credits:read and states what is unsupported', async () => {
    const now = Date.now();
    t.db.prepare("INSERT INTO subscriptions (id,user_id,product_id,plan,status,current_period_end,cancel_at_period_end,created_at,updated_at) VALUES ('sub_1',?, 'p','pro','active',?,1,?,?)").run(customer.id, now + 5 * DAY, now, now);
    t.db.prepare("INSERT INTO credit_grants (id,user_id,source,credits,created_at,reason) VALUES ('g1',?,'admin',50,?,'outage')").run(customer.id, now);
    const full = structured(await callTool(t.env, as(owner, 'session', scopesForRole('owner')), 'get_customer_billing_summary', { userId: customer.id }));
    expect(full.user.email).toMatch(/^.\*\*\*@example\.test$/);
    expect(full.entitlement).toMatchObject({ entitled_plan: 'pro', consistent: true });
    expect(full.entitlement.renewal.next).toBe('cancels at period end');
    expect(full.credit_grants[0]).toMatchObject({ id: 'g1', state: 'active' });
    expect(full.unsupported.supported).toBe(false);
    expect(JSON.stringify(full).includes(customer.email)).toBe(false);
    const billingOnly = structured(await callTool(t.env, as(owner, 'api_key', ['billing:read'], { apiKeyId: 'k' }), 'get_customer_billing_summary', { userId: customer.id }));
    expect(billingOnly.credit_grants).toBeNull();
  });

  it('lists processed and failed webhook deliveries with pagination and explains one event', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) t.db.prepare("INSERT INTO webhook_events (id,type,received_at,provider,outcome) VALUES (?,?,?,'polar','plan_updated')").run(`evt_${i}`, 'subscription.updated', now - i * 1000);
    t.db
      .prepare("INSERT INTO audit_log (id,actor,action,target,target_type,meta,created_at) VALUES ('a1','polar','billing.webhook_failed','evt_0','webhook',?,?)")
      .run(JSON.stringify({ provider: 'polar', event_type: 'subscription.updated', error: 'Error: boom' }), now - 5000);
    t.db
      .prepare("INSERT INTO audit_log (id,actor,action,target,target_type,meta,created_at) VALUES ('a2','creem','billing.webhook_failed','evt_x','webhook',?,?)")
      .run(JSON.stringify({ provider: 'creem', event_type: 'checkout.completed', error: 'Error: down' }), now - 4000);
    const p = as(owner, 'api_key', ['billing:read'], { apiKeyId: 'k' });
    const page1 = structured(await callTool(t.env, p, 'list_billing_events', { limit: 2 }));
    expect(page1.items.map((e: { id: string }) => e.id)).toEqual(['evt_0', 'evt_1']);
    const page2 = structured(await callTool(t.env, p, 'list_billing_events', { limit: 2, cursor: page1.next_cursor }));
    expect(page2.items.map((e: { id: string }) => e.id)).toEqual(['evt_2']);
    const failed = structured(await callTool(t.env, p, 'list_billing_events', { status: 'failed', provider: 'creem' }));
    expect(failed.items).toEqual([expect.objectContaining({ id: 'evt_x', provider: 'creem', error: 'Error: down' })]);
    expect(structured(await callTool(t.env, p, 'get_billing_event', { eventId: 'evt_0' })).status).toBe('processed_after_failures');
    expect(structured(await callTool(t.env, p, 'get_billing_event', { eventId: 'evt_1' })).status).toBe('processed');
    expect(structured(await callTool(t.env, p, 'get_billing_event', { eventId: 'evt_x' })).status).toBe('failed_awaiting_retry');
    expect((await callTool(t.env, p, 'get_billing_event', { eventId: 'nope' })).result.structuredContent.error.code).toBe('not_found');
    const bad = await callTool(t.env, p, 'list_billing_events', { status: 'failed', outcome: 'x' });
    expect(bad.result.structuredContent.error.code).toBe('invalid_request');
  });
});

describe('operations diagnostics', () => {
  function videoJob(id: string, status: string, updatedAt: number, extra: { analysis?: string; error?: string } = {}) {
    t.db
      .prepare('INSERT INTO video_jobs (id,user_id,channel,video_id,source_url,status,r2_key,error,analysis_status,analysis_markdown,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, customer.id, 'mcp', 'vid1', 'https://youtube.com/watch?v=vid1', status, 'videos/secret-key.mp4', extra.error ?? null, extra.analysis ?? null, extra.analysis ? 'private analysis text' : null, updatedAt - 1000, updatedAt);
  }

  it('reports backlog, failures and configuration as booleans only', async () => {
    const now = Date.now();
    videoJob('vj_q', 'queued', now - 60_000);
    videoJob('vj_f', 'failed', now - 60_000, { error: 'provider 500 at https://api.vendor.test/x' });
    videoJob('vj_a', 'ready', now - 60_000, { analysis: 'failed' });
    t.env.OPENROUTER_API_KEY = 'sk-or-secret-value';
    const r = structured(await callTool(t.env, as(owner, 'session', scopesForRole('owner')), 'get_operations_health'));
    expect(r.video_downloads).toMatchObject({ queued: 1, failed_24h: 1, ready_24h: 1 });
    expect(r.video_downloads.oldest_pending_age_s).toBeGreaterThan(0);
    expect(r.video_analysis.failed_24h).toBe(1);
    expect(r.configuration.OPENROUTER_API_KEY).toBe(true);
    expect(r.configuration.POLAR_ACCESS_TOKEN).toBe(false);
    expect(JSON.stringify(r).includes('sk-or-secret-value')).toBe(false);
  });

  it('lists failed jobs by type and returns metadata only', async () => {
    const now = Date.now();
    videoJob('vj_f', 'failed', now - 60_000, { error: 'provider 500 at https://api.vendor.test/x' });
    videoJob('vj_a', 'ready', now - 30_000, { analysis: 'failed' });
    const p = as(owner, 'session', scopesForRole('owner'));
    const downloads = structured(await callTool(t.env, p, 'list_failed_jobs', {}));
    expect(downloads.items.map((j: { id: string }) => j.id)).toEqual(['vj_f']);
    expect(downloads.items[0].error).toBe('provider 500 at [url]');
    const analyses = structured(await callTool(t.env, p, 'list_failed_jobs', { type: 'video_analysis' }));
    expect(analyses.items.map((j: { id: string }) => j.id)).toEqual(['vj_a']);
    const job = structured(await callTool(t.env, p, 'get_job', { jobId: 'vj_a' }));
    expect(job).toMatchObject({ id: 'vj_a', analysis: { status: 'failed' } });
    const text = JSON.stringify(job);
    expect(text.includes('private analysis text')).toBe(false);
    expect(text.includes('secret-key')).toBe(false);
    expect(text.includes('source_url')).toBe(false);
    expect((await callTool(t.env, p, 'get_job', { jobId: 'missing' })).result.structuredContent.error.code).toBe('not_found');
    const feedback = structured(await callTool(t.env, p, 'list_failed_jobs', { type: 'feedback' }));
    expect(feedback.items).toEqual([]);
  });

  it('serves the same diagnostics over REST', async () => {
    const { key } = await seedKey(t, owner, ['system:read']);
    for (const path of ['/admin/system/health', '/admin/system/jobs?type=feedback']) {
      const res = await app.fetch(new Request(`https://anymd.test/api/v1${path}`, { headers: { authorization: `Bearer ${key}` } }), t.env, ctx as never);
      expect(res.status, path).toBe(200);
    }
  });
});

describe('protocol', () => {
  it('lists the access tool in tools/list for a user-role OAuth connection', async () => {
    const { body } = await rpc(t.env, as(customer, 'oauth', capScopes('user', OAUTH_DEFAULT_SCOPES), { clientId: 'c' }), 'tools/list');
    const tool = body.result.tools.find((x: { name: string }) => x.name === 'get_admin_access_status');
    expect(tool.annotations.readOnlyHint).toBe(true);
  });
});
