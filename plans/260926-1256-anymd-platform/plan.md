# anymd.cc platform — plan

Status: in progress · Owner: Digitop.ai · Created: 2026-09-26

## Outcome
`anymd.cc` converts anything on the internet to clean Markdown (inheriting every approach of
`nextlevelbuilder/defuddle`), stores each user's conversions in a searchable personal library,
and is operable by humans (web), developers (API/CLI) and agents (MCP, WebMCP, `.md` URLs).
Deployed on Cloudflare: `dev` → `staging.anymd.cc`, `main` → `anymd.cc` + `www.anymd.cc`.

## Architecture (one Worker)
- Hono on Cloudflare Workers, SSR with Hono JSX, client islands bundled by esbuild, Tailwind v4.
- D1: users, sessions, api_keys, documents (+FTS5 BM25), usage_events, traces, subscriptions,
  posts, pages (+revisions, idempotency), settings. KV: OAuth store, response cache.
- Vectorize (bge-m3, 1024d, metadata `user_id`,`doc_id`) for semantic search; Workers AI for
  embeddings, query fan-out, and `toMarkdown` (PDF/images/office files).
- Search = FTS5 BM25 + FTS5 full-text syntax + semantic + query fan-out, fused by RRF, then Jev
  (TypeSafe System One) decides between close top results (opt-in by `TYPESAFE_API_KEY`).
- `@cloudflare/workers-oauth-provider` for MCP OAuth 2.1; API keys (`amd_…`) with role scopes.
- Polar.sh checkout, customer portal, webhooks, usage-event ingestion (gated by env secrets).
- R2 bucket (from `.env`) served at `cdn.anymd.cc` for media, OG images, CLI tarball.

## Phases
| # | Phase | Status |
|---|---|---|
| 1 | Scaffold, infra (D1/KV/Vectorize/R2 created), wrangler envs, CI | in progress |
| 2 | Conversion engine (defuddle parity + fixes + adapters) & public `/{url}` API | todo |
| 3 | Auth, API keys, roles, dashboard (usage logs, traces, keys, library) | todo |
| 4 | Library search (BM25/FTS/semantic/fan-out/Jev) | todo |
| 5 | MCP (HTTP, OAuth + API keys), WebMCP, CLI, OpenAPI | todo |
| 6 | Billing (Polar), pricing, quotas | todo |
| 7 | Marketing: home, pricing, ecosystem, founder, blog, changelog, docs, legal, cookies | todo |
| 8 | Page builder + admin API/MCP/WebMCP + operator skill | todo |
| 9 | SEO/GEO: `.md` URLs, llms(-full).txt, sitemap, robots, schema, OG | todo |
| 10 | Deploy staging → verify → production → browser verify loop | todo |

## Acceptance criteria
- Production `anymd.cc` serves every listed page without console errors or layout breakage at
  375 / 768 / 1440 px; `www` redirects to apex; staging deploys from `dev`.
- `GET anymd.cc/<url>` returns Markdown with frontmatter; JSON/HTML via Accept / `?format=`.
- Signed-in conversions land in the library; search modes return ranked results.
- MCP `/mcp` works with API key and OAuth (DCR + PKCE); WebMCP tools register in-page.
- Every public page has a `.md` twin, sitemap entry, schema.org JSON-LD and social card.
- Billing endpoints work once Polar secrets exist; absence degrades to a clear notice.

## Non-goals (this iteration)
Native mobile apps; npm publication of the CLI (needs npm auth); video/audio transcription beyond
YouTube captions (documented as roadmap).
