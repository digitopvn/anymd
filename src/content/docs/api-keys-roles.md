---
title: "API keys & roles"
description: "Create scoped anymd API keys, pick presets, and understand how roles cap what every key and OAuth grant can do."
updated: "2026-10-09"
---

Every call to anymd runs as a **principal** with a set of **scopes**. Scopes come from your **role**, and each API key or OAuth grant can only narrow them, never widen them.

## API keys

- Format: `amd_` followed by a random string. Send it as `Authorization: Bearer amd_…` or `X-API-Key: amd_…`.
- The full key is shown **once**, at creation. anymd stores only a hash; if you lose a key, revoke it and make a new one.
- Keys can expire (`expires_in_days`) and can be revoked at any time. Unknown, revoked or expired keys get `401 invalid_api_key`.
- Create and revoke them in **Dashboard → API keys**, or through the API:

```bash
curl https://anymd.cc/api/v1/keys \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"research-agent","preset":"library","expires_in_days":30}'
```

Body: `{ name, preset?, scopes?, expires_in_days? }`. Use a preset, or pass an explicit `scopes` array.

## Presets

| Preset | Label | Scopes |
|---|---|---|
| `convert-only` | Convert only | `convert` |
| `library` | Convert + library (agents) | `convert`, `library:read`, `library:write` |
| `read-only` | Read-only | `library:read`, `usage:read` |
| `content-editor` | Content editor (AI CMS) | `content:read`, `content:write`, `content:publish`, `pages:read`, `pages:write`, `pages:publish` |
| `admin-read-only` | Admin read-only (monitoring agent) | `settings:read`, `optouts:read`, `users:read`, `credits:read`, `billing:read`, `audit:read`, `system:read`, `content:read`, `pages:read` |
| `support` | Support agent | `users:read`, `users:sessions:write`, `users:credentials:write`, `credits:read`, `credits:write`, `billing:read`, `audit:read` |
| `site-ops` | Site operations | `settings:read`, `settings:write`, `optouts:read`, `optouts:write`, `audit:read`, `system:read` |
| `full` | Everything my role allows | all scopes, capped by your role |

Rule of thumb: give each integration its own key with the smallest preset that works. A CI job that only converts gets `convert-only`; an assistant that remembers what it reads gets `library`. The three admin presets are capped by role like every other key: an admin who picks `support` gets no `credits:write`, because only owners hold it.

## Scopes

| Scope | Allows |
|---|---|
| `convert` | Convert URLs and files |
| `library:read` | List, read and search your library |
| `library:write` | Save conversions, tag and delete documents |
| `usage:read` | Usage, credits and traces |
| `keys:manage` | Create, list and revoke your API keys; lets a key or OAuth client change or reset your saved deep reading defaults (signed-in sessions of every role, including `viewer`, can always change their own) |
| `content:read` · `content:write` · `content:publish` | Blog posts: read drafts, edit, publish |
| `pages:read` · `pages:write` · `pages:publish` | Landing pages: read, edit, publish |
| `settings:read` · `settings:write` | Read and change site settings (`settings:write` also reads) |
| `optouts:read` · `optouts:write` | Read and change site opt-outs (domains anymd must not read) |
| `users:read` | Every user account, its support context and credential inventory (never secrets) |
| `users:roles:write` | Change user roles. Older keys holding `users:write` keep working: it means this scope |
| `users:sessions:write` | Sign users out; suspend and reactivate accounts |
| `users:credentials:write` | Revoke another user's API keys and OAuth grants |
| `credits:read` · `credits:write` | Read credit grants; grant and revoke them |
| `billing:read` | Subscriptions, plan consistency and billing diagnostics (read-only) |
| `billing:write` | Reserved for future billing actions; no endpoint or tool uses it |
| `audit:read` | Read and export the audit log |
| `system:read` | System-wide overview, usage, errors and traces |

Everything below `keys:manage` and outside content and pages is **elevated**: it touches other people's accounts or the whole deployment.

A request missing a scope gets `403 forbidden` with the scopes it needed in `required`. The endpoint-to-scope map is in the [REST API](/docs/api) reference; MCP tools are hidden entirely when you lack their scope.

## Roles

Roles are templates. Your account has exactly one.

| Role | For | Scopes |
|---|---|---|
| `user` | Customers (default) | `convert`, `library:read`, `library:write`, `usage:read`, `keys:manage` |
| `viewer` | Read drafts and analytics | `convert`, `library:read`, `usage:read`, `content:read`, `pages:read` |
| `author` | Draft posts and pages; an editor publishes | `user` scopes + `content:read`, `content:write`, `pages:read`, `pages:write` |
| `editor` | Write and publish | `author` scopes + `content:publish`, `pages:publish` |
| `admin` | Run content, pages, settings and opt-outs; support lower-ranked users | `editor` scopes + every `:read` admin scope, `settings:write`, `optouts:write`, `users:sessions:write`, `users:credentials:write` |
| `owner` | Full control | every scope, including `users:roles:write`, `credits:write` and `billing:write` |

**Owner vs admin.** Changing roles and granting or revoking credits are owner-only. Admins can read everything operational and act on accounts ranked **below** their own: sign them out, suspend them, revoke their keys and grants. Nobody can change their own account through admin tools. Reading is not ranked: an admin with `users:read` can view any account's support context, including an owner's API key and OAuth grant metadata (key name, prefix, scopes, created, last used, expiry and revocation; grant client and scopes). That view is read-only and never includes key secrets, token hashes or session tokens, so admins can audit who holds which access without being able to use or change it. `GET /api/v1/admin/roles` returns the live role templates and presets.

**Plans follow billing.** A user's plan comes from the billing provider and cannot be edited by hand. To give someone more allowance for support or a promotion, grant credits instead: an active grant raises their allowance in every month it is active. By default a grant expires at the end of the current month (UTC), so it is a one-time amount; pass `recurring: true` (with or without `expiresAt`) for credits that come back every month. On Pro and Scale, credits are used in this order: the plan's included credits, then active grants, then paid overage, and the units a grant covers are never sent to the billing meter, so a grant really lowers the overage bill.

## How capping works

Effective scopes = the key's (or grant's) scopes ∩ the owner's **current** role.

- A key created with `full` by an `editor` gets editor scopes, not owner scopes.
- If a user is demoted, their existing keys lose the extra power on the very next request. No need to rotate.
- A key created with no preset and no scopes gets the scopes of the credential that created it.
- A suspended account's keys and OAuth grants stop working until it is reactivated.

Check what a key can actually do right now:

```bash
curl https://anymd.cc/api/v1/me -H "Authorization: Bearer $ANYMD_API_KEY"
# { "id": "…", "email": "…", "name": "…", "role": "user", "plan": "free", "scopes": ["convert", …] }
```

## OAuth

MCP clients can skip keys and sign in with OAuth 2.1 (Dynamic Client Registration + PKCE). Setup: [MCP server](/docs/mcp).

- **Least privilege by default.** A client that asks for no scopes gets `convert`, `library:read` and `library:write`: it can read the web and save to and search *your own* library, never everything your role allows. The MCP endpoint advertises only these three scopes in its 401 challenge and protected-resource metadata, so spec-following clients start there.
- **Elevated scopes are explicit.** A client must request admin, content, pages or `keys:manage` scopes by name, and the consent screen lists them separately as elevated so you see exactly what you approve. Scopes your role lacks are dropped and shown as unavailable.
- **No keys from connected apps.** An OAuth connection can list and revoke your keys (with `keys:manage`) but never create one (`403 oauth_key_creation_forbidden`): a key would outlive the connection. Create keys in the dashboard.
- **Capped on every request.** The grant is intersected with your current role each time, so a demotion takes effect immediately. A token the client downscoped at refresh keeps only its own scopes.
- **Older grants.** Grants approved before this consent model keep their non-admin scopes but lose admin scopes. One stored with no scopes (it meant "everything my role allows") now gets your role's non-elevated scopes (`convert`, `library:read`, `library:write`, `usage:read` where your role has them). Reconnect the client to grant more explicitly.

## An admin agent with least privilege

1. Decide what the agent does. Monitoring needs only reads; a support agent needs `users:sessions:write`; a site operator needs `settings:write` and `optouts:write`.
2. Create a dedicated key with the matching preset (`admin-read-only`, `support` or `site-ops`) and an expiry, or connect over OAuth and request just those scopes.
3. Check it with `GET /api/v1/me`, then connect it to the [MCP server](/docs/mcp#system-administration).
4. Review what it did in the audit log (`list_audit_events`, or `GET /api/v1/admin/audit`): every change records the tool or route, the key or OAuth client, and the request id.

## Good hygiene

- One key per integration, named after it. Revoke it when the integration goes away.
- Never give an agent `full` when a preset fits. Admin agents especially should not hold owner-only scopes unless they need them.
- Set `expires_in_days` for anything temporary.
- Keep keys in environment variables or a secret manager, never in source control or client-side code.
- Browser sessions can't be used cross-site: cookie-authenticated writes must come from anymd.cc itself.
