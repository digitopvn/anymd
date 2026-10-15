# Admin MCP operations tooling (#35)

Status: implemented, in review · Branch: `claude/affectionate-goodall-8ysb23` · Target: `dev`

## Outcome
An authorized owner/admin agent can discover its admin access, connect with explicit admin consent,
answer KPI questions (registered users, DAU/WAU/MAU, activation, plan/subscription mix) with
definitions, and run read-first support, billing and incident diagnostics. No OAuth default
broadening, no generic SQL/proxy tool, no money-moving mutation.

## Phases
| Phase | Scope | Files |
|---|---|---|
| A access | `get_admin_access_status` (any authenticated caller, caller-only data); opt-in admin preset on the OAuth consent screen; dashboard admin onboarding card | `src/services/admin/access.ts`, `src/auth/roles.ts`, `src/routes/auth.tsx`, `src/views/auth.tsx`, `src/views/dashboard.tsx` |
| B reporting | `get_user_stats`, `get_user_activity` with explicit definitions and coverage | `src/services/admin/stats.ts`, migration `0012` indexes |
| C billing/support | `get_customer_billing_summary`, `list_billing_events`, `get_billing_event`; orders/invoices reported `unsupported` (no source of truth) | `src/services/admin/billing.ts` |
| D operations | `get_operations_health`, `list_failed_jobs`, `get_job` (metadata only). Retry stays design-only | `src/services/admin/operations.ts` |
| E parity/docs/tests | MCP thin adapters, REST + OpenAPI, docs, role × scope × auth-kind tests | `src/mcp/*`, `src/routes/api-admin-control-plane.ts`, `src/openapi-admin.ts`, `src/content/docs/*`, `test/*` |

## Decisions
- Activity sources for DAU/WAU/MAU: authenticated `usage_events` ∪ browser sign-ins (`sessions.created_at`). Rolling UTC windows. No exclusions.
- Activation: the user has at least one saved library document.
- Paying accounts: users whose latest subscription entitles a non-free plan under the live provider rules; `users.plan` reported separately as stored plan.
- Orders, invoices, customers: no local source of truth and no provider read path yet: reported as unsupported, not faked.
- `retry_failed_job`: not shipped (needs separate retryability/security review).

## Acceptance
Issue #35 acceptance scenarios 1–6; `npm run typecheck` and `npm test` green.
