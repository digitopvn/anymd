---
title: "MCP server"
description: "Connect Claude Code, Claude Desktop, Cursor or any MCP client to anymd.cc/mcp so your agents can read the public web, remember it and search it, and get webhook events when it changes."
updated: "2026-10-28"
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

**OAuth 2.1.** For clients that support it, just add the URL and sign in when prompted. anymd supports the authorization code flow with PKCE (`S256` only), Client ID Metadata Documents (CIMD) and Dynamic Client Registration, and binds every token to the `https://anymd.cc/mcp` resource (RFC 8707): a token issued for another resource is refused.

| | |
|---|---|
| Protected resource metadata | `/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata | `/.well-known/oauth-authorization-server` |
| Authorize | `/oauth/authorize` |
| Token (and revocation) | `/oauth/token` |
| Registration (DCR) | `/oauth/register` |

The consent screen names the client. A client identified by a metadata document URL (ChatGPT uses `https://chatgpt.com/oauth/client.json`) also shows that URL, because its host proves who the client is; a registered client's name is only what it says about itself. If the request itself is wrong (a `resource` other than anymd's `/mcp`, or PKCE without S256), anymd sends you back to the client with `error`, `state` and `iss` once it has verified the client's redirect URI, and shows an error page otherwise. Tick **Read-only connection** to let the client read the web and search your library but never save, change, publish or delete anything: anymd drops every write scope from the grant and refuses those tools on every call, whatever the model asks.

Each tool in `tools/list` carries `securitySchemes` (`oauth2` with the scope it needs), and destructive tools such as `delete_document` are annotated `destructiveHint: true` so hosts ask you before running them. The server never relies on either: it checks the scope on every call.

Either way, your agent only sees the tools its scopes allow. An OAuth client that requests no scopes gets `convert`, `library:read` and `library:write` (read the web, save to and search your own library); anything more, admin scopes above all, must be requested by name and approved on the consent screen, or (owners and admins only) added by choosing an admin access option there: see [Set up an admin agent](#set-up-an-admin-agent). When a read is not saved, the result says so: `saved: false` with `not_saved_reason` (`missing_scope` means the connection lacks `library:write`). See [API keys & roles](/docs/api-keys-roles#oauth).

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

### Feedback

| Tool | Input | Needs |
|---|---|---|
| `submit_feedback` | `{ type, title, description, steps_to_reproduce?, expected_behavior?, actual_behavior?, reference_url?, context_page?, confirm_public, idempotency_key }` | `feedback:write` |
| `list_my_feedback` | `{ limit? }` | `feedback:write` |

`submit_feedback` publishes a public GitHub issue and cannot be undone: call it only when your user asked to send feedback and approved the text. See [Send feedback](/docs/feedback).

### Conversion and library

| Tool | Input | Needs |
|---|---|---|
| `read_url` | `{ url, save?, fresh?, removeImages?, expandThread?, maxThreadPosts?, includeComments?, analyzeImages?, maxComments?, maxImages?, maxCredits? }` | `convert` (saving also needs `library:write`) |
| `convert_url` | Same input as `read_url` | Same as `read_url`, kept under its original name for existing clients |
| `get_video_download` | `{ id }` | `convert` |
| `search_library` | `{ query, mode?, limit? }` | `library:read` |
| `search_social` | `{ platform, query, cursor?, period?, since?, until? }` (`platform` may be `all`) | `convert` (account required) |
| `get_document` | `{ id }` | `library:read` |
| `list_documents` | `{ limit?, domain?, tags?, before? }` | `library:read` |
| `list_tags` | `{ limit? }` | `library:read` |
| `tag_document` | `{ id, add?, remove?, set? }` | `library:write` |
| `delete_document` | `{ id }` | `library:write` |
| `usage_summary` | `{}` | `usage:read` |

`search_social` searches public posts on X, Facebook, Instagram, Threads, LinkedIn or all of them and returns normalized results with a per-platform status and a `next_cursor`. `period` (`24h`, `7d`, `30d`) or `since`/`until` (ISO-8601) limits it to a time range; posts are de-duplicated across every page of the search, and the cursor keeps the range, works once and lasts 24 hours. See [Social search](/docs/social-search). `read_url` and `convert_url` are the same tool with the same input and output; new integrations should use `read_url`. `mode` is `hybrid` (default), `bm25`, `fulltext` or `semantic`. See [Library & search](/docs/library-search).

`tag_document` adds and/or removes tags, or replaces them all with `set` (not combinable with `add`/`remove`; `[]` clears), and returns `{ id, tags }`. Tags are lowercased and keep only letters, digits, `-` and `_`; a document holds at most 20, and an edit past that fails with `too_many_tags` instead of dropping tags. `list_tags` returns `{ items: [{ tag, count }] }`, most used first. `list_documents` with `tags` keeps documents carrying every listed tag (whole-tag match, up to 10).

`expandThread`, `includeComments` and `analyzeImages` are opt-in deep reading flags that cost extra credits. Options the agent leaves out follow the account's saved [deep reading defaults](/docs/api#deep-reading-options-and-saved-defaults), otherwise they are off: connecting an agent never turns enrichment on by itself. `maxThreadPosts` defaults to 20 and is capped at 100; `maxCredits` defaults to 100 and is capped at 1,000; `maxComments` defaults to 100 and is capped at 1,000; `maxImages` defaults to 10 and is capped at 20. `removeImages` strips image/media URLs at no credit cost. X reads return the single requested post unless thread expansion is enabled. The response's `reading_options` shows each effective value and its source (`request`, `preference` or `default`). Social post adapters for Facebook, Instagram, Threads and LinkedIn require an account. The response includes `credit_breakdown` and `enrichment` coverage so partial provider, limit or timeout results are explicit; cached reads are free.

With `downloadVideo: true` (or the saved setting), a YouTube `read_url` also starts a background download of the lowest-quality video to the anymd CDN and returns `video_download.id`; the Markdown says the same. Call `get_video_download` with that id every 15–30 seconds until `status` is `ready` (`cdn_url` is the MP4) or `failed`. 20 credits are charged only when ready. See [Sources → YouTube](/docs/sources#video-download-to-the-anymd-cdn). With `analyzeVideo: true` (or the saved setting; it turns on the download too), the same job then gets an AI analysis of the video by `google/gemini-3.8-flash` (10 + 20 credits per started minute, charged when ready): keep calling `get_video_download` until `analysis.status` is `ready` (`analysis.markdown`) or `failed`.

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

- **Scoped.** Each tool needs one granular scope and is hidden without it. The one exception is `get_admin_access_status`, which every signed-in caller sees because it reports only on the caller. Owner-only tools (`update_user_role`, `grant_credits`, `revoke_credit_grant`) never appear for admins.
- **Ranked.** Nobody can act on their own account; admins only act on accounts ranked below them.
- **Bounded.** Every list is paginated: pass `next_cursor` back as `cursor`. There is no SQL or shell tool.
- **Safe to retry.** Mutations accept an `idempotencyKey` (required for `grant_credits`); a retry returns the first result with `replayed: true`, and a retry that arrives while the first attempt is still running gets `idempotency_in_progress` (retry shortly) instead of running the change twice. Changes guarded by `expectedRole` or `expectedVersion` fail with a conflict instead of overwriting someone else's change.
- **Audited.** Every change writes an audit row with the acting user, the API key or OAuth client, the tool (`via: mcp:<tool>`), the request id and a minimal diff. Secrets are never recorded or returned.
- **Billing stays with the provider.** Plans and subscriptions are read-only here. Use credit grants for support allowances: an active grant raises their allowance. By default a grant expires at the end of the current month (UTC), or at the end of next month when fewer than 7 days of this month remain; a grant without `recurring` is a one-time pool: its credits are spent once over its whole lifetime, so whatever one month uses is gone the next (5,000 granted on the 26th with 3,000 used that month leaves at most 2,000 for next month). Pass `recurring: true` (with or without `expiresAt`) for credits that renew in full every month; an `expiresAt` later than the default without `recurring: true` is `422`. On Pro and Scale, credits are used in this order: the plan's included credits, then grants, then paid overage. A grant covers usage from the moment it is granted onward and is not a refund: overage reported before it stays billed. Example: on a plan with 10,000 included credits, a 5,000-credit grant made when the account had used 12,000 this period keeps the next 5,000 credits (12,000 to 17,000) off the overage bill; the 2,000 used before the grant stay billed. Positions are counted within the current period of a monthly subscription, or the calendar month (UTC) otherwise.

Tool annotations tell the client what to expect: read tools are `readOnlyHint`, and tools that remove access or data (`set_user_status`, `revoke_*`, `remove_site_optout`, `update_settings`, `delete_post`, `archive_page`) are `destructiveHint`, so a well-behaved client asks before running them.

### Read tools

| Tool | Input | Needs |
|---|---|---|
| `get_admin_access_status` | `{}` | any signed-in caller |
| `system_overview` | `{}` | `system:read` |
| `get_user_stats` | `{}` | `system:read` |
| `get_operations_health` | `{}` | `system:read` |
| `list_failed_jobs` | `{ type?, since? (at most 30 days ago), userId?, cursor?, limit? }` | `system:read` |
| `get_job` | `{ jobId }` | `system:read` |
| `list_system_usage` | `{ days? (1–30, default 7), channel?, kind? }` | `system:read` |
| `list_system_traces` | `{ sort?, status?, kind?, userId?, since? (at most 30 days ago), cursor?, limit? }` | `system:read` |
| `get_system_trace` | `{ traceId }` | `system:read` |
| `list_users` | `{ search?, role?, plan?, status?, createdAfter?, createdBefore?, lastLoginAfter?, lastLoginBefore?, cursor?, limit? }` | `users:read` |
| `get_user` | `{ userId }` | `users:read` |
| `list_user_credentials` | `{ userId }` | `users:read` |
| `get_user_activity` | `{ userId, since? (at most 30 days ago), until?, cursor?, limit? }` | `users:read` |
| `list_roles` | `{}` | `users:read` |
| `list_audit_events` | `{ action?, actorUserId?, target?, targetType?, since?, until?, cursor?, limit? }` | `audit:read` |
| `list_subscriptions` | `{ status?, plan?, userId?, cursor?, limit? }` | `billing:read` |
| `get_subscription` | `{ subscriptionId }` | `billing:read` |
| `get_billing_diagnostics` | `{}` | `billing:read` |
| `get_customer_billing_summary` | `{ userId }` | `billing:read` (credit grants also need `credits:read`) |
| `list_billing_events` | `{ status?, provider?, type?, outcome?, since? (at most 90 days ago), cursor?, limit? }` | `billing:read` |
| `get_billing_event` | `{ eventId }` | `billing:read` |
| `list_credit_grants` | `{ userId?, state?, source?, cursor?, limit? }` | `credits:read` |
| `list_site_optouts` | `{ search?, cursor?, limit? }` | `optouts:read` |
| `get_settings` | `{}` | `settings:read` |

Timestamps accept epoch milliseconds or ISO 8601. `action` in `list_audit_events` takes an exact action or a prefix such as `user.*`.

### What the reports count

`get_user_stats` returns each number with its definition, the windows and a list of data coverage caveats, so the response is the reference. In short:

- **Active users (DAU/WAU/MAU)** are distinct signed-in users with usage (any channel, success or error) or a browser sign-in in the last 24 hours, 7 days or 30 days. Windows are rolling, in UTC, and end at `generated_at`. Anonymous usage is excluded.
- **Usage-active users** count usage only, without sign-ins, and are reported separately.
- **Activated users** have at least one document in their library. Creating an account is not activation.
- **Paying accounts** are users whose latest subscription entitles a non-free plan under the live billing provider's rules. The stored plan (`users.plan`) is reported separately, along with conflicts between the two.
- **Coverage.** Sign-ins come from sessions, which are deleted at sign-out and expiry, so sign-in activity can be undercounted. No bot, internal or test accounts are excluded. A user who deletes every document no longer counts as activated.

anymd stores the subscriptions that billing webhooks sync, not orders, invoices or payments. No tool reports revenue or MRR, and `get_customer_billing_summary` returns orders, invoices, payments, refunds and customers under `unsupported` instead of placeholders: look them up in the billing provider. The summary masks the user's email, and lists recent credit grants only when the caller also holds `credits:read`.

`get_user_activity` returns event metadata without URLs, search queries or document contents. `get_operations_health`, `list_failed_jobs` and `get_job` return metadata only: counts, statuses, timings and truncated errors with URLs redacted, never video analysis text, feedback text or storage keys. Optional integrations are reported as configured or not (`true`/`false`), never their values. Retrying a failed job is not exposed.

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

Admin access is never granted by default. Give the agent only what its job needs, through one of these routes.

**OAuth clients (Claude, ChatGPT).** Connect anymd as usual. If you are an owner or admin, the consent screen offers **Admin access for this connection**: **None** (the default), **Admin read-only (monitoring and reports)** or **Support agent**. Each option lists the scopes it adds. Your role caps the result, and is applied again on every call, so a demotion removes admin access from the connection immediately. Owner-only scopes (`users:roles:write`, `credits:write`, `billing:write`) are never added from the consent screen; use an API key for those. Roles below admin never see the option. To change an existing connection, disconnect anymd in the client and connect again.

**OAuth step-up.** A client that can re-authorize does not need the consent option. When it calls a tool whose scope the grant lacks but your role allows, anymd answers `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` listing the current scopes plus the missing one, and the client re-authorizes with them. Where such a denial comes back as a tool result instead (inside a batch), the result carries the same challenge in `_meta["mcp/www_authenticate"]`, which ChatGPT uses to start linking again.

**API key.** Create a key from a preset (**Dashboard → API keys**, or `create_api_key`), capped by your role like every key:

| Job | Preset |
|---|---|
| Monitoring and reports | `admin-read-only` |
| Support: sign users out, suspend, revoke credentials, grant credits (owner, API key only) | `support` |
| Site operations: settings and opt-outs | `site-ops` |

```bash
claude mcp add --transport http anymd-admin https://anymd.cc/mcp \
  --header "Authorization: Bearer amd_…"
```

With an API key, calling a tool whose scope the key lacks returns a tool error with code `insufficient_scope`; create a key that includes the scope. When your role does not allow the scope at all, the code is `forbidden`. How the consent options relate to the key presets: [API keys & roles](/docs/api-keys-roles#oauth).

**Troubleshooting.** Ask the agent to call `get_admin_access_status`. It reports only on you: your role, this credential's scopes, the admin tools available now and after reconnecting, and the exact steps to fix the connection (for OAuth, also the step-up scope set). `state` is one of:

| `state` | Meaning |
|---|---|
| `not_eligible` | Your role has no admin access. Only an owner can change roles; nothing a client or key requests adds it. |
| `not_granted` | Your role allows admin access, but this connection holds no admin scopes. Reconnect with an admin option, or use a key from an admin preset. |
| `partial` | The connection holds some of the admin scopes your role allows. `admin.missing` lists the rest. |
| `full` | The connection holds every admin scope your role allows. |

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

`read_url` (and `convert_url`) costs the same credits as any other conversion; cached reads are free. `search_social` costs 10 credits for each page where the platform returns posts (100 on LinkedIn; `all` costs the sum for the platforms that returned posts), even when filtering removes them; pages where the platform returns nothing are free. Reads such as `search_library`, `get_document` and `list_documents` are free. See [Billing & credits](/docs/billing).

## Protocol versions

One endpoint serves both protocol eras, and existing clients need no change.

- **2026-07-28 (stateless).** No `initialize`. Each request names its version in `params._meta["io.modelcontextprotocol/protocolVersion"]` and mirrors it in the `MCP-Protocol-Version` header, with `Mcp-Method` (and `Mcp-Name` for `tools/call`; non-ASCII values as `=?base64?…?=`). A header that disagrees with the body gets `400` with error `-32020`; an unknown version gets `400` with `-32022` and the supported list. `server/discover` describes the server; results carry `resultType`, and lists carry `ttlMs` and `cacheScope: "private"`. One message per request: no batches, no `ping`.
- **2025-11-25 and earlier.** `initialize` and `ping` work as before. JSON-RPC batches (up to 20 messages; each message counts toward the rate limits) work for clients on 2025-03-26 or earlier, or that send no `MCP-Protocol-Version` header; a batch sent with `2025-06-18` or later gets `400` with `-32600`, since those versions dropped batching. A message that is not a JSON object gets `-32600` without counting toward the limits.

## Events (webhooks)

MCP Events let an agent hear about changes to its own account instead of polling: anymd POSTs a small signed message to an HTTPS endpoint you run. Events are opt-in and exist only on the `2026-07-28` protocol. When the deployment offers them, `server/discover` lists `capabilities.events`; 2025-era clients see nothing new and keep working unchanged.

An event says *what* changed, never the content. Fetch details with the normal tools (`get_document`, `get_video_download`, `list_my_feedback`) under their normal scopes. A subscription grants nothing on its own: it never spends credits, never submits feedback or GitHub issues, and acting on an event goes through the same tool authorization as any other call.

There is no REST or CLI way to subscribe: events are MCP-only. In **Dashboard → Event subscriptions** (`/dashboard/events`) you can see your subscriptions with their delivery health, and delete one.

### Event catalog

Every event is about your own resources, and is listed by `events/list` only when your credential holds its scope.

| Event | Fires when | Needs | Arguments (all optional) |
|---|---|---|---|
| `anymd.library.document.saved` | A document was created or its content changed (a re-read with unchanged content does not fire) | `library:read` | `document_ids`, `tags`, `domain`, `exclude_self` |
| `anymd.library.document.deleted` | A document was deleted | `library:read` | `document_ids`, `exclude_self` |
| `anymd.library.tags.updated` | A document's tags changed (an edit that changes nothing does not fire) | `library:read` | `document_ids`, `tags`, `exclude_self` |
| `anymd.video.ready` · `anymd.video.failed` | A YouTube video download you started is ready, or failed for good | `convert` | `job_ids` |
| `anymd.video.analysis.ready` · `anymd.video.analysis.failed` | The AI analysis of one of your videos is ready, or failed for good | `convert` | `job_ids` |
| `anymd.feedback.status.changed` | Feedback you sent reached `created` (a GitHub issue exists), `needs_review` or `failed` | `feedback:write` | `feedback_ids` |

- `document_ids`, `job_ids`, `feedback_ids`: only these ids (up to 50). Omit for all of yours.
- `tags`: only documents carrying every one of these tags when the event is matched to subscriptions, shortly after the change. `domain`: only documents from this domain or its subdomains, e.g. `example.com`.
- `exclude_self` (default `true`): skip library changes made with the same credential that subscribed, so an agent does not react to its own writes. Set it to `false` to hear them too.

Payloads are minimal: the resource id (`document_id`, `job_id` or `feedback_id`), `resource_type`, what happened (`change`: `created`/`updated`, `status`, `tag_count`, `error_code`, `issue_number`), `version` (the resource's last-change time in ms) and `correlation_id` (the request that made the change, when there was one). `events/list` returns the exact `inputSchema` and `payloadSchema` of each event.

### Subscribe, refresh, unsubscribe

Only API keys and OAuth credentials can subscribe. Pick a random secret of 24 to 64 bytes, encode it as `whsec_` + base64, and send it with the subscription:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "events/subscribe",
  "params": {
    "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    "name": "anymd.library.document.saved",
    "arguments": { "tags": ["research"] },
    "delivery": { "mode": "webhook", "url": "https://agent.example.com/anymd-events", "secret": "whsec_…" },
    "ttlMs": 3600000
  }
}
```

The result is `{ id, refreshBefore, cursor: null, truncated }`.

- **Identity.** `id` (`sub_…`) is derived from your credential, the URL, the event name and the arguments, so subscribing again with the same four values refreshes the same subscription instead of creating a new one. The refresh result adds `deliveryStatus` (`active`, `lastDeliveryAt`, `lastError`, `failedSince`).
- **Lifetime.** `ttlMs` defaults to one hour, is clamped to between 60 seconds and 24 hours, and `null` asks for the 24-hour maximum. Subscribe again before `refreshBefore`, or the subscription lapses.
- **Verification.** The first subscription for a credential and URL pair triggers a signed POST `{"type":"verification","challenge":"…"}`. Your endpoint must answer `2xx` with `{"challenge":"<the same value>"}`. One handshake covers every event and argument set on that URL for that credential.
- **No replay.** Events start from the moment you subscribe. `cursor` is always `null`; if you send one, the result says `truncated: true`.
- **Secret rotation.** Refresh with a new `secret`. For the next hour each message is signed with both the new and the old secret.
- **Limits.** At most 20 live subscriptions per account (`-32013` beyond that). Each subscription keeps at most 500 undelivered events; past that, new events for it are dropped until its endpoint catches up. Other subscriptions are unaffected. `events/subscribe` and `events/unsubscribe` count toward the stricter MCP rate limit for changes.

To stop, call `events/unsubscribe` with the same `name`, `arguments` and `delivery.url` you subscribed with, from the same credential. Deleting a subscription in the dashboard works too.

### Delivery

Messages follow [Standard Webhooks](https://www.standardwebhooks.com/). Each POST carries:

| Header | Value |
|---|---|
| `webhook-id` | The event id. Deliveries are at-least-once: deduplicate on it |
| `webhook-timestamp` | Unix seconds when this attempt was sent |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` over `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the base64-decoded part of your `whsec_` secret. Several space-separated signatures during a secret rotation |
| `X-MCP-Subscription-Id` | The subscription `id` |

The body of an event is `{ "eventId", "name", "timestamp", "data", "cursor": null }`, where `data` is the payload above and `timestamp` is when the change happened. Bodies are capped at 256 KiB.

- **Retries.** A network error, timeout or non-`2xx` answer is retried after 1, 2, 4 and 8 minutes (5 attempts). `413` is never retried. `410 Gone` ends the subscription without a termination message. Redirects are never followed and count as a failure.
- **Dead letters.** When all attempts fail, the event is dead-lettered and the subscription is suspended: its other queued events are dead-lettered too, and nothing more is sent until your client subscribes again. Delivery then resumes with new events only.
- **Termination.** If the subscribing credential is revoked, expires or loses the event's scope, the account is suspended, or you delete the subscription in the dashboard, the subscription ends and your endpoint gets a signed `{"type":"terminated","error":{"code":-32012,"message":"Forbidden","data":{"reason":"…"}}}`. The credential is checked before every delivery. Deleting your account removes its subscriptions without a termination message.
- **Retention.** Delivery records are kept 7 days; dead letters and events, 30 days.

Verify every message, including the verification and termination messages, before acting on it. In Node or TypeScript:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

// The whsec_… secret you sent in events/subscribe. Keep it out of source control.
export function verifyWebhook(secret: string, headers: Headers, body: string): boolean {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // refuse stale or replayed messages
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    const got = Buffer.from(value ?? '', 'base64');
    return version === 'v1' && got.length === expected.length && timingSafeEqual(got, expected);
  });
}
```

Verify against the raw request body, before parsing it. Then answer `{"type":"verification"}` by echoing its `challenge`, stop on `{"type":"terminated"}`, and treat anything with an `eventId` as an event: skip ids you have already seen, then fetch what you need with the tools.

### Callback URL rules

The URL must be `https`, at most 2048 characters, without credentials or a `#fragment`, and on a public host that is not anymd itself. anymd resolves the host and requires every address to be public, both when you subscribe and again before every POST, so a host that later points at a private address is refused. A Worker cannot pin a connection to the address it checked, so a short window between check and connect remains; keep your endpoint on a host you control.

### Errors

| Code | Meaning |
|---|---|
| `-32602` | Invalid params: unknown argument, bad URL, non-public host, malformed secret, bad `ttlMs` |
| `-32011` | Not found: unknown event name, or no matching subscription to unsubscribe |
| `-32012` | Forbidden: your credential lacks the event's scope (`data.required`) |
| `-32013` | Resource exhausted: 20 live subscriptions, or too many verification attempts for one host |
| `-32014` | Unsupported: a delivery `mode` other than `webhook` |
| `-32015` | Callback endpoint error: the endpoint could not be reached or did not echo the challenge (`data.reason`) |

`events/*` methods answer `-32601` (method not found) on 2025-era protocol versions, and wherever `server/discover` does not list `capabilities.events`. These event codes follow the numbering ChatGPT implements today. The MCP Events draft may renumber them to `-32023`…`-32027` in the same order; anymd will follow when it settles.

### What this is not

- **Not Claude Channels.** Channels is a Claude Code feature that pushes messages into a running Claude Code session. anymd does not implement it; MCP Events deliver to a webhook endpoint you run.
- **Not social monitoring.** There are no recurring watches or saved searches. `search_social` is a one-shot search and emits no events.

## Rate limits

MCP has its own limits, separate from the REST API, counted per user and per credential (each API key or OAuth client has its own budget): one for every request and a stricter one for tools that change data. Changes also count against one budget for the whole account, so more keys or clients do not multiply it. Over the limit you get HTTP `429` with `Retry-After` and JSON-RPC error `-32005` (`data.bucket` is `request` or `mutation`; a batch gets an array with one error per request). Wait and retry.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A tool is missing | Your key or OAuth grant lacks its scope. Check with `GET /api/v1/me` or `anymd whoami`. |
| `401 invalid_api_key` | The key was revoked, expired or mistyped. Create a new one. |
| `401 invalid_token` over OAuth | The token expired, the connection was revoked (Dashboard → API keys, or account deletion), you connected the same client again (a new consent replaces the earlier connection), or it was issued for another resource. Clients refresh or reconnect from the `WWW-Authenticate` challenge. A suspended account gets the same answer and cannot refresh; once it is reactivated, connect again. |
| `429` with `rate_limited` before any tool runs | Too many failed sign-ins (bad keys or tokens) from your address in a minute. Fix the credential, then wait for `Retry-After`. |
| `402 quota_exceeded` | Free plan credits are used up for the month. |
| `revision_conflict` from `apply_page_ops` | Someone changed the page. Call `get_page`, then retry with the new `revision`. |
| Admin tools are missing | Call `get_admin_access_status`: it says whether your role allows admin access and how to reconnect. See [Set up an admin agent](#set-up-an-admin-agent). |
| `403` with `insufficient_scope` | The OAuth grant lacks the tool's scope. Re-authorize with the scopes in the `WWW-Authenticate` header. |
| `429` / `-32005` | MCP rate limit. Wait for `Retry-After` seconds. |
| `-32020` or `-32022` | A 2026-07-28 client sent headers that don't match the body, or an unsupported version. |
