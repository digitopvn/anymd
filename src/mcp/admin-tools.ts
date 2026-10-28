/**
 * System administration tools for owner/admin agents. Each tool is a thin adapter over
 * `services/admin/*`, which own authorization, validation, concurrency, idempotency and audit.
 * Every list is paginated (pass `next_cursor` back as `cursor`); there is no generic SQL tool.
 */
import { z } from 'zod';
import { roleHasAdminAccess } from '../auth/roles';
import { AuditQuery, listAuditEvents } from '../services/admin/audit';
import { adminAccessStatus } from '../services/admin/access';
import { BillingEventQuery, getBillingDiagnostics, getBillingEvent, getCustomerBillingSummary, getSubscription, listBillingEvents, listSubscriptions, SubscriptionQuery } from '../services/admin/billing';
import { FailedJobQuery, getJob, getOperationsHealth, listFailedJobs } from '../services/admin/operations';
import { getUserActivity, getUserStats, UserActivityQuery } from '../services/admin/stats';
import { listUserCredentials, revokeUserApiKey, revokeUserOAuthGrant, revokeUserSessions, RevokeSessionsInput, RevokeUserGrantInput, RevokeUserKeyInput } from '../services/admin/credentials';
import { GrantCreditsInput, GrantQuery, grantCredits, listCreditGrants, revokeCreditGrant, RevokeGrantInput } from '../services/admin/credits';
import { getSystemTrace, listSystemTraces, systemOverview, systemUsage, SystemTraceQuery, SystemUsageQuery } from '../services/admin/observability';
import { AddOptoutInput, addSiteOptout, listSiteOptouts, OptoutQuery, removeSiteOptout, RemoveOptoutInput } from '../services/admin/optouts';
import { readSettings, updateSettings, UpdateSettingsInput } from '../services/admin/settings';
import { getUserDetail, listRoles, listUsers, SetStatusInput, setUserStatus, UpdateRoleInput, updateUserRole, UserQuery } from '../services/admin/users';
import { DESTRUCTIVE, IDEMPOTENT_WRITE, READ_ONLY, type ToolDef } from './tool-types';

const PAGED = 'Paginated: pass next_cursor back as cursor.';
const IDEM = 'Pass an idempotencyKey so a retry returns the first result instead of acting twice.';

export const ADMIN_TOOLS: ToolDef[] = [
  // ─── Read-only ────────────────────────────────────────────────────────────
  {
    name: 'system_overview',
    title: 'System overview',
    description: 'Headline numbers for the whole deployment: users by role, suspensions, signups, paid plans, usage and error rate (24h/7d), documents, audit volume, webhook failures, opt-outs.',
    scope: 'system:read',
    input: z.object({}),
    annotations: READ_ONLY,
    run: (_a, t) => systemOverview(t.env, t.principal),
  },
  {
    name: 'get_user_stats',
    title: 'User and product KPIs',
    description:
      'Registered users, new signups (24h/7d/30d with the prior period), active users DAU/WAU/MAU, usage-active users, activation, stored plans vs paying accounts and plan conflicts, and requests/credits/error rate. Every number comes with its definition, rolling UTC windows, generated_at and data coverage caveats. No revenue: orders and invoices live in the billing provider.',
    scope: 'system:read',
    input: z.object({}),
    annotations: READ_ONLY,
    run: (_a, t) => getUserStats(t.env, t.principal),
  },
  {
    name: 'get_user_activity',
    title: 'User activity',
    description: `One user's activity for support: totals, breakdown by kind and channel, daily series, last activity, library size and a page of event metadata (no URLs, queries or document contents). Window since/until, at most 30 days. ${PAGED}`,
    scope: 'users:read',
    input: UserActivityQuery,
    annotations: READ_ONLY,
    run: (a, t) => getUserActivity(t.env, t.principal, a),
  },
  {
    name: 'get_operations_health',
    title: 'Operations health',
    description: 'Background work at a glance: queued/running/failed video downloads and analyses with the oldest pending age, feedback publishing backlog, billing webhook failures, request error rates (1h/24h) and which optional integrations are configured (true/false only).',
    scope: 'system:read',
    input: z.object({}),
    annotations: READ_ONLY,
    run: (_a, t) => getOperationsHealth(t.env, t.principal),
  },
  {
    name: 'list_failed_jobs',
    title: 'List failed jobs',
    description: `Failed background jobs, most recently updated first: type video_download (default), video_analysis or feedback. Metadata and truncated errors only. Filter by userId and since (at most 30 days ago). ${PAGED}`,
    scope: 'system:read',
    input: FailedJobQuery,
    annotations: READ_ONLY,
    run: (a, t) => listFailedJobs(t.env, t.principal, a),
  },
  {
    name: 'get_job',
    title: 'Get job',
    description: 'One background job (video download/analysis or feedback publication) by id: status, attempts, timings and truncated error. Metadata only.',
    scope: 'system:read',
    input: z.object({ jobId: z.string().min(1).max(80) }),
    annotations: READ_ONLY,
    run: (a, t) => getJob(t.env, t.principal, a.jobId),
  },
  {
    name: 'list_users',
    title: 'List users',
    description: `Compact user summaries, newest first. Filter by search (email, name or id), role, plan, status, created/last-login windows. ${PAGED}`,
    scope: 'users:read',
    input: UserQuery,
    annotations: READ_ONLY,
    run: (a, t) => listUsers(t.env, t.principal, a),
  },
  {
    name: 'get_user',
    title: 'Get user',
    description: 'One user with support context: quota, credential counts, library size, latest subscription, active credit grants and (with audit:read) recent audit events.',
    scope: 'users:read',
    input: z.object({ userId: z.string().min(1).max(80) }),
    annotations: READ_ONLY,
    run: (a, t) => getUserDetail(t.env, t.principal, a.userId),
  },
  {
    name: 'list_roles',
    title: 'List roles and scopes',
    description: 'Role templates with their scopes, what each scope allows, API key presets and plans (plans are informational: the billing provider owns them).',
    scope: 'users:read',
    input: z.object({}),
    annotations: READ_ONLY,
    run: async () => listRoles(),
  },
  {
    name: 'list_user_credentials',
    title: 'List user credentials',
    description: "A user's API keys (metadata only), active sessions (short handles, never tokens) and connected OAuth apps. Use the ids with the revoke_* tools.",
    scope: 'users:read',
    input: z.object({ userId: z.string().min(1).max(80) }),
    annotations: READ_ONLY,
    run: (a, t) => listUserCredentials(t.env, t.principal, a.userId),
  },
  {
    name: 'list_audit_events',
    title: 'List audit events',
    description: `Audit log, newest first: who acted (user, auth kind, key or OAuth client), via which tool or route, on what, with a minimal diff. Filter by action (prefix with *, e.g. user.*), actorUserId, target, targetType, since/until. ${PAGED}`,
    scope: 'audit:read',
    input: AuditQuery,
    annotations: READ_ONLY,
    run: (a, t) => listAuditEvents(t.env, t.principal, a),
  },
  {
    name: 'list_system_usage',
    title: 'System usage',
    description: 'Usage across all users over a window (default 7 days, max 90): totals, error rate, latency p50/p90/p99, breakdown by channel, kind and source, daily series, top errors and recent failed conversions.',
    scope: 'system:read',
    input: SystemUsageQuery,
    annotations: READ_ONLY,
    run: (a, t) => systemUsage(t.env, t.principal, a),
  },
  {
    name: 'list_system_traces',
    title: 'List system traces',
    description: `Request traces across all users (summaries, no spans). sort=recent (default, ${PAGED}) or sort=slowest in the window. Filter by status, kind, userId, since (default 7 days).`,
    scope: 'system:read',
    input: SystemTraceQuery,
    annotations: READ_ONLY,
    run: (a, t) => listSystemTraces(t.env, t.principal, a),
  },
  {
    name: 'get_system_trace',
    title: 'Get system trace',
    description: 'One trace with its spans, for any user.',
    scope: 'system:read',
    input: z.object({ traceId: z.string().min(1).max(80) }),
    annotations: READ_ONLY,
    run: (a, t) => getSystemTrace(t.env, t.principal, a.traceId),
  },
  {
    name: 'list_subscriptions',
    title: 'List subscriptions',
    description: `Subscriptions synced from the billing provider, most recently updated first, with the plan each one entitles. Read-only. ${PAGED}`,
    scope: 'billing:read',
    input: SubscriptionQuery,
    annotations: READ_ONLY,
    run: (a, t) => listSubscriptions(t.env, t.principal, a),
  },
  {
    name: 'get_subscription',
    title: 'Get subscription',
    description: "One subscription and whether the user's plan matches what it entitles. Plans change only through the billing provider.",
    scope: 'billing:read',
    input: z.object({ subscriptionId: z.string().min(1).max(120) }),
    annotations: READ_ONLY,
    run: (a, t) => getSubscription(t.env, t.principal, a.subscriptionId),
  },
  {
    name: 'get_billing_diagnostics',
    title: 'Billing diagnostics',
    description: 'Live billing provider, which billing secrets are configured (true/false only), recent webhook events and outcomes, failures in the last 7 days, subscriptions by status and users whose plan disagrees with their latest subscription.',
    scope: 'billing:read',
    input: z.object({}),
    annotations: READ_ONLY,
    run: (_a, t) => getBillingDiagnostics(t.env, t.principal),
  },
  {
    name: 'get_customer_billing_summary',
    title: 'Customer billing summary',
    description: "One user's billing for support: stored plan vs entitled plan, subscriptions, renewal or cancellation, provider customer link (present or not), recent credit grants (with credits:read). Email is masked. Payments, orders and invoices are not stored and are reported as unsupported.",
    scope: 'billing:read',
    input: z.object({ userId: z.string().min(1).max(80) }),
    annotations: READ_ONLY,
    run: (a, t) => getCustomerBillingSummary(t.env, t.principal, a.userId),
  },
  {
    name: 'list_billing_events',
    title: 'List billing events',
    description: `Billing webhook deliveries, newest first. status=processed (default) lists recorded deliveries with their outcome; status=failed lists deliveries whose handling threw (the provider retries them). Filter by provider, type, outcome, since (at most 90 days ago). No payloads or signatures. ${PAGED}`,
    scope: 'billing:read',
    input: BillingEventQuery,
    annotations: READ_ONLY,
    run: (a, t) => listBillingEvents(t.env, t.principal, a),
  },
  {
    name: 'get_billing_event',
    title: 'Get billing event',
    description: 'One billing webhook delivery by provider event id: recorded outcome and every failed attempt with its sanitized error.',
    scope: 'billing:read',
    input: z.object({ eventId: z.string().min(1).max(200) }),
    annotations: READ_ONLY,
    run: (a, t) => getBillingEvent(t.env, t.principal, a.eventId),
  },
  {
    name: 'list_credit_grants',
    title: 'List credit grants',
    description: `Credit grants (support and promo allowances), newest first. Filter by userId, state (active, expired, revoked) and source. ${PAGED}`,
    scope: 'credits:read',
    input: GrantQuery,
    annotations: READ_ONLY,
    run: (a, t) => listCreditGrants(t.env, t.principal, a),
  },
  {
    name: 'list_site_optouts',
    title: 'List site opt-outs',
    description: `Domains anymd refuses to fetch (each covers its subdomains). Filter by search. ${PAGED}`,
    scope: 'optouts:read',
    input: OptoutQuery,
    annotations: READ_ONLY,
    run: (a, t) => listSiteOptouts(t.env, t.principal, a),
  },
  {
    name: 'get_settings',
    title: 'Get site settings',
    description: 'Site settings (announcement bar, support email, ...) and their version. Pass the version to update_settings as expectedVersion.',
    scope: 'settings:read',
    input: z.object({}),
    annotations: READ_ONLY,
    run: (_a, t) => readSettings(t.env, t.principal),
  },

  // ─── Mutations ────────────────────────────────────────────────────────────
  {
    name: 'update_user_role',
    title: 'Update user role',
    description: `Change a user's role (authorization only; plans follow billing). Owner only. Never on yourself. Pass expectedRole from get_user: a concurrent change fails with role_conflict. ${IDEM}`,
    scope: 'users:roles:write',
    input: UpdateRoleInput,
    annotations: IDEMPOTENT_WRITE,
    run: (a, t) => updateUserRole(t.env, t.principal, a),
  },
  {
    name: 'set_user_status',
    title: 'Suspend or reactivate user',
    description: `Suspend an account (signs it out everywhere; its API keys and OAuth grants stop working) or reactivate it. Reversible. Requires a reason. Only for accounts ranked below yours. ${IDEM}`,
    scope: 'users:sessions:write',
    input: SetStatusInput,
    annotations: DESTRUCTIVE,
    run: (a, t) => setUserStatus(t.env, t.principal, a),
  },
  {
    name: 'revoke_user_sessions',
    title: 'Revoke user sessions',
    description: `Sign a user out of every browser session, or one session by its handle from list_user_credentials. API keys and OAuth grants are not affected. ${IDEM}`,
    scope: 'users:sessions:write',
    input: RevokeSessionsInput,
    annotations: DESTRUCTIVE,
    run: (a, t) => revokeUserSessions(t.env, t.principal, a),
  },
  {
    name: 'revoke_user_api_key',
    title: 'Revoke user API key',
    description: "Revoke one of a user's API keys immediately. Repeating it is safe (reports alreadyRevoked).",
    scope: 'users:credentials:write',
    input: RevokeUserKeyInput,
    annotations: DESTRUCTIVE,
    run: (a, t) => revokeUserApiKey(t.env, t.principal, a),
  },
  {
    name: 'revoke_oauth_grant',
    title: 'Revoke user OAuth grant',
    description: "Disconnect one of a user's OAuth apps (e.g. an MCP client); its tokens stop working immediately.",
    scope: 'users:credentials:write',
    input: RevokeUserGrantInput,
    annotations: DESTRUCTIVE,
    run: (a, t) => revokeUserOAuthGrant(t.env, t.principal, a),
  },
  {
    name: 'grant_credits',
    title: 'Grant credits',
    description:
      'Grant a user extra credits (support or promo allowance) with a reason. By default a grant is a one-time pool: its credits are spent once over its lifetime, even when it spans two months, and it expires at the end of the current month (UTC), or the end of next month when fewer than 7 days of this month remain. Pass recurring: true for credits that renew in full every month (and for a later expiresAt). On paid plans a grant covers usage from when it is granted onward; it does not refund overage already billed. Owner only. idempotencyKey is required: retrying with it returns the original grant (replayed: true) and never grants twice.',
    scope: 'credits:write',
    input: GrantCreditsInput,
    annotations: IDEMPOTENT_WRITE,
    run: (a, t) => grantCredits(t.env, t.principal, a),
  },
  {
    name: 'revoke_credit_grant',
    title: 'Revoke credit grant',
    description: 'Void an admin or promo credit grant with a reason; it stops counting immediately. Billing-issued grants are refused (billing_owned). Repeating it is safe.',
    scope: 'credits:write',
    input: RevokeGrantInput,
    annotations: DESTRUCTIVE,
    run: (a, t) => revokeCreditGrant(t.env, t.principal, a),
  },
  {
    name: 'add_site_optout',
    title: 'Add site opt-out',
    description: `Stop fetching a domain and all its subdomains (owner request). Takes effect on the next conversion; cached copies are not served either. ${IDEM}`,
    scope: 'optouts:write',
    input: AddOptoutInput,
    annotations: IDEMPOTENT_WRITE,
    run: (a, t) => addSiteOptout(t.env, t.principal, a),
  },
  {
    name: 'remove_site_optout',
    title: 'Remove site opt-out',
    description: 'Allow fetching a previously opted-out domain again. Only do this when the site owner asked for it.',
    scope: 'optouts:write',
    input: RemoveOptoutInput,
    annotations: DESTRUCTIVE,
    run: (a, t) => removeSiteOptout(t.env, t.principal, a),
  },
  {
    name: 'update_settings',
    title: 'Update site settings',
    description: `Set site settings; an empty string or null deletes a key. Known keys are validated (announcement_href must be a URL or path, support_email an email). Pass expectedVersion from get_settings: a concurrent change fails with settings_conflict. ${IDEM}`,
    scope: 'settings:write',
    input: UpdateSettingsInput,
    annotations: DESTRUCTIVE,
    run: (a, t) => updateSettings(t.env, t.principal, a),
  },
];

/**
 * The caller's own admin access, visible to every signed-in owner or admin so a client whose
 * connection lacks admin scopes can still learn how to reconnect with them. Other roles never see
 * it over MCP (customers' tool lists stay free of admin tooling); REST `/api/v1/admin/access` still
 * answers them. Reports nothing about other users or the system. Takes the finished tool catalog
 * to name the tools.
 */
export function accessStatusTool(catalog: () => readonly ToolDef[]): ToolDef {
  return {
    name: 'get_admin_access_status',
    title: 'My admin access',
    description:
      "What this connection can do as an admin: your role, this credential's effective scopes, the admin scopes your role allows but this connection lacks, the admin tools available now and after reconnecting, and exactly how to reconnect with admin access (OAuth consent option, step-up scope or API key preset). Reports only on you. Listed only for owner and admin roles.",
    scope: null,
    visibleTo: (p) => roleHasAdminAccess(p.role),
    input: z.object({}),
    annotations: READ_ONLY,
    run: async (_a, t) => adminAccessStatus(t.env, t.principal, catalog()),
  };
}
