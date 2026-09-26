# anymd public contracts (source of truth for docs, CLI, MCP)

Base URL: `https://anymd.cc` (staging: `https://staging.anymd.cc`). All API errors are
`{ "error": { "code": string, "message": string, ... } }` with a matching HTTP status.

## Auth
- API key: `Authorization: Bearer amd_…` (or `X-API-Key: amd_…`). Keys are created in
  Dashboard → API keys, or `POST /api/v1/keys`. A key's scopes are capped by its owner's role.
- Session cookie `amd_session` (web). Cookie writes must be same-origin.
- MCP OAuth 2.1 (DCR + PKCE): metadata at `/.well-known/oauth-authorization-server`,
  authorize `/oauth/authorize`, token `/oauth/token`, registration `/oauth/register`.
- Scopes: `convert`, `library:read`, `library:write`, `usage:read`, `keys:manage`,
  `content:read`, `content:write`, `content:publish`, `pages:read`, `pages:write`,
  `pages:publish`, `settings:write`, `users:read`, `users:write`.
- Roles (templates): owner, admin, editor, author, viewer, user (see `src/auth/roles.ts`).
  Key presets: convert-only, library, read-only, content-editor, full.

## URL API (no key needed)
`GET https://anymd.cc/<any-url>` → `text/markdown` with YAML frontmatter.
- `?format=json` or `Accept: application/json` → JSON (same shape as POST /api/v1/convert).
- `?format=html` → rendered HTML preview.
- Options: `lang=vi`, `selector=.post`, `images=0`, `frontmatter=0`, `fresh=1`, `save=0`, `format`. Only these
  are stripped; every other query param stays part of the target URL.
- Response headers: `X-Anymd-Credits`, `X-Anymd-Cache: hit|miss`, `X-Anymd-Trace`, `X-Anymd-Kind`.
- Anonymous: 50 conversions/day per IP. With a key: counted against the plan's credits and
  saved to the library (unless `save=0`).
- `/convert?url=<url>` redirects to `/<url>`.
- Every site page has a Markdown twin: append `.md` (`/pricing.md`, `/docs/api.md`,
  `/blog/<slug>.md`, `/index.md`). `Accept: text/markdown` on any page also returns Markdown.

## REST API v1 (`/api/v1`)
| Method | Path | Scope | Notes |
|---|---|---|---|
| POST | /convert | convert | body `{url, language?, selector?, removeImages?, frontmatter?, save?, fresh?, format?: "json"\|"markdown"}` |
| POST | /convert/file | convert | multipart `file` (PDF, DOCX, XLSX, CSV, images…) max 20 MB |
| GET | /library | library:read | `?limit=20&before=<ts>&domain=&kind=` → `{items, next_cursor}` |
| GET | /library/:id | library:read | `?format=md` returns raw Markdown |
| PATCH | /library/:id | library:write | `{tags: string[]}` |
| DELETE | /library/:id | library:write | |
| GET/POST | /search | library:read | `q`, `mode=hybrid\|bm25\|fulltext\|semantic`, `limit` (≤50), `fanout=1`, `decide=1` (both Pro+; skipped on Free and listed in `gated`) |
| GET | /usage | usage:read | `?days=30` → `{plan, quota, totals, daily, events}` |
| GET | /traces | usage:read | `?limit=50` |
| GET | /traces/:id | usage:read | spans |
| GET | /keys | keys:manage | |
| POST | /keys | keys:manage | `{name, preset?, scopes?, expires_in_days?}` → `{key, ...}` (key shown once) |
| DELETE | /keys/:id | keys:manage | revoke |
| GET | /me | any signed-in | `{id,email,name,role,plan,scopes}` |
| POST | /billing/checkout | session | `{plan: "pro"\|"scale", interval: "month"\|"year"}` → `{url}` |
| POST | /billing/portal | session | → `{url}` |
| GET | /admin/blocks | pages:read | block catalog with JSON Schemas, sizes, slots, examples |
| GET | /admin/templates | pages:read | page templates |
| GET | /admin/pages | pages:read | |
| POST | /admin/pages | pages:write | `{slug, title, description?, template?, layout?}` |
| GET | /admin/pages/:id | pages:read | includes `revision`, `draft`, `previewUrl` |
| POST | /admin/pages/:id/ops | pages:write | `{baseRevision, ops[], idempotencyKey?, note?}` → 409 `revision_conflict` when stale |
| POST | /admin/pages/:id/publish | pages:publish | `{revision?}` |
| POST | /admin/pages/:id/unpublish | pages:publish | |
| DELETE | /admin/pages/:id | pages:write | archive |
| GET | /admin/pages/:id/revisions | pages:read | |
| POST | /admin/pages/:id/preview-token | pages:write | rotate the share-preview token |
| GET | /admin/pages/:id/markdown | pages:read | Markdown twin of the draft |
| GET/POST | /admin/posts | content:read / content:write | `{slug?, title, markdown, excerpt?, tags?, category?, cover_url?, seo_title?, seo_description?}` |
| GET/PATCH/DELETE | /admin/posts/:id | content:* | |
| POST | /admin/posts/:id/publish | content:publish | `{publish: boolean}` |
| GET | /admin/users | users:read | |
| PATCH | /admin/users/:id | users:write | `{role?, plan?}` |
| GET | /admin/roles | any signed-in | role templates + key presets |
| GET/PUT | /admin/settings | settings:write | key/value site settings |

Page ops (`ops[]` items, discriminated by `op`): `insert {block:{type, props?, size?}, index?, parentId?, slot?}`,
`update {id, props?, size?}` (merge), `replace_props {id, props}`, `move {id, index, parentId?, slot?}`,
`remove {id}`, `duplicate {id}`, `set_seo {seo}`, `set_layout {layout}`, `set_meta {title?, description?, slug?}`.
Sizes: `small|medium|large`. Blocks: hero, rich-text, feature-grid, steps, stats, logo-cloud,
code-tabs, pricing, faq, testimonial, cta, offer, image, comparison, converter, ecosystem,
founder, columns (slots `left`,`right`). Published pages live at `/p/<slug>` (+ `.md`), drafts
at `/p/<slug>?preview=<token>`. Templates: blank, ads-landing, seo-article, product-launch.

OpenAPI: `/api/v1/openapi.json`; interactive reference: `/docs/api/reference`.

## MCP (`https://anymd.cc/mcp`, Streamable HTTP, stateless JSON responses)
Auth: `Authorization: Bearer amd_…` or OAuth. Tools (shown only if the caller has the scope):
`convert_url {url, save?}`, `search_library {query, mode?, limit?}`, `get_document {id}`,
`list_documents {limit?, domain?}`, `delete_document {id}`, `usage_summary {}`,
`list_blocks {}`, `list_page_templates {}`, `list_pages {}`, `get_page {id}`,
`create_page {slug, title, description?, template?}`, `apply_page_ops {pageId, baseRevision, ops, idempotencyKey?}`,
`publish_page {pageId, revision?}`, `unpublish_page {pageId}`, `list_posts {}`,
`upsert_post {id?, slug?, title, markdown, excerpt?, tags?}`, `publish_post {id, publish}`.
Client config: `{"mcpServers":{"anymd":{"url":"https://anymd.cc/mcp","headers":{"Authorization":"Bearer amd_…"}}}}`
or `claude mcp add --transport http anymd https://anymd.cc/mcp --header "Authorization: Bearer amd_…"`.

## WebMCP
Pages call `navigator.modelContext.provideContext({ tools })` when available. Site tools:
`convert_url`, `get_page_markdown`, `search_library` (signed in), `list_documents` (signed in).
Page editor adds `get_page`, `list_blocks`, `apply_page_ops`, `publish_page`.

## CLI (`anymd`, Node ≥ 18, zero dependencies)
Install: `npm i -g https://cdn.anymd.cc/cli/anymd-cli-latest.tgz` (or run `npx https://cdn.anymd.cc/cli/anymd-cli-latest.tgz <url>`).
Config: `ANYMD_API_KEY`, `ANYMD_BASE_URL` env vars or `~/.config/anymd/config.json` (`anymd login`).
Commands: `anymd <url>` · `anymd convert <url> [--json] [-o file] [--no-save] [--fresh]` ·
`anymd file <path>` · `anymd search <query> [--mode hybrid] [--limit 10] [--json]` ·
`anymd ls [--limit 20] [--domain x]` · `anymd get <id>` · `anymd rm <id>` · `anymd usage` ·
`anymd login [--key amd_…]` · `anymd logout` · `anymd whoami` ·
`anymd pages ls|get <id>|create --slug --title [--template]|ops <id> --file ops.json|publish <id>|blocks` ·
`anymd mcp` (prints MCP config snippets).

## Credits & plans
web 1 · YouTube 3 · PDF/doc 3 · image 5 · search 0 · cached result 0.
Free $0: 500 credits/mo. Pro $9/mo ($7 yearly): 10k credits, $1 per extra 1k. Scale $49/mo
($39 yearly): 100k, $0.60 per extra 1k. Enterprise custom ($0.40 per 1k). Offers: LAUNCH30
(30% off until 2026-10-31), COMEBACK20 (returning visitors, 48h).
