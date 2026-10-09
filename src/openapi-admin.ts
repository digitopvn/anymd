/**
 * OpenAPI description of the admin control plane under /api/v1/admin. Query parameters and request
 * bodies are generated from the same zod schemas the services validate with, so the description
 * cannot drift from what the API accepts.
 */
import { z } from 'zod';
import { AuditQuery } from './services/admin/audit';
import { SubscriptionQuery } from './services/admin/billing';
import { GrantCreditsInput, GrantQuery, RevokeGrantInput } from './services/admin/credits';
import { RevokeSessionsInput } from './services/admin/credentials';
import { SystemTraceQuery, SystemUsageQuery } from './services/admin/observability';
import { AddOptoutInput, OptoutQuery } from './services/admin/optouts';
import { UpdateSettingsInput } from './services/admin/settings';
import { SetStatusInput, UpdateRoleInput, UserQuery } from './services/admin/users';
import { arr, bool, idParam, int, nullable, obj, ref, str, type Op, type Schema } from './openapi-helpers';

type ZodObject = z.ZodObject<z.ZodRawShape>;

function jsonSchema(schema: z.ZodType): Schema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Schema;
  return rest;
}

/** Every field of a query schema as an optional query parameter. */
function queryParams(schema: ZodObject): NonNullable<Op['params']> {
  return Object.entries(schema.shape).map(([name, field]) => {
    const s = jsonSchema(field as z.ZodType);
    const { description, ...rest } = s;
    return { name, in: 'query' as const, schema: rest, ...(typeof description === 'string' ? { description } : {}) };
  });
}

/** A request body from an input schema, without the fields the path supplies. */
function body(schema: ZodObject, fromPath: string[] = []): Schema {
  const mask = Object.fromEntries(fromPath.map((k) => [k, true])) as Record<string, true>;
  return jsonSchema(fromPath.length ? schema.omit(mask) : schema);
}

const IDEMPOTENCY_HEADER = { name: 'Idempotency-Key', in: 'header' as const, schema: str(undefined, { minLength: 8, maxLength: 120 }), description: 'Retrying with the same key returns the first result (`replayed: true`); reusing it for a different change is a 422.' };
const userParam = idParam('User');
const paged = (item: Schema): Schema => obj({ items: arr(item), next_cursor: nullable(str('Pass back as `cursor` for the next page')) }, ['items', 'next_cursor']);
const anyObject: Schema = { type: 'object' };

export const ADMIN_OPS: Record<string, Record<string, Op>> = {
  '/admin/users': {
    get: { summary: 'List users', description: 'Newest first, cursor-paginated, with filters.', tag: 'Admin', scope: 'users:read', params: queryParams(UserQuery), ok: paged(ref('AdminUser')) },
  },
  '/admin/users/{id}': {
    get: { summary: 'User detail', description: 'Quota, credential counts, library size, latest subscription, active credit grants and (with audit:read) recent audit events.', tag: 'Admin', scope: 'users:read', params: [userParam], ok: anyObject, errors: [404] },
    patch: {
      summary: 'Change a role',
      description: 'Owner-only by template. Nobody changes themselves; non-owners only act below their own rank. Send `expectedRole` to fail with `role_conflict` (409) when the role changed meanwhile. Plans follow the billing provider: a `plan` field is rejected with `plan_managed_by_billing` (422).',
      tag: 'Admin',
      scope: 'users:roles:write',
      params: [userParam, IDEMPOTENCY_HEADER],
      body: body(UpdateRoleInput, ['userId']),
      ok: obj({ ok: bool(), user: ref('AdminUser'), changed: bool(), previousRole: str(), replayed: bool() }),
      errors: [404, 409, 422],
    },
  },
  '/admin/users/{id}/status': {
    post: {
      summary: 'Suspend or reactivate an account',
      description: 'Suspension signs the user out everywhere; their API keys and OAuth grants stop working until reactivation. A reason is required and audited.',
      tag: 'Admin',
      scope: 'users:sessions:write',
      params: [userParam, IDEMPOTENCY_HEADER],
      body: body(SetStatusInput, ['userId']),
      ok: obj({ user: ref('AdminUser'), changed: bool(), sessionsRevoked: int(), replayed: bool() }),
      errors: [404, 409, 422],
    },
  },
  '/admin/users/{id}/credentials': {
    get: { summary: 'Sessions, API keys and OAuth grants of a user', description: 'Metadata only: never secrets or hashes. Sessions are identified by a short handle.', tag: 'Admin', scope: 'users:read', params: [userParam], ok: anyObject, errors: [404] },
  },
  '/admin/users/{id}/sessions/revoke': {
    post: { summary: 'Sign a user out', description: 'All sessions, or one by `sessionHandle`.', tag: 'Admin', scope: 'users:sessions:write', params: [userParam, IDEMPOTENCY_HEADER], body: body(RevokeSessionsInput, ['userId']), ok: obj({ userId: str(), revoked: int(), replayed: bool() }), errors: [404] },
  },
  '/admin/users/{id}/keys/{keyId}': {
    delete: {
      summary: "Revoke a user's API key",
      tag: 'Admin',
      scope: 'users:credentials:write',
      params: [userParam, { name: 'keyId', in: 'path', required: true, schema: str() }, IDEMPOTENCY_HEADER],
      ok: obj({ keyId: str(), revoked: bool(), alreadyRevoked: bool() }),
      errors: [404],
    },
  },
  '/admin/users/{id}/grants/{grantId}': {
    delete: { summary: "Revoke a user's OAuth grant", tag: 'Admin', scope: 'users:credentials:write', params: [userParam, { name: 'grantId', in: 'path', required: true, schema: str(), description: 'URL-encoded grant id' }], ok: obj({ revoked: bool() }), errors: [404] },
  },
  '/admin/roles': { get: { summary: 'Role templates, scopes, key presets and plans', description: 'Plans are informational; the billing provider owns them.', tag: 'Admin', scope: '', ok: anyObject } },
  '/admin/settings': {
    get: { summary: 'Site settings', tag: 'Admin', scope: 'settings:read', ok: ref('AdminSettings') },
    patch: {
      summary: 'Update site settings (versioned)',
      description: 'Partial update. Send `expectedVersion` from GET to fail with `settings_conflict` (409) when another admin saved meanwhile. Empty or null deletes a key. Known keys are validated: announcement (max 300), announcement_href (http(s) URL or /path), support_email.',
      tag: 'Admin',
      scope: 'settings:write',
      params: [IDEMPOTENCY_HEADER],
      body: body(UpdateSettingsInput),
      ok: obj({ settings: { type: 'object', additionalProperties: str() }, version: int(), changed: arr(str()), replayed: bool() }),
      errors: [409, 422],
    },
    put: { summary: 'Update site settings (unversioned)', description: 'The original form: the body is the patch itself. Prefer PATCH with `expectedVersion`.', tag: 'Admin', scope: 'settings:write', body: { type: 'object', additionalProperties: nullable(str()) }, ok: obj({ settings: { type: 'object', additionalProperties: str() }, version: int(), changed: arr(str()) }), errors: [422] },
  },
  '/admin/optouts': {
    get: { summary: 'Site opt-outs', description: 'Domains whose owners asked not to be read. Paginated, searchable.', tag: 'Admin', scope: 'optouts:read', params: queryParams(OptoutQuery), ok: { allOf: [paged(ref('SiteOptout')), obj({ total: int() })] } },
    post: { summary: 'Add a site opt-out', description: 'A URL is reduced to its domain; subdomains are covered. Adding an existing domain updates its reason.', tag: 'Admin', scope: 'optouts:write', params: [IDEMPOTENCY_HEADER], body: body(AddOptoutInput), ok: obj({ domain: str(), existed: bool(), reason: str(), replayed: bool() }), errors: [422] },
  },
  '/admin/optouts/{domain}': {
    delete: { summary: 'Remove a site opt-out', tag: 'Admin', scope: 'optouts:write', params: [{ name: 'domain', in: 'path', required: true, schema: str() }], ok: obj({ domain: str(), existed: bool() }), errors: [422] },
  },
  '/admin/credits': {
    get: { summary: 'Credit grants', description: 'Filter by user, state (active, expired, revoked) and source.', tag: 'Admin', scope: 'credits:read', params: queryParams(GrantQuery), ok: paged(ref('CreditGrant')) },
    post: {
      summary: 'Grant credits',
      description: 'Owner-only by template. Raises the allowance in every month the grant is active. Default expiry: the end of the current month (UTC), or of next month when fewer than 7 days remain; `recurring: true` for monthly credits. On paid plans a grant covers usage from when it is granted onward, not overage already billed. `idempotencyKey` (or the Idempotency-Key header) is required: a retry returns the original grant with 200 and `replayed: true`.',
      tag: 'Admin',
      scope: 'credits:write',
      params: [IDEMPOTENCY_HEADER],
      body: body(GrantCreditsInput),
      status: 201,
      ok: obj({ grant: ref('CreditGrant'), replayed: bool() }),
      errors: [404, 422],
    },
  },
  '/admin/credits/{id}/revoke': {
    post: { summary: 'Revoke a credit grant', description: 'Admin and promo grants only; grants from billing orders return `billing_owned` (409). Repeating is safe.', tag: 'Admin', scope: 'credits:write', params: [idParam('Credit grant')], body: body(RevokeGrantInput, ['grantId']), ok: obj({ grant: ref('CreditGrant'), changed: bool(), alreadyRevoked: bool() }), errors: [404, 409] },
  },
  '/admin/subscriptions': {
    get: { summary: 'Subscriptions (read-only)', description: 'Newest first (by creation time). Billing changes happen in the billing provider.', tag: 'Admin', scope: 'billing:read', params: queryParams(SubscriptionQuery), ok: paged(anyObject) },
  },
  '/admin/subscriptions/{id}': {
    get: { summary: 'Subscription with plan consistency', description: '`consistency` compares the user plan with what the subscription entitles.', tag: 'Admin', scope: 'billing:read', params: [idParam('Subscription')], ok: anyObject, errors: [404] },
  },
  '/admin/billing/diagnostics': {
    get: { summary: 'Billing diagnostics', description: 'Provider configuration (secrets reported as present or missing, never their values), recent webhooks and outcomes, failures, subscriptions by status and plan drift.', tag: 'Admin', scope: 'billing:read', ok: anyObject },
  },
  '/admin/audit': {
    get: { summary: 'Audit log', description: 'Who did what, through which credential and adapter. `action` accepts a prefix ending in `*`.', tag: 'Admin', scope: 'audit:read', params: queryParams(AuditQuery), ok: paged(ref('AuditEvent')) },
  },
  '/admin/audit/export': {
    get: {
      summary: 'Export the audit log as NDJSON',
      description: 'Same filters as /admin/audit, up to 5000 rows. `X-Anymd-Count` and `X-Anymd-Truncated` describe the export.',
      tag: 'Admin',
      scope: 'audit:read',
      params: queryParams(AuditQuery.omit({ cursor: true, limit: true })),
      ok: { content: 'application/x-ndjson', schema: str('One AuditEvent JSON object per line') },
    },
  },
  '/admin/system/overview': { get: { summary: 'System overview', description: 'Users by role, suspensions, signups, paid plans, usage and error rate (24h/7d), documents, audit volume, webhook failures, opt-outs.', tag: 'Admin', scope: 'system:read', ok: anyObject } },
  '/admin/system/usage': { get: { summary: 'System-wide usage', description: 'Totals, latency percentiles, breakdowns by channel, kind and source, daily series, top errors and recent failed conversions.', tag: 'Admin', scope: 'system:read', params: queryParams(SystemUsageQuery), ok: anyObject } },
  '/admin/system/traces': { get: { summary: 'System-wide traces', description: 'Recent (paginated) or slowest within a window, filterable by status, kind and user.', tag: 'Admin', scope: 'system:read', params: queryParams(SystemTraceQuery), ok: paged(ref('Trace')) } },
  '/admin/system/traces/{id}': { get: { summary: 'One trace with spans', tag: 'Admin', scope: 'system:read', params: [idParam('Trace')], ok: ref('Trace'), errors: [404] } },
};

export const ADMIN_SCHEMAS: Record<string, Schema> = {
  AdminUser: obj({ id: str(), email: str(), name: str(), role: str(), plan: str(), status: str(undefined, { enum: ['active', 'suspended'] }), created_at: int('Epoch ms'), last_login_at: nullable(int()) }),
  AdminSettings: obj({ settings: { type: 'object', additionalProperties: str() }, version: int('Send back as expectedVersion'), updated_at: nullable(int()), updated_by: nullable(str()), fields: arr(str()) }),
  SiteOptout: obj({ domain: str(), reason: str(), created_by: nullable(str()), created_at: int() }),
  CreditGrant: obj({
    id: str(),
    user_id: str(),
    credits: int(),
    source: str(undefined, { enum: ['admin', 'promo', 'polar_order'] }),
    reference: nullable(str()),
    reason: str(),
    state: str(undefined, { enum: ['active', 'expired', 'revoked'] }),
    created_at: int('Epoch ms'),
    created_by: nullable(str()),
    expires_at: nullable(int()),
    expires: nullable(str(undefined, { format: 'date-time' })),
    revoked_at: nullable(int()),
    revoked_by: nullable(str()),
    revoke_reason: nullable(str()),
  }),
  AuditEvent: obj({
    id: str(),
    at: str(undefined, { format: 'date-time' }),
    created_at: int('Epoch ms'),
    action: str(),
    target_type: nullable(str()),
    target: str(),
    actor: str('Legacy label: kind:user[:credential]'),
    actor_user_id: nullable(str()),
    auth_kind: nullable(str(undefined, { enum: ['session', 'api_key', 'oauth', 'system'] })),
    credential_id: nullable(str('API key id or OAuth client id')),
    via: nullable(str('mcp:<tool>, api:<METHOD route>, web:<route> or webhook:<provider>')),
    request_id: nullable(str()),
    idempotency_key: nullable(str()),
    meta: { type: 'object', description: 'Minimal diff (`diff`) and context; never secrets' },
  }),
};
