# Architecture

Maintainer map of anymd.cc. Public behavior is documented in `src/content/docs/` (served at `/docs`); this file explains where things live and why they are shaped this way. When prose and code disagree, the code wins. Fix the prose.

## One Worker

Everything (marketing pages, dashboard, URL API, REST API, MCP, OAuth, webhooks, `.md` twins) is one Cloudflare Worker built with Hono. The entry point is `main` in `wrangler.jsonc`.

Why one Worker: every channel (URL, web, REST, CLI, MCP, WebMCP) must return byte-identical conversions and share auth, quotas and usage logs. One deployable keeps that invariant cheap. Split only if a real limit (bundle size, CPU) forces it.

| Platform piece | Binding | Role |
|---|---|---|
| D1 (SQLite) | `DB` | System of record, FTS5 full-text index |
| KV | `CACHE` | Conversion cache, anonymous counters, page cache, small memo caches |
| KV | `OAUTH_KV` | `@cloudflare/workers-oauth-provider` state for MCP OAuth |
| R2 | `MEDIA` | Media, OG images, CLI tarball, served from `CDN_URL` |
| Vectorize | `VECTORS` | Chunk embeddings, metadata `user_id`, `doc_id` |
| Workers AI | `AI` | Embeddings, query fan-out fallback, `toMarkdown` for files |
| Rate limiting | `RL_ANON`, `RL_AUTH`, `RL_DOMAIN` | Per-minute limits per caller, and per fetched site |
| Static assets | `ASSETS` | `public/` (built CSS/JS, icons, brand) |
| Queue | `VIDEO_QUEUE` | Background YouTube video downloads; the same Worker's `queue` handler consumes it |
| Cron trigger | `triggers.crons` | Every minute, the Worker's `scheduled` handler: MCP Events delivery each minute; feedback retries, social search session sweep and event pruning every tenth minute |

Bindings and secrets are typed in `src/env.ts`; per-environment values are in `wrangler.jsonc`.

## Module map

| Path | Owns |
|---|---|
| `src/convert/` | URL normalisation + SSRF guard (`index.ts`), adapter registry and order, the single conversion pipeline (`service.ts`), per-source adapters, bounded enrichment (`enrichment-types.ts`, `image-enrichment.ts`, `x-thread.ts`, and social adapters), social search across X, Facebook, Instagram, Threads and LinkedIn (`social-search.ts` for validation, credits, usage and history; `social-search-providers.ts` for provider calls, result normalization and which providers filter by date natively (`SOCIAL_DATE_FILTER`); `social-search-results.ts` for time ranges, exact post identity, de-duplication and date filtering as pure functions; `social-search-session.ts` for single-use paging cursors), reading preferences and option precedence (`reading-preferences.ts`; bounds and defaults shared with the browser in `src/lib/reading-options.ts`), file conversion (`document.ts`) |
| `src/library/` | Library persistence and embeddings (`store.ts`), search modes, fan-out and RRF (`search.ts`), Jev tie-break (`jev.ts`) |
| `src/auth/` | Principal resolution, scope guards, same-origin writes (`middleware.ts`), users/sessions/API keys (`identity.ts`), role templates and key presets (`roles.ts`) |
| `src/billing/` | Plans, credit table, offers (`plans.ts`); `provider.ts` routes checkout and portal to the provider named by `BILLING_PROVIDER`: Creem (`creem.ts`: checkout, portal, webhooks) or Polar (`polar.ts`: also usage ingest for metered overage) |
| `src/cms/` | Page-builder block registry (`blocks.ts`) and page document service: ops, revisions, publish (`pages.ts`) |
| `src/services/admin/` | The admin control plane: users, credentials, settings, opt-outs, credits, billing (read-only), audit and observability. Each service checks its scope, validates input, enforces rank rules, applies idempotency and optimistic concurrency, and writes the audit row in the same D1 batch as the change. REST, web admin and MCP are thin adapters over it |
| `src/events/` | MCP Events webhooks: event catalog and scopes (`catalog.ts`), `events/*` methods and dashboard queries (`subscriptions.ts`), transactional outbox (`outbox.ts`), fan-out, signed delivery, retries, revocation and pruning (`delivery.ts`), callback URL SSRF guard (`callback-url.ts`), signatures, ids and at-rest secret encryption (`crypto.ts`) |
| `src/lib/` | Usage + quota accounting (`usage.ts`), tracer, Markdown rendering (`markdown.ts`), email, utilities |
| `src/content/` | Bundled Markdown (blog, docs, legal) and site copy (`site.ts`); loader in `index.ts` |
| `src/views/` | Hono JSX layouts and pages |
| `src/routes/`, `src/mcp/` | HTTP routes and the MCP server. `src/mcp/protocol.ts` serves the 2026-07-28 stateless protocol and 2025-era clients from one endpoint; `rate-limit.ts` holds the MCP buckets; tools live in `server.ts` plus `cms-parity-tools.ts`, `account-tools.ts` and `admin-tools.ts` |
| `client/` | Browser islands, bundled by `scripts/build-client.mjs` |
| `cli/` | The `anymd` CLI (zero dependencies) |
| `migrations/` | D1 schema |

## Request flow

### Principal

`resolvePrincipal` (`src/auth/middleware.ts`) runs once per request: API key (`Authorization: Bearer` or `X-API-Key`) → session cookie → anonymous. A presented key that doesn't resolve is a hard `401`, never a silent downgrade to anonymous. Key scopes are intersected with the owner's **current** role on every request (`capScopes`), so demotion takes effect immediately without key rotation. Suspended accounts resolve to no principal for sessions, keys and OAuth. OAuth grants are re-capped the same way (`oauthPrincipalScopes`); grants from before least-privilege consent keep no admin scopes.

### Conversion

`runConversion` (`src/convert/service.ts`) is the only conversion path. In order:

1. `normalizeTargetUrl`: coerce to absolute http(s), reject private, internal, self-referential and credentialed targets.
2. Resolve reading options with `resolveReadingOptions`: explicit request option > the signed-in user's saved `reading_preferences` row > safe default (every credit-consuming enrichment off). The effective values and their sources go into the response (`reading_options`) and the trace meta.
3. Cache lookup keyed on URL + language + selector + the effective reading options (not on the caller's identity), unless `fresh`.
4. On a miss: quota check (signed-in) or anonymous daily counter, then `pickAdapter` → adapter. Adapters are tried in registry order; the web adapter is the fallback and itself hands binary responses to `document.ts`.
5. Credits come from the adapter's resulting `sourceKind`. The quota pre-check uses the cheapest cost because the kind is unknown until the adapter runs.
6. Save to the library when signed in, `save !== false` and the principal has `library:write`. Embedding, usage recording and (when Polar is the provider) Polar usage ingest run in `waitUntil` so they never add latency or fail the request.

YouTube video download (`downloadVideo`) and analysis (`analyzeVideo`) are reading options like the others: per request or saved, off by default, account only; an explicit `analyzeVideo` turns the download on. When the download is on, a YouTube read creates (or reuses) a `video_jobs` row and enqueues it after the cache step, so the job id is per account and never cached; the response and Markdown carry the job id and how to poll it (`GET /api/v1/videos/:id`, MCP `get_video_download`). The queue consumer in `src/convert/youtube-video.ts` resolves the lowest-quality MP4 through VidCap, falling back to RapidAPI ytstream when VidCap cannot resolve or serve the stream, accepts only YouTube media hosts, streams it into R2 and charges credits once, when the job reaches `ready`. With `analyzeVideo`, the job also carries an analysis step: once the download is ready the consumer enqueues `{ jobId, step: 'analyze' }`, checks the length-based price (10 + 20 per started minute, videos up to 60 minutes) against the account, claims the job (`analysis_status` queued → running), sends the CDN URL to `google/gemini-3.8-flash` through OpenRouter, and records a separate `video_analysis` charge plus the upstream cost (`analysis_cost_usd`) when the analysis is ready.

X thread expansion (bounded by `maxThreadPosts`), comments and article-image analysis are explicit opt-ins (per request or saved preference); authentication alone never enables them. Base-only conversions reserve only the base price, and Facebook, Instagram, Threads and LinkedIn adapters require an account. Enrichment coverage is returned with the conversion so provider failures, limits and timeouts remain visible instead of looking complete; the executable bounds and unit prices live in `src/convert/enrichment-types.ts` and `src/billing/plans.ts`.

Why a caller-independent cache: identical URLs are converted once per hour for everyone, and cached hits are free, which is the pricing promise.

### Search

`searchLibrary` (`src/library/search.ts`): optional fan-out → per-variant retrievers (BM25 / FTS / semantic) in parallel → Reciprocal Rank Fusion (k = 60) → hydrate from D1 → optional Jev reorder when the top two are within the ambiguity ratio. Semantic failures degrade to keyword results. Every retriever is filtered by `user_id` before ranking.

Why RRF: it fuses BM25 and cosine rankings without normalising incomparable scores. Why Jev is advisory only: it sees already-scoped candidates, has a hard timeout, a confidence floor and a margin, and any failure keeps the fused order.

### Social search paging

`runSocialSearch` (`src/convert/social-search.ts`) resolves a `period` to an absolute UTC range once, on the first page, and stores it with the provider cursors and the post identities already returned in a `social_search_sessions` row. The public `next_cursor` is only a handle to that row plus its `version`. A page first takes a two-minute lease on the row for that version (a compare-and-swap on `version` and `lease_until`), settles credits, then stores the next state and moves `version` on in one update that requires the lease. A page that fails before delivering anything gives the lease back so the same cursor can be retried at once; a request that dies mid-page (client gone, isolate evicted) frees it when the lease runs out, so a cursor is never stranded. Each user keeps at most 50 sessions; the least recently used are dropped first.

Why server-side sessions instead of a self-describing cursor: cross-page de-duplication needs the identities of every post already returned (up to the session's remembered-post limit), which a client-held cursor could not carry or be trusted with, and the version check and lease make a replayed or concurrent cursor fail with `409` instead of charging twice. Why billing ignores filtering: the provider is paid for every page it returns, so a platform that returned posts is charged even when de-duplication or the range removes all of them.

### MCP Events

Modern-era MCP clients (`2026-07-28`) can subscribe a webhook to events about their own library, video jobs and feedback; `src/mcp/server.ts` routes `events/*` to `src/events/subscriptions.ts` only for that era, only for API-key and OAuth principals, and only when `EVENTS_SECRET_KEY` is set. The public contract is the Events section of `src/content/docs/mcp.md`.

Writers call `writeWithEvents` (`src/events/outbox.ts`), which puts the event row into `event_outbox` in the same `DB.batch` as the change, guarded by SQLite `changes()`, and only when the owner has a live subscription to that event. Delivery (`src/events/delivery.ts`) fans outbox rows out to `event_deliveries`, then POSTs them, starting in `waitUntil` right after the change and continuing on the per-minute cron.

Why an outbox in the same batch: an event exists exactly when its change committed, so a rolled-back write never fires and a committed one is never lost to a crash between write and send. Terminal video and feedback transitions use deterministic event ids (`stableEventId`), so a redelivered queue message or a retried status update cannot emit twice. Why the credential is re-checked before every POST instead of at subscribe only: revoking a key, narrowing its scopes, losing a role or suspending an account must stop deliveries at once, matching how `capScopes` treats requests. Why events carry only ids and versions: a subscription grants nothing, so the content stays behind the normal, separately authorized tools. Why callbacks get their own guard (`callback-url.ts`) instead of `normalizeTargetUrl`: a delivery is a privileged, signed POST, so it requires https, re-resolves the host over DNS-over-HTTPS before every send and never follows redirects. Its residual DNS-rebinding window is documented in that file.

### Pages

`applyPageOps` (`src/cms/pages.ts`) is shared by the editor UI, REST, CLI, MCP and WebMCP. Ops apply to a clone, validate per block against the zod schemas in `blocks.ts`, and persist with `UPDATE … WHERE revision = ?` so concurrent writers can't both win. Idempotency keys are stored per principal with a payload hash. See `docs/page-builder-operations.md`.

## Data model

The schema is owned by `migrations/`. Tables group as:

| Area | Tables | Notes |
|---|---|---|
| Identity | `users`, `sessions`, `api_keys`, `reading_preferences` | Sessions and keys store SHA-256 hashes, never raw tokens. Key `scopes` is a JSON array. `users.status` (`active`/`suspended`) gates every credential. `reading_preferences` holds one zod-validated JSON object per user; no row means the safe defaults. |
| Library | `documents`, `documents_fts` | Unique per `(user_id, url_hash)`. FTS5 is an external-content table kept in sync by triggers. `embedded_chunks` tracks vectors `<doc_id>#<n>` in Vectorize. |
| Video | `video_jobs` | One row per background YouTube download: status, CDN URL, credits charged at `ready`. |
| Metering | `usage_events`, `traces` | Monthly credit use is summed from `usage_events` since the UTC month start. |
| Social search | `social_searches`, `social_search_sessions` | `social_searches`: saved search pages with their results (JSON) for the dashboard history, plus `filters_json` (time range, removal counts, coverage; `NULL` on rows saved before filters); the newest 200 per user are kept. `social_search_sessions`: paging state per search (provider cursors, resolved range, identities of posts already returned), expiring after 24 hours and swept by the scheduled handler. |
| MCP Events | `event_subscriptions`, `event_outbox`, `event_deliveries` | Subscription id is derived from (credential, callback URL, event name, canonical arguments); the callback secret is stored AES-GCM-encrypted with a key derived from `EVENTS_SECRET_KEY`. `event_outbox` is written in the same batch as the change; `event_deliveries` holds per-subscription retry and dead-letter state. Not to be confused with billing `subscriptions` or `webhook_events`. |
| Billing | `subscriptions`, `credit_grants`, `webhook_events` | `webhook_events` makes Creem and Polar webhook handling idempotent and records the provider and outcome. `users.creem_customer_id` opens the Creem portal. Credit grants carry reason, actor, idempotency key and revocation; only active grants raise the allowance. Plans are owned by the billing provider. |
| Content | `posts`, `pages`, `page_revisions`, `idempotency_keys` | Page `draft`/`published` are JSON page documents. |
| Admin | `audit_log`, `settings`, `settings_state`, `site_optouts`, `stats` | Every privileged change writes `audit_log` with actor, auth kind, credential, `via`, request id and a scrubbed diff. `settings_state.version` makes settings writes optimistic. |

Add schema changes as a new numbered file in `migrations/`; never edit an applied migration.

## Graceful degradation

Every secret in `src/env.ts` is optional. Missing key for the `BILLING_PROVIDER` provider → no billing; missing transcript keys → YouTube without transcripts; missing `RAPIDAPI_KEY` → social adapters are unavailable; missing `OPENROUTER_API_KEY` → image analysis is unavailable while fan-out can still use Workers AI and Jev can remain disabled; missing Resend → no email. Missing `EVENTS_SECRET_KEY` → no MCP Events: `server/discover` omits the capability and no outbox rows are written. Image analysis uses the `qwen/qwen3.6-35b-a3b` model when OpenRouter is configured. Keep new integrations behind the same pattern: detect the secret, do nothing harmful without it.
