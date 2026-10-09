---
title: "MCP server"
description: "Connect Claude Code, Claude Desktop, Cursor or any MCP client to anymd.cc/mcp so your agents can read the public web, remember it and search it."
updated: "2026-10-09"
---

anymd runs a remote [Model Context Protocol](https://modelcontextprotocol.io) server. It is the main way agents use anymd as their web context layer: connect it once and your agent can read public web content as structured Markdown, recall everything it has read from your private library, and (with the right scopes) manage pages.

| | |
|---|---|
| Endpoint | `https://anymd.cc/mcp` |
| Transport | Streamable HTTP, stateless JSON responses |
| Protocol | `2026-07-28` (stateless) and `2025-11-25` and earlier |
| Auth | `Authorization: Bearer amd_…`, or OAuth 2.1 |

## Authentication

**API key.** Simplest option. Create a key in **Dashboard → API keys**. The **Convert + library (agents)** preset is a good default for an assistant. Details: [API keys & roles](/docs/api-keys-roles).

**OAuth 2.1.** For clients that support it, just add the URL and sign in when prompted. anymd supports Dynamic Client Registration and PKCE:

| | |
|---|---|
| Metadata | `/.well-known/oauth-authorization-server` |
| Authorize | `/oauth/authorize` |
| Token | `/oauth/token` |
| Registration | `/oauth/register` |

Either way, your agent only sees the tools its scopes allow. An OAuth client that requests no scopes gets `convert`, `library:read` and `library:write` (read the web, save to and search your own library); anything more, admin scopes above all, must be requested by name and approved on the consent screen. When a read is not saved, the result says so: `saved: false` with `not_saved_reason` (`missing_scope` means the connection lacks `library:write`). See [API keys & roles](/docs/api-keys-roles#oauth).

## Client setup

Run `anymd mcp` from the [CLI](/docs/cli) to print these snippets with your key filled in.

### Claude Code

```bash
claude mcp add --transport http anymd https://anymd.cc/mcp \
  --header "Authorization: Bearer amd_…"
```

### Claude Desktop

Add anymd as a custom connector: **Settings → Connectors → Add custom connector**, URL `https://anymd.cc/mcp`, then sign in through OAuth.

If you'd rather use an API key, bridge the remote server through `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "anymd": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://anymd.cc/mcp", "--header", "Authorization: Bearer amd_…"]
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "anymd": {
      "url": "https://anymd.cc/mcp",
      "headers": { "Authorization": "Bearer amd_…" }
    }
  }
}
```

### Any other client

Any client that speaks Streamable HTTP can use the same shape: URL `https://anymd.cc/mcp` plus an `Authorization` header, or OAuth discovery from the metadata URL above.

## Tools

Tools are listed only when the caller holds the scope they need.

### Conversion and library

| Tool | Input | Needs |
|---|---|---|
| `read_url` | `{ url, save?, fresh?, removeImages?, expandThread?, maxThreadPosts?, includeComments?, analyzeImages?, maxComments?, maxImages?, maxCredits? }` | `convert` (saving also needs `library:write`) |
| `convert_url` | Same input as `read_url` | Same as `read_url`, kept under its original name for existing clients |
| `search_library` | `{ query, mode?, limit? }` | `library:read` |
| `get_document` | `{ id }` | `library:read` |
| `list_documents` | `{ limit?, domain?, tags?, before? }` | `library:read` |
| `list_tags` | `{ limit? }` | `library:read` |
| `tag_document` | `{ id, add?, remove?, set? }` | `library:write` |
| `delete_document` | `{ id }` | `library:write` |
| `usage_summary` | `{}` | `usage:read` |

`read_url` and `convert_url` are the same tool with the same input and output; new integrations should use `read_url`. `mode` is `hybrid` (default), `bm25`, `fulltext` or `semantic`. See [Library & search](/docs/library-search).

`tag_document` adds and/or removes tags, or replaces them all with `set` (not combinable with `add`/`remove`; `[]` clears), and returns `{ id, tags }`. Tags are lowercased and keep only letters, digits, `-` and `_`; a document holds at most 20, and an edit past that fails with `too_many_tags` instead of dropping tags. `list_tags` returns `{ items: [{ tag, count }] }`, most used first. `list_documents` with `tags` keeps documents carrying every listed tag (whole-tag match, up to 10).

`expandThread`, `includeComments` and `analyzeImages` are opt-in deep reading flags that cost extra credits. Options the agent leaves out follow the account's saved [deep reading defaults](/docs/api#deep-reading-options-and-saved-defaults), otherwise they are off: connecting an agent never turns enrichment on by itself. `maxThreadPosts` defaults to 20 and is capped at 100; `maxCredits` defaults to 100 and is capped at 1,000; `maxComments` defaults to 100 and is capped at 1,000; `maxImages` defaults to 10 and is capped at 20. `removeImages` strips image/media URLs at no credit cost. X reads return the single requested post unless thread expansion is enabled. The response's `reading_options` shows each effective value and its source (`request`, `preference` or `default`). Social post adapters for Facebook, Instagram, Threads and LinkedIn require an account. The response includes `credit_breakdown` and `enrichment` coverage so partial provider, limit or timeout results are explicit; cached reads are free.

### Pages and posts

| Tool | Input | Needs |
|---|---|---|
| `list_blocks` | `{}` | `pages:read` |
| `list_page_templates` | `{}` | `pages:read` |
| `list_pages` | `{}` | `pages:read` |
| `get_page` | `{ id }` | `pages:read` |
| `create_page` | `{ slug, title, description?, template? }` | `pages:write` |
| `apply_page_ops` | `{ pageId, baseRevision, ops, idempotencyKey? }` | `pages:write` |
| `publish_page` | `{ pageId, revision? }` | `pages:publish` |
| `unpublish_page` | `{ pageId }` | `pages:publish` |
| `list_posts` | `{}` | `content:read` |
| `upsert_post` | `{ id?, slug?, title, markdown, excerpt?, tags? }` | `content:write` |
| `publish_post` | `{ id, publish }` | `content:publish` |

| `get_page_markdown` | `{ pageId }` | `pages:read` |
| `list_page_revisions` | `{ pageId }` | `pages:read` |
| `rotate_page_preview_token` | `{ pageId }` | `pages:write` |
| `archive_page` | `{ pageId }` | `pages:write` |
| `get_post` | `{ id }` (id or slug) | `content:read` |
| `fork_post` | `{ slug }` (copy a bundled post into the CMS) | `content:write` |
| `delete_post` | `{ id }` | `content:write` |

The ops format, revision rules and the safe editing loop are in the admin [builder guide](/admin/docs/page-builder).

### Your account

| Tool | Input | Needs |
|---|---|---|
| `list_traces` | `{ cursor?, limit? }` | `usage:read` |
| `get_trace` | `{ traceId }` | `usage:read` |
| `list_api_keys` | `{}` | `keys:manage` |
| `create_api_key` | `{ name, preset?, scopes?, expiresInDays? }` | `keys:manage` |
| `revoke_api_key` | `{ keyId }` | `keys:manage` |
| `list_oauth_grants` | `{}` | `keys:manage` |
| `revoke_my_oauth_grant` | `{ grantId }` | `keys:manage` |

`create_api_key` returns the secret once; a new key never gets scopes the calling credential lacks. OAuth connections cannot create keys at all (`oauth_key_creation_forbidden`), because a key would outlive the grant: create keys with an API key, a session, or in the dashboard.

## System administration

Owners and admins can run the deployment from an agent: users, credentials, credits, settings, opt-outs, billing health, audit history and system usage. Every admin tool is a thin adapter over the same services the REST API uses, so the rules are identical everywhere:

- **Scoped.** Each tool needs one granular scope and is hidden without it. Owner-only tools (`update_user_role`, `grant_credits`, `revoke_credit_grant`) never appear for admins.
- **Ranked.** Nobody can act on their own account; admins only act on accounts ranked below them.
- **Bounded.** Every list is paginated: pass `next_cursor` back as `cursor`. There is no SQL or shell tool.
- **Safe to retry.** Mutations accept an `idempotencyKey` (required for `grant_credits`); a retry returns the first result with `replayed: true`, and a retry that arrives while the first attempt is still running gets `idempotency_in_progress` (retry shortly) instead of running the change twice. Changes guarded by `expectedRole` or `expectedVersion` fail with a conflict instead of overwriting someone else's change.
- **Audited.** Every change writes an audit row with the acting user, the API key or OAuth client, the tool (`via: mcp:<tool>`), the request id and a minimal diff. Secrets are never recorded or returned.
- **Billing stays with the provider.** Plans and subscriptions are read-only here. Use credit grants for support allowances: an active grant raises their allowance in every month it is active. By default a grant expires at the end of the current month (UTC), so it is a one-time amount; pass `recurring: true` (with or without `expiresAt`) for credits that come back every month. On Pro and Scale, credits are used in this order: the plan's included credits, then active grants, then paid overage, and the units a grant covers are never sent to the billing meter, so a grant really lowers the overage bill.

Tool annotations tell the client what to expect: read tools are `readOnlyHint`, and tools that remove access or data (`set_user_status`, `revoke_*`, `remove_site_optout`, `update_settings`, `delete_post`, `archive_page`) are `destructiveHint`, so a well-behaved client asks before running them.

### Read tools

| Tool | Input | Needs |
|---|---|---|
| `system_overview` | `{}` | `system:read` |
| `list_system_usage` | `{ days? (1–30, default 7), channel?, kind? }` | `system:read` |
| `list_system_traces` | `{ sort?, status?, kind?, userId?, since? (at most 30 days ago), cursor?, limit? }` | `system:read` |
| `get_system_trace` | `{ traceId }` | `system:read` |
| `list_users` | `{ search?, role?, plan?, status?, createdAfter?, createdBefore?, lastLoginAfter?, lastLoginBefore?, cursor?, limit? }` | `users:read` |
| `get_user` | `{ userId }` | `users:read` |
| `list_user_credentials` | `{ userId }` | `users:read` |
| `list_roles` | `{}` | `users:read` |
| `list_audit_events` | `{ action?, actorUserId?, target?, targetType?, since?, until?, cursor?, limit? }` | `audit:read` |
| `list_subscriptions` | `{ status?, plan?, userId?, cursor?, limit? }` | `billing:read` |
| `get_subscription` | `{ subscriptionId }` | `billing:read` |
| `get_billing_diagnostics` | `{}` | `billing:read` |
| `list_credit_grants` | `{ userId?, state?, source?, cursor?, limit? }` | `credits:read` |
| `list_site_optouts` | `{ search?, cursor?, limit? }` | `optouts:read` |
| `get_settings` | `{}` | `settings:read` |

Timestamps accept epoch milliseconds or ISO 8601. `action` in `list_audit_events` takes an exact action or a prefix such as `user.*`.

### Change tools

| Tool | Input | Needs |
|---|---|---|
| `update_user_role` | `{ userId, role, expectedRole?, idempotencyKey? }` | `users:roles:write` (owner) |
| `set_user_status` | `{ userId, status, reason, expectedStatus?, idempotencyKey? }` | `users:sessions:write` |
| `revoke_user_sessions` | `{ userId, sessionHandle?, idempotencyKey? }` | `users:sessions:write` |
| `revoke_user_api_key` | `{ userId, keyId, idempotencyKey? }` | `users:credentials:write` |
| `revoke_oauth_grant` | `{ userId, grantId }` | `users:credentials:write` |
| `grant_credits` | `{ userId, credits, reason, source?, expiresAt?, recurring?, idempotencyKey }` | `credits:write` (owner) |
| `revoke_credit_grant` | `{ grantId, reason }` | `credits:write` (owner) |
| `add_site_optout` | `{ domain, reason?, idempotencyKey? }` | `optouts:write` |
| `remove_site_optout` | `{ domain, idempotencyKey? }` | `optouts:write` |
| `update_settings` | `{ patch, expectedVersion?, idempotencyKey? }` | `settings:write` |

`status` is `active` or `suspended`. Suspending an account signs it out everywhere and stops its keys and OAuth grants until it is reactivated. Errors come back as tool results with `structuredContent.error.code`, for example `role_conflict`, `settings_conflict`, `forbidden_rank`, `forbidden_self`, `idempotency_mismatch` or `billing_owned`.

### Set up an admin agent

Give the agent only what its job needs. Create a key from a preset (**Dashboard → API keys**, or `create_api_key`):

| Job | Preset |
|---|---|
| Monitoring and reports | `admin-read-only` |
| Support: sign users out, suspend, revoke credentials, grant credits (owner) | `support` |
| Site operations: settings and opt-outs | `site-ops` |

```bash
claude mcp add --transport http anymd-admin https://anymd.cc/mcp \
  --header "Authorization: Bearer amd_…"
```

Over OAuth, the client asks for the scopes it needs. When it calls a tool whose scope the grant lacks but your role allows, anymd answers `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` listing the current scopes plus the missing one, so the client can re-authorize (step up). With an API key the same call returns a tool error with code `insufficient_scope`; create a key that includes the scope. When your role does not allow the scope at all, the code is `forbidden`.

Things to ask an admin agent:

- "How is the system doing this week? Show error rate, the slowest traces and the top errors."
- "Find the account for jane@example.com, show its keys and sessions, and sign it out everywhere."
- "Grant 500 credits to that user for the outage, reason 'October incident', for this month only, and tell me the grant id."
- "Is billing healthy? Check webhook failures and any users whose plan doesn't match their subscription."
- "Show every settings change in the last 30 days and who made it."

## Things to ask your agent

- "Read https://stephango.com/saw and give me the three key ideas."
- "Before you read anything new, check my library for what we already know about this vendor."
- "Search my library for what I saved about vector databases last month."
- "Read this YouTube video's transcript and list the timestamps where pricing comes up."
- "Create a landing page from the `ads-landing` template for our research audience, show me the preview link, and don't publish yet."

## Credits

`read_url` (and `convert_url`) costs the same credits as any other conversion; cached reads are free. Reads such as `search_library`, `get_document` and `list_documents` are free. See [Billing & credits](/docs/billing).

## Protocol versions

One endpoint serves both protocol eras, and existing clients need no change.

- **2026-07-28 (stateless).** No `initialize`. Each request names its version in `params._meta["io.modelcontextprotocol/protocolVersion"]` and mirrors it in the `MCP-Protocol-Version` header, with `Mcp-Method` (and `Mcp-Name` for `tools/call`; non-ASCII values as `=?base64?…?=`). A header that disagrees with the body gets `400` with error `-32020`; an unknown version gets `400` with `-32022` and the supported list. `server/discover` describes the server; results carry `resultType`, and lists carry `ttlMs` and `cacheScope: "private"`. One message per request: no batches, no `ping`.
- **2025-11-25 and earlier.** `initialize` and `ping` work as before. JSON-RPC batches (up to 20 messages; each message counts toward the rate limits) work for clients on 2025-03-26 or earlier, or that send no `MCP-Protocol-Version` header; a batch sent with `2025-06-18` or later gets `400` with `-32600`, since those versions dropped batching. A message that is not a JSON object gets `-32600` without counting toward the limits.

## Rate limits

MCP has its own limits, separate from the REST API, counted per user and per credential (each API key or OAuth client has its own budget): one for every request and a stricter one for tools that change data. Changes also count against one budget for the whole account, so more keys or clients do not multiply it. Over the limit you get HTTP `429` with `Retry-After` and JSON-RPC error `-32005` (`data.bucket` is `request` or `mutation`; a batch gets an array with one error per request). Wait and retry.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A tool is missing | Your key or OAuth grant lacks its scope. Check with `GET /api/v1/me` or `anymd whoami`. |
| `401 invalid_api_key` | The key was revoked, expired or mistyped. Create a new one. |
| `402 quota_exceeded` | Free plan credits are used up for the month. |
| `revision_conflict` from `apply_page_ops` | Someone changed the page. Call `get_page`, then retry with the new `revision`. |
| Admin tools are missing over OAuth | Grants approved before least-privilege consent lose admin scopes. Reconnect and approve the admin scopes. |
| `403` with `insufficient_scope` | The OAuth grant lacks the tool's scope. Re-authorize with the scopes in the `WWW-Authenticate` header. |
| `429` / `-32005` | MCP rate limit. Wait for `Retry-After` seconds. |
| `-32020` or `-32022` | A 2026-07-28 client sent headers that don't match the body, or an unsupported version. |
