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

Bindings and secrets are typed in `src/env.ts`; per-environment values are in `wrangler.jsonc`.

## Module map

| Path | Owns |
|---|---|
| `src/convert/` | URL normalisation + SSRF guard (`index.ts`), adapter registry and order, the single conversion pipeline (`service.ts`), per-source adapters, bounded enrichment (`enrichment-types.ts`, `image-enrichment.ts`, `x-thread.ts`, and social adapters), social search across X, Facebook, Instagram, Threads and LinkedIn (`social-search.ts` for validation, credits and usage; `social-search-providers.ts` for provider calls and result normalization), reading preferences and option precedence (`reading-preferences.ts`; bounds and defaults shared with the browser in `src/lib/reading-options.ts`), file conversion (`document.ts`) |
| `src/library/` | Library persistence and embeddings (`store.ts`), search modes, fan-out and RRF (`search.ts`), Jev tie-break (`jev.ts`) |
| `src/auth/` | Principal resolution, scope guards, same-origin writes (`middleware.ts`), users/sessions/API keys (`identity.ts`), role templates and key presets (`roles.ts`) |
| `src/billing/` | Plans, credit table, offers (`plans.ts`); `provider.ts` routes checkout and portal to the provider named by `BILLING_PROVIDER`: Creem (`creem.ts`: checkout, portal, webhooks) or Polar (`polar.ts`: also usage ingest for metered overage) |
| `src/cms/` | Page-builder block registry (`blocks.ts`) and page document service: ops, revisions, publish (`pages.ts`) |
| `src/services/admin/` | The admin control plane: users, credentials, settings, opt-outs, credits, billing (read-only), audit and observability. Each service checks its scope, validates input, enforces rank rules, applies idempotency and optimistic concurrency, and writes the audit row in the same D1 batch as the change. REST, web admin and MCP are thin adapters over it |
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

X thread expansion (bounded by `maxThreadPosts`), comments and article-image analysis are explicit opt-ins (per request or saved preference); authentication alone never enables them. Base-only conversions reserve only the base price, and Facebook, Instagram, Threads and LinkedIn adapters require an account. Enrichment coverage is returned with the conversion so provider failures, limits and timeouts remain visible instead of looking complete; the executable bounds and unit prices live in `src/convert/enrichment-types.ts` and `src/billing/plans.ts`.

Why a caller-independent cache: identical URLs are converted once per hour for everyone, and cached hits are free, which is the pricing promise.

### Search

`searchLibrary` (`src/library/search.ts`): optional fan-out → per-variant retrievers (BM25 / FTS / semantic) in parallel → Reciprocal Rank Fusion (k = 60) → hydrate from D1 → optional Jev reorder when the top two are within the ambiguity ratio. Semantic failures degrade to keyword results. Every retriever is filtered by `user_id` before ranking.

Why RRF: it fuses BM25 and cosine rankings without normalising incomparable scores. Why Jev is advisory only: it sees already-scoped candidates, has a hard timeout, a confidence floor and a margin, and any failure keeps the fused order.

### Pages

`applyPageOps` (`src/cms/pages.ts`) is shared by the editor UI, REST, CLI, MCP and WebMCP. Ops apply to a clone, validate per block against the zod schemas in `blocks.ts`, and persist with `UPDATE … WHERE revision = ?` so concurrent writers can't both win. Idempotency keys are stored per principal with a payload hash. See `docs/page-builder-operations.md`.

## Data model

The schema is owned by `migrations/`. Tables group as:

| Area | Tables | Notes |
|---|---|---|
| Identity | `users`, `sessions`, `api_keys`, `reading_preferences` | Sessions and keys store SHA-256 hashes, never raw tokens. Key `scopes` is a JSON array. `users.status` (`active`/`suspended`) gates every credential. `reading_preferences` holds one zod-validated JSON object per user; no row means the safe defaults. |
| Library | `documents`, `documents_fts` | Unique per `(user_id, url_hash)`. FTS5 is an external-content table kept in sync by triggers. `embedded_chunks` tracks vectors `<doc_id>#<n>` in Vectorize. |
| Metering | `usage_events`, `traces` | Monthly credit use is summed from `usage_events` since the UTC month start. |
| Social search | `social_searches` | Saved search pages with their results (JSON) for the dashboard history; the newest 200 per user are kept. |
| Billing | `subscriptions`, `credit_grants`, `webhook_events` | `webhook_events` makes Creem and Polar webhook handling idempotent and records the provider and outcome. `users.creem_customer_id` opens the Creem portal. Credit grants carry reason, actor, idempotency key and revocation; only active grants raise the allowance. Plans are owned by the billing provider. |
| Content | `posts`, `pages`, `page_revisions`, `idempotency_keys` | Page `draft`/`published` are JSON page documents. |
| Admin | `audit_log`, `settings`, `settings_state`, `site_optouts`, `stats` | Every privileged change writes `audit_log` with actor, auth kind, credential, `via`, request id and a scrubbed diff. `settings_state.version` makes settings writes optimistic. |

Add schema changes as a new numbered file in `migrations/`; never edit an applied migration.

## Graceful degradation

Every secret in `src/env.ts` is optional. Missing key for the `BILLING_PROVIDER` provider → no billing; missing transcript keys → YouTube without transcripts; missing `RAPIDAPI_KEY` → social adapters are unavailable; missing `OPENROUTER_API_KEY` → image analysis is unavailable while fan-out can still use Workers AI and Jev can remain disabled; missing Resend → no email. Image analysis uses the `qwen/qwen3.6-35b-a3b` model when OpenRouter is configured. Keep new integrations behind the same pattern: detect the secret, do nothing harmful without it.
