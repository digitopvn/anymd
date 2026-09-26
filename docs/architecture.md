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
| Rate limiting | `RL_ANON`, `RL_AUTH` | Per-minute limits |
| Static assets | `ASSETS` | `public/` (built CSS/JS, icons, brand) |

Bindings and secrets are typed in `src/env.ts`; per-environment values are in `wrangler.jsonc`.

## Module map

| Path | Owns |
|---|---|
| `src/convert/` | URL normalisation + SSRF guard (`index.ts`), adapter registry and order, the single conversion pipeline (`service.ts`), per-source adapters, file conversion (`document.ts`) |
| `src/library/` | Library persistence and embeddings (`store.ts`), search modes, fan-out and RRF (`search.ts`), Jev tie-break (`jev.ts`) |
| `src/auth/` | Principal resolution, scope guards, same-origin writes (`middleware.ts`), users/sessions/API keys (`identity.ts`), role templates and key presets (`roles.ts`) |
| `src/billing/` | Plans, credit table, offers (`plans.ts`), Polar checkout/portal/webhooks/usage ingest (`polar.ts`) |
| `src/cms/` | Page-builder block registry (`blocks.ts`) and page document service: ops, revisions, publish (`pages.ts`) |
| `src/lib/` | Usage + quota accounting (`usage.ts`), tracer, Markdown rendering (`markdown.ts`), email, utilities |
| `src/content/` | Bundled Markdown (blog, docs, legal) and site copy (`site.ts`); loader in `index.ts` |
| `src/views/` | Hono JSX layouts and pages |
| `src/routes/`, `src/mcp/` | HTTP routes and the MCP server |
| `client/` | Browser islands, bundled by `scripts/build-client.mjs` |
| `cli/` | The `anymd` CLI (zero dependencies) |
| `migrations/` | D1 schema |

## Request flow

### Principal

`resolvePrincipal` (`src/auth/middleware.ts`) runs once per request: API key (`Authorization: Bearer` or `X-API-Key`) → session cookie → anonymous. A presented key that doesn't resolve is a hard `401`, never a silent downgrade to anonymous. Key scopes are intersected with the owner's **current** role on every request (`capScopes`), so demotion takes effect immediately without key rotation.

### Conversion

`runConversion` (`src/convert/service.ts`) is the only conversion path. In order:

1. `normalizeTargetUrl`: coerce to absolute http(s), reject private, internal, self-referential and credentialed targets.
2. Cache lookup keyed on URL + language + selector + image flag (not on the caller), unless `fresh`.
3. On a miss: quota check (signed-in) or anonymous daily counter, then `pickAdapter` → adapter. Adapters are tried in registry order; the web adapter is the fallback and itself hands binary responses to `document.ts`.
4. Credits come from the adapter's resulting `sourceKind`. The quota pre-check uses the cheapest cost because the kind is unknown until the adapter runs.
5. Save to the library when signed in, `save !== false` and the principal has `library:write`. Embedding, usage recording and Polar usage ingest run in `waitUntil` so they never add latency or fail the request.

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
| Identity | `users`, `sessions`, `api_keys` | Sessions and keys store SHA-256 hashes, never raw tokens. Key `scopes` is a JSON array. |
| Library | `documents`, `documents_fts` | Unique per `(user_id, url_hash)`. FTS5 is an external-content table kept in sync by triggers. `embedded_chunks` tracks vectors `<doc_id>#<n>` in Vectorize. |
| Metering | `usage_events`, `traces` | Monthly credit use is summed from `usage_events` since the UTC month start. |
| Billing | `subscriptions`, `credit_grants`, `webhook_events` | `webhook_events` makes Polar webhook handling idempotent. |
| Content | `posts`, `pages`, `page_revisions`, `idempotency_keys` | Page `draft`/`published` are JSON page documents. |
| Admin | `audit_log`, `settings`, `stats` | Page mutations and Polar events write to `audit_log`. |

Add schema changes as a new numbered file in `migrations/`; never edit an applied migration.

## Graceful degradation

Every secret in `src/env.ts` is optional. Missing Polar → no billing; missing transcript keys → YouTube without transcripts; missing OpenRouter/TypeSafe → fan-out via Workers AI and no Jev; missing Resend → no email. Keep new integrations behind the same pattern: detect the secret, do nothing harmful without it.
