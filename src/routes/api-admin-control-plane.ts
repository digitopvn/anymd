/**
 * REST adapters for the admin control plane, mounted under /api/v1/admin. Each route checks its
 * scope, then hands the raw input to `services/admin/*`, which validate it, enforce rank rules and
 * concurrency guards, apply idempotency and write the audit log. Errors surface as
 * `{ error: { code, message, details? } }` through the API error handler.
 */
import { Hono } from 'hono';
import { requireScope, type AppContext } from '../auth/middleware';
import type { AppBindings } from '../env';
import { exportAuditEvents, listAuditEvents } from '../services/admin/audit';
import { getBillingDiagnostics, getSubscription, listSubscriptions } from '../services/admin/billing';
import { listUserCredentials, revokeUserApiKey, revokeUserOAuthGrant, revokeUserSessions } from '../services/admin/credentials';
import { grantCredits, listCreditGrants, revokeCreditGrant } from '../services/admin/credits';
import { getSystemTrace, listSystemTraces, systemOverview, systemUsage } from '../services/admin/observability';
import { addSiteOptout, listSiteOptouts, removeSiteOptout } from '../services/admin/optouts';
import { readSettings, updateSettings } from '../services/admin/settings';
import { AdminError } from '../services/admin/shared';
import { getUserDetail, listRoles, listUsers, setUserStatus, updateUserRole } from '../services/admin/users';

export const adminControlPlane = new Hono<AppBindings>();

const NUMERIC_QUERY = new Set(['limit', 'days']);
const TIMESTAMP_QUERY = new Set(['createdAfter', 'createdBefore', 'lastLoginAfter', 'lastLoginBefore', 'since', 'until']);

/** Query strings to service input: numeric params become numbers, epoch-ms timestamps too (ISO stays a string). */
function query(c: AppContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c.req.query())) {
    if (v === '') continue;
    out[k] = NUMERIC_QUERY.has(k) || (TIMESTAMP_QUERY.has(k) && /^\d+$/.test(v)) ? Number(v) : v;
  }
  return out;
}

/** JSON body plus the `Idempotency-Key` header as `idempotencyKey` when the body has none. */
async function input(c: AppContext, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => {
    throw new AdminError('Body must be a JSON object', 400, 'invalid_json');
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AdminError('Body must be a JSON object', 400, 'invalid_json');
  const idem = c.req.header('idempotency-key');
  return { ...(idem ? { idempotencyKey: idem } : {}), ...(raw as Record<string, unknown>), ...extra };
}

const p = (c: AppContext) => c.get('principal');

// ─── Users ──────────────────────────────────────────────────────────────────

adminControlPlane.get('/users', requireScope('users:read'), async (c) => c.json(await listUsers(c.env, p(c), query(c))));
adminControlPlane.get('/users/:id', requireScope('users:read'), async (c) => c.json(await getUserDetail(c.env, p(c), c.req.param('id'))));

/** Role changes only. Plans follow the billing provider, so `plan` is refused rather than ignored. */
adminControlPlane.patch('/users/:id', requireScope('users:roles:write'), async (c) => {
  const body = await input(c, { userId: c.req.param('id') });
  if ('plan' in body) throw new AdminError('Plans follow the billing provider and cannot be edited. Grant credits for support allowances.', 422, 'plan_managed_by_billing');
  return c.json({ ok: true, ...(await updateUserRole(c.env, p(c), body)) });
});

adminControlPlane.post('/users/:id/status', requireScope('users:sessions:write'), async (c) => c.json(await setUserStatus(c.env, p(c), await input(c, { userId: c.req.param('id') }))));
adminControlPlane.get('/users/:id/credentials', requireScope('users:read'), async (c) => c.json(await listUserCredentials(c.env, p(c), c.req.param('id'))));
adminControlPlane.post('/users/:id/sessions/revoke', requireScope('users:sessions:write'), async (c) => c.json(await revokeUserSessions(c.env, p(c), await input(c, { userId: c.req.param('id') }))));
adminControlPlane.delete('/users/:id/keys/:keyId', requireScope('users:credentials:write'), async (c) =>
  c.json(await revokeUserApiKey(c.env, p(c), { userId: c.req.param('id'), keyId: c.req.param('keyId'), ...(c.req.header('idempotency-key') ? { idempotencyKey: c.req.header('idempotency-key') } : {}) })),
);
adminControlPlane.delete('/users/:id/grants/:grantId', requireScope('users:credentials:write'), async (c) =>
  c.json(await revokeUserOAuthGrant(c.env, p(c), { userId: c.req.param('id'), grantId: c.req.param('grantId') })),
);

adminControlPlane.get('/roles', requireScope(), (c) => c.json(listRoles()));

// ─── Settings ───────────────────────────────────────────────────────────────

adminControlPlane.get('/settings', requireScope('settings:read'), async (c) => c.json(await readSettings(c.env, p(c))));
/** Versioned partial update: `{ patch, expectedVersion?, idempotencyKey? }`. */
adminControlPlane.patch('/settings', requireScope('settings:write'), async (c) => c.json(await updateSettings(c.env, p(c), await input(c))));
/** Original form: the body is the patch itself (no version check). */
adminControlPlane.put('/settings', requireScope('settings:write'), async (c) => {
  const body = await input(c);
  const { idempotencyKey, ...patch } = body;
  return c.json(await updateSettings(c.env, p(c), { patch, ...(idempotencyKey ? { idempotencyKey } : {}) }));
});

// ─── Site opt-outs ──────────────────────────────────────────────────────────

adminControlPlane.get('/optouts', requireScope('optouts:read'), async (c) => c.json(await listSiteOptouts(c.env, p(c), query(c))));
adminControlPlane.post('/optouts', requireScope('optouts:write'), async (c) => c.json(await addSiteOptout(c.env, p(c), await input(c))));
adminControlPlane.delete('/optouts/:domain', requireScope('optouts:write'), async (c) => c.json(await removeSiteOptout(c.env, p(c), { domain: c.req.param('domain') })));

// ─── Credit grants ──────────────────────────────────────────────────────────

adminControlPlane.get('/credits', requireScope('credits:read'), async (c) => c.json(await listCreditGrants(c.env, p(c), query(c))));
adminControlPlane.post('/credits', requireScope('credits:write'), async (c) => {
  const out = await grantCredits(c.env, p(c), await input(c));
  return c.json(out, out.replayed ? 200 : 201);
});
adminControlPlane.post('/credits/:id/revoke', requireScope('credits:write'), async (c) => c.json(await revokeCreditGrant(c.env, p(c), await input(c, { grantId: c.req.param('id') }))));

// ─── Billing (read-only) ────────────────────────────────────────────────────

adminControlPlane.get('/subscriptions', requireScope('billing:read'), async (c) => c.json(await listSubscriptions(c.env, p(c), query(c))));
adminControlPlane.get('/subscriptions/:id', requireScope('billing:read'), async (c) => c.json(await getSubscription(c.env, p(c), c.req.param('id'))));
adminControlPlane.get('/billing/diagnostics', requireScope('billing:read'), async (c) => c.json(await getBillingDiagnostics(c.env, p(c))));

// ─── Audit ──────────────────────────────────────────────────────────────────

adminControlPlane.get('/audit', requireScope('audit:read'), async (c) => c.json(await listAuditEvents(c.env, p(c), query(c))));
adminControlPlane.get('/audit/export', requireScope('audit:read'), async (c) => {
  const out = await exportAuditEvents(c.env, p(c), query(c));
  return c.body(out.ndjson, 200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Content-Disposition': 'attachment; filename="anymd-audit.ndjson"',
    'Cache-Control': 'no-store',
    'X-Anymd-Count': String(out.count),
    'X-Anymd-Truncated': out.truncated ? '1' : '0',
  });
});

// ─── System ─────────────────────────────────────────────────────────────────

adminControlPlane.get('/system/overview', requireScope('system:read'), async (c) => c.json(await systemOverview(c.env, p(c))));
adminControlPlane.get('/system/usage', requireScope('system:read'), async (c) => c.json(await systemUsage(c.env, p(c), query(c))));
adminControlPlane.get('/system/traces', requireScope('system:read'), async (c) => c.json(await listSystemTraces(c.env, p(c), query(c))));
adminControlPlane.get('/system/traces/:id', requireScope('system:read'), async (c) => c.json(await getSystemTrace(c.env, p(c), c.req.param('id'))));
