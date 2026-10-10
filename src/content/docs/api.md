---
title: "REST API"
description: "The anymd REST API v1: authentication, errors, conversion, library, search, usage, keys and admin endpoints with curl, JavaScript and Python examples."
updated: "2026-10-09"
---

Base URL: `https://anymd.cc/api/v1`. Everything is JSON unless noted.

The machine-readable spec is at [`/api/v1/openapi.json`](/api/v1/openapi.json) and an interactive reference lives at [`/docs/api/reference`](/docs/api/reference). Use the spec for exact response schemas; this page is the guided tour.

## Authentication

Send an API key on every request:

```http
Authorization: Bearer amd_…
```

`X-API-Key: amd_…` works too. Create keys in **Dashboard → API keys** or with [`POST /keys`](#keys). A key can only do what its scopes allow, and its scopes are capped by its owner's role. See [API keys & roles](/docs/api-keys-roles).

A key that is unknown, revoked or expired is rejected with `401 invalid_api_key`. It is never silently downgraded to anonymous.

Browser sessions (the `amd_session` cookie) also work for the dashboard; cookie-authenticated writes must come from the same origin. Agents connecting over MCP can use [OAuth 2.1](/docs/mcp) instead of a key.

## Errors

Every error has the same shape and a matching HTTP status:

```json
{
  "error": {
    "code": "forbidden",
    "message": "Missing scope: library:write",
    "required": ["library:write"]
  }
}
```

| Status | Typical codes |
|---|---|
| 400 | `invalid_url`, `blocked_host`, `invalid_request` |
| 401 | `unauthorized`, `invalid_api_key` |
| 402 | `quota_exceeded` |
| 408 | `processing_limit` |
| 403 | `forbidden` (missing scope), `forbidden_rank`, `forbidden_self`, `bad_origin`, `oauth_key_creation_forbidden` |
| 404 | `not_found`, `upstream_status` |
| 409 | `revision_conflict`, `slug_taken`, `tag_conflict`, `role_conflict`, `status_conflict`, `settings_conflict`, `billing_owned`, `idempotency_in_progress` |
| 413 | `too_large` |
| 415 | `unsupported_type` |
| 422 | `empty_content`, `document_failed`, `invalid_props`, `idempotency_mismatch`, `invalid_request`, `too_many_tags`, `invalid_preferences`, `invalid_setting`, `plan_managed_by_billing` |
| 429 | `anonymous_limit`, rate limits |
| 503 | `provider_unavailable`, `oauth_store_unavailable` |
| 502 | `fetch_failed`, `upstream_status` |

Read `code`, not `message`. Messages are for humans and may change.

## Endpoints at a glance

| Method | Path | Scope |
|---|---|---|
| POST | `/convert` | `convert` |
| POST | `/convert/file` | `convert` |
| GET | `/library` | `library:read` |
| GET | `/library/tags` | `library:read` |
| GET | `/library/:id` | `library:read` |
| PATCH | `/library/:id` | `library:write` |
| POST | `/library/:id/tags` | `library:write` |
| DELETE | `/library/:id` | `library:write` |
| GET, POST | `/search` | `library:read` |
| GET | `/usage` | `usage:read` |
| GET | `/traces`, `/traces/:id` | `usage:read` |
| GET, POST | `/keys` | `keys:manage` |
| DELETE | `/keys/:id` | `keys:manage` |
| GET | `/me` | any signed-in caller |
| GET | `/account/reading-preferences` | `convert` (signed-in callers) |
| PUT, DELETE | `/account/reading-preferences` | `keys:manage` for API keys and OAuth clients; any signed-in session |
| POST | `/billing/checkout`, `/billing/portal` | browser session |
| * | `/admin/pages…`, `/admin/blocks`, `/admin/templates` | `pages:*` (admins: [builder guide](/admin/docs/page-builder)) |
| * | `/admin/posts…` | `content:*` |
| GET | `/admin/users`, `/admin/users/:id`, `/admin/users/:id/credentials` | `users:read` |
| PATCH | `/admin/users/:id` (role) | `users:roles:write` |
| POST | `/admin/users/:id/status`, `/admin/users/:id/sessions/revoke` | `users:sessions:write` |
| DELETE | `/admin/users/:id/keys/:keyId`, `/admin/users/:id/grants/:grantId` | `users:credentials:write` |
| GET | `/admin/roles` | any signed-in caller |
| GET / PATCH, PUT | `/admin/settings` | `settings:read` / `settings:write` |
| GET / POST, DELETE | `/admin/optouts…` | `optouts:read` / `optouts:write` |
| GET / POST | `/admin/credits…` | `credits:read` / `credits:write` |
| GET | `/admin/subscriptions…`, `/admin/billing/diagnostics` | `billing:read` |
| GET | `/admin/audit`, `/admin/audit/export` | `audit:read` |
| GET | `/admin/system/overview`, `/admin/system/usage`, `/admin/system/traces…` | `system:read` |

## Convert

### POST /convert

Convert a URL. Scope: `convert`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | Any public http(s) URL |
| `language` | string | | Preferred language, e.g. `"vi"` |
| `selector` | string | | CSS selector for the main content |
| `removeImages` | boolean | saved `keepImages`, else `false` | Strip image/media references (no credit effect) |
| `frontmatter` | boolean | `true` | Include the YAML frontmatter block |
| `save` | boolean | `true` | Save to your library (needs `library:write`) |
| `fresh` | boolean | `false` | Skip the cache |
| `expandThread` | boolean | saved, else `false` | Expand the rooted same-author X thread (extra credits, account) |
| `maxThreadPosts` | integer | saved, else `20` | Thread posts including the requested post, from 1 to 100 |
| `includeComments` | boolean | saved, else `false` | Retrieve comments and replies (extra credits, account) |
| `analyzeImages` | boolean | saved, else `false` | OCR and describe article images (extra credits, account) |
| `maxComments` | integer | saved, else `100` | Comment limit, from 1 to 1,000 |
| `maxImages` | integer | saved, else `10` | Article-image limit, from 1 to 20 |
| `maxCredits` | integer | saved, else `100` | Per-request budget, from 1 to 1,000 |
| `format` | `"json"` \| `"markdown"` | | `markdown` returns `text/markdown` instead of JSON |

The JSON response carries the Markdown, the extracted metadata, the library document id (when saved), `saved` and, when it was not saved, `not_saved_reason` (`not_requested`, `anonymous`, `missing_scope` when the credential lacks `library:write`, or `library_limit`), credits charged, cache status and trace id. See the OpenAPI spec for the exact schema. The `X-Anymd-*` headers from the [URL API](/docs/url) are set here too.

For social URLs, `kind` is `facebook`, `instagram`, `threads` or `linkedin`; these adapters require an authenticated caller. X is readable anonymously; thread expansion, comments and article-image analysis are opt-in (see [deep reading](#deep-reading-options-and-saved-defaults)). The response's `reading_options` shows the effective value of every option and whether it came from the `request`, your saved `preference` or the safe `default`. The response includes `credit_breakdown` with `base`, `thread`, `comments` and `images`, plus an `enrichment` object whose sections expose `complete`, `count`, `fetchedAt` and, when incomplete, `reason`. Provider failures, the 40-call/55-second processing bounds and item or credit limits produce partial coverage rather than a false complete result.

The base social post costs 10 credits. Each additional X thread post costs 1, each started 20-comment batch costs 10, and each successfully analyzed article image costs 5. Cached reads cost 0. A later signed-in save of the same URL preserves previously saved complete or richer enrichment when the new read is plain or partial.

**curl**

```bash
curl https://anymd.cc/api/v1/convert \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://stephango.com/saw"}'
```

**JavaScript (fetch)**

```js
const res = await fetch('https://anymd.cc/api/v1/convert', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.ANYMD_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ url: 'https://stephango.com/saw', format: 'markdown' }),
});
if (!res.ok) {
  const { error } = await res.json();
  throw new Error(`${error.code}: ${error.message}`);
}
const markdown = await res.text();
```

**Python (requests)**

```python
import os, requests

res = requests.post(
    "https://anymd.cc/api/v1/convert",
    headers={"Authorization": f"Bearer {os.environ['ANYMD_API_KEY']}"},
    json={"url": "https://stephango.com/saw", "save": False},
    timeout=60,
)
res.raise_for_status()
data = res.json()
print(res.headers.get("X-Anymd-Credits"), res.headers.get("X-Anymd-Cache"))
```

### Deep reading options and saved defaults

Every option above resolves with one rule, in every channel (web converter, URL API, REST, CLI, MCP, WebMCP):

```
explicit request option > your saved reading preference > safe default
```

The safe default for every credit-consuming enrichment (`expandThread`, `includeComments`, `analyzeImages`) is **off**: a signed-in request that sets nothing gets the base conversion only. Signing in never turns enrichment on by itself. When an explicit option conflicts with a saved one (for example `analyzeImages: true` while your saved defaults remove images), the explicit option wins; two explicit conflicting options return `400 invalid_options`. Saved defaults never raise your plan's credits, and a request's own `maxCredits` always wins over the saved cap.

> **Behavior change (October 2026):** signed-in X conversions used to expand same-author threads automatically. They no longer do. Send `expandThread: true` or save it as a default to keep the old behavior.

#### GET /account/reading-preferences

Returns `{ preferences, saved, updated_at, defaults, limits }`. `saved: false` means nothing is stored and the safe defaults apply. Scope: `convert`; signed-in callers only.

#### PUT /account/reading-preferences

Who may change them: any signed-in session (you, in the dashboard or browser, whatever your role), or an API key or OAuth client holding `keys:manage`. Saved defaults decide what every other key, OAuth client and the web converter may spend when they leave an option out, so a **Convert only** or **Convert + library** key, or an OAuth client with the default scopes, can read them but not change them (`403 forbidden`): use a key with **Everything my role allows**, or the dashboard. Every change is written to the audit log with the auth kind, key id and the changed fields.

A partial update: send only the fields to change; the rest keep their saved value. Unknown fields and out-of-range values are rejected (never silently clamped) with `422 invalid_preferences` and a `details` list naming each field and its allowed range. `analyzeImages` requires `keepImages`.

| Field | Type | Default | Range / notes |
|---|---|---|---|
| `expandThread` | boolean | `false` | Extra credits |
| `maxThreadPosts` | integer | `20` | 1–100 |
| `includeComments` | boolean | `false` | Extra credits |
| `maxComments` | integer | `100` | 1–1,000 |
| `keepImages` | boolean | `true` | No extra credits; same as `images=1` / `removeImages: false` |
| `analyzeImages` | boolean | `false` | Extra credits; needs `keepImages` |
| `maxImages` | integer | `10` | 1–20 |
| `maxCredits` | integer | `100` | 1–1,000; cap per conversion including the base price |

```bash
curl -X PUT https://anymd.cc/api/v1/account/reading-preferences \
  -H "Authorization: Bearer amd_…" -H "Content-Type: application/json" \
  -d '{"expandThread": true, "maxThreadPosts": 30}'
```

#### DELETE /account/reading-preferences

Removes the saved defaults; the safe defaults apply again. Same rule as PUT (any signed-in session, or `keys:manage` for keys and OAuth clients); audited. The same settings live in the dashboard under [Account → Deep reading defaults](/dashboard/account#reading-defaults).

### POST /convert/file

Upload a file as multipart form data in the `file` field. PDF, DOCX, XLSX, XLS, ODS, ODT, CSV and images (JPEG, PNG, WebP, SVG). Max 20 MB. Scope: `convert`.

```bash
curl https://anymd.cc/api/v1/convert/file \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -F "file=@report.pdf"
```

```python
with open("report.pdf", "rb") as f:
    res = requests.post(
        "https://anymd.cc/api/v1/convert/file",
        headers={"Authorization": f"Bearer {os.environ['ANYMD_API_KEY']}"},
        files={"file": f},
        timeout=120,
    )
```

Files cost 3 credits (images 5). See [Billing & credits](/docs/billing).

## Library

Every signed-in conversion is saved to your private library, one document per source URL. Converting the same URL again refreshes it.

### GET /library

`?limit=20&before=<ts>&domain=&kind=&tag=` returns `{ items, next_cursor }`, newest first. Pass `next_cursor` as `before` to get the next page. Filter by `domain` (e.g. `github.com`), `kind` (e.g. `youtube`) or `tag`.

```bash
curl "https://anymd.cc/api/v1/library?limit=20&kind=youtube" \
  -H "Authorization: Bearer $ANYMD_API_KEY"
```

`tag` matches whole tags: `tag=ai` finds documents tagged `ai`, never `rai` or `ai-safety`. Repeat it (`tag=ai&tag=rag`) or comma-separate it (`tag=ai,rag`) to require every tag, up to 10. Tag values are normalized like stored tags.

```bash
curl "https://anymd.cc/api/v1/library?tag=rag&tag=research" \
  -H "Authorization: Bearer $ANYMD_API_KEY"
```

### GET /library/tags

Your tags with how many documents carry each, most used first: `{ "items": [{ "tag": "rag", "count": 12 }, …] }`. `?limit=` defaults to 100 (maximum 500).

```bash
curl "https://anymd.cc/api/v1/library/tags?limit=50" \
  -H "Authorization: Bearer $ANYMD_API_KEY"
```

### GET /library/:id

Returns the document. Add `?format=md` for the raw Markdown:

```bash
curl "https://anymd.cc/api/v1/library/doc_…?format=md" \
  -H "Authorization: Bearer $ANYMD_API_KEY" -o saved.md
```

### PATCH /library/:id

Replace all tags. Tags are lowercased and limited to letters, digits, `-` and `_`; a document keeps at most 20.

```bash
curl -X PATCH https://anymd.cc/api/v1/library/doc_… \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tags":["research","rag"]}'
```

### POST /library/:id/tags

Edit tags without replacing the rest: `{ "add"?: [...], "remove"?: [...] }`, or `{ "set": [...] }` to replace them all (`set` can't be combined with `add`/`remove`; `[]` clears). Tags are normalized like `PATCH`. Returns `{ id, tags }` with the resulting tags.

An edit that would leave more than 20 tags fails with `422 too_many_tags` and changes nothing; nothing is silently dropped.

```bash
curl -X POST https://anymd.cc/api/v1/library/doc_…/tags \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"add":["rag"],"remove":["todo"]}'
```

### DELETE /library/:id

Deletes the document and its search embeddings.

## Search

`GET /search?q=…` or `POST /search` with the same fields as JSON. Scope: `library:read`. Costs 0 credits.

| Param | Default | Notes |
|---|---|---|
| `q` | required | Query text |
| `mode` | `hybrid` | `hybrid`, `bm25`, `fulltext` or `semantic` |
| `limit` | `10` | Up to 50 |
| `fanout` | off | `1` rewrites the query into variants and fuses all results. Pro and above |
| `decide` | off | `1` lets Jev break a near-tie among the top results. Pro and above |

On Free, `fanout` and `decide` are ignored and listed in the response's `gated` array, for example `"gated": ["fanout"]`. The search itself still runs.

```bash
curl -G https://anymd.cc/api/v1/search \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  --data-urlencode "q=how does reciprocal rank fusion work" \
  -d mode=hybrid -d fanout=1 -d limit=10
```

```js
const res = await fetch('https://anymd.cc/api/v1/search', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ q: '"exact phrase" AND cloudflare', mode: 'fulltext', limit: 20 }),
});
const { hits } = await res.json();
```

How the modes, fan-out and Jev work, plus the response shape: [Library & search](/docs/library-search).

## Usage and traces

| Endpoint | Returns |
|---|---|
| `GET /usage?days=30` | `{ plan, quota, totals, daily, events }` |
| `GET /traces?limit=50&cursor=…` | `{ items, next_cursor }`: recent traces, newest first |
| `GET /traces/:id` | One trace with its spans (fetch, extraction, cache, save…) |

Every conversion response carries its trace id in `X-Anymd-Trace`. When something is slow, the spans show which step was slow.

## Keys

Scope: `keys:manage`.

```bash
# Create (the full key is returned once, in `key`)
curl https://anymd.cc/api/v1/keys \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"ci-pipeline","preset":"convert-only","expires_in_days":90}'

# List
curl https://anymd.cc/api/v1/keys -H "Authorization: Bearer $ANYMD_API_KEY"

# Revoke
curl -X DELETE https://anymd.cc/api/v1/keys/key_… -H "Authorization: Bearer $ANYMD_API_KEY"
```

Body: `{ name, preset?, scopes?, expires_in_days? }`. Presets and scopes: [API keys & roles](/docs/api-keys-roles).

## Me

`GET /me` returns `{ id, email, name, role, plan, scopes }` for the caller. Handy for checking what a key can do.

## Billing

`POST /billing/checkout` with `{ "plan": "pro" | "scale", "interval": "month" | "year" }` returns `{ url }` for a Polar checkout. `POST /billing/portal` returns `{ url }` for the customer portal. Both need a browser session, not an API key. See [Billing & credits](/docs/billing).

## Admin: pages and posts

These endpoints power the AI-operable CMS. They need role-granted scopes (`pages:*`, `content:*`).

- **Pages:** `/admin/blocks`, `/admin/templates`, `/admin/pages` and friends. Admins will find the full guide in the dashboard under [Pages → Builder guide](/admin/docs/page-builder).
- **Posts:** `GET/POST /admin/posts` with `{ slug?, title, markdown, excerpt?, tags?, category?, cover_url?, seo_title?, seo_description? }`; `GET/PATCH/DELETE /admin/posts/:id`; `POST /admin/posts/:id/publish` with `{ "publish": true | false }`.

## Admin: system administration

The control plane for owners and admins: users, credentials, settings, opt-outs, credits, billing (read-only), audit and system health. The same services back the [MCP admin tools](/docs/mcp#system-administration), so scopes, rank rules, idempotency and audit are identical. Which role holds which scope: [API keys & roles](/docs/api-keys-roles#roles).

Conventions:

- **Pagination.** Lists return `{ items, next_cursor }`; pass `next_cursor` back as `?cursor=`. `limit` is bounded.
- **Timestamps** in filters accept epoch milliseconds or ISO 8601.
- **Idempotency.** Mutations accept an `Idempotency-Key` header (or `idempotencyKey` in the body). A retry returns the first result with `replayed: true`; reusing a key for a different change is `422 idempotency_mismatch`; a retry that arrives while the first attempt is still running is `409 idempotency_in_progress` (retry after a second).
- **Concurrency.** Send `expectedRole` or `expectedVersion` to get `409` instead of overwriting a change made meanwhile.
- **Audit.** Every change records the acting user, credential, route (`via: api:<METHOD route>`), request id and a minimal diff.

### Users and credentials

| Endpoint | Body or query | Scope |
|---|---|---|
| `GET /admin/users` | `?search=&role=&plan=&status=&createdAfter=&lastLoginAfter=&cursor=&limit=` | `users:read` |
| `GET /admin/users/:id` | | `users:read` |
| `PATCH /admin/users/:id` | `{ role, expectedRole? }` | `users:roles:write` |
| `POST /admin/users/:id/status` | `{ status: "suspended" \| "active", reason, expectedStatus? }` | `users:sessions:write` |
| `GET /admin/users/:id/credentials` | | `users:read` |
| `POST /admin/users/:id/sessions/revoke` | `{ sessionHandle? }` | `users:sessions:write` |
| `DELETE /admin/users/:id/keys/:keyId` | | `users:credentials:write` |
| `DELETE /admin/users/:id/grants/:grantId` | | `users:credentials:write` |

Plans follow the billing provider: `PATCH /admin/users/:id` with a `plan` field returns `422 plan_managed_by_billing`. Grant credits instead. Nobody can change their own account here, and admins only act on lower-ranked accounts (`403 forbidden_rank`).

```bash
curl -X PATCH https://anymd.cc/api/v1/admin/users/usr_… \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"role":"editor","expectedRole":"user"}'
```

### Settings and opt-outs

| Endpoint | Body or query | Scope |
|---|---|---|
| `GET /admin/settings` | Returns `{ settings, version, updated_at, updated_by }` | `settings:read` |
| `PATCH /admin/settings` | `{ patch: { key: value \| null }, expectedVersion? }` | `settings:write` |
| `PUT /admin/settings` | The patch itself (original form, no version check) | `settings:write` |
| `GET /admin/optouts` | `?search=&cursor=&limit=` | `optouts:read` |
| `POST /admin/optouts` | `{ domain, reason? }` | `optouts:write` |
| `DELETE /admin/optouts/:domain` | | `optouts:write` |

### Credits and billing

| Endpoint | Body or query | Scope |
|---|---|---|
| `GET /admin/credits` | `?userId=&state=active\|expired\|revoked&source=&cursor=&limit=` | `credits:read` |
| `POST /admin/credits` | `{ userId, credits, reason, source?, expiresAt?, recurring? }` plus `Idempotency-Key` (required) | `credits:write` |
| `POST /admin/credits/:id/revoke` | `{ reason }` | `credits:write` |
| `GET /admin/subscriptions` | `?status=&plan=&userId=&cursor=&limit=` | `billing:read` |
| `GET /admin/subscriptions/:id` | Includes `consistency` between the user plan and the subscription | `billing:read` |
| `GET /admin/billing/diagnostics` | Provider config (secrets as present/missing only), webhook outcomes and failures, plan drift | `billing:read` |

`POST /admin/credits` answers `201` for a new grant and `200` with `replayed: true` for a retry. Grants from billing orders cannot be revoked here (`409 billing_owned`). How grants count: an active grant raises their allowance. By default a grant expires at the end of the current month (UTC), or at the end of next month when fewer than 7 days of this month remain; a grant without `recurring` is a one-time pool: its credits are spent once over its whole lifetime, so whatever one month uses is gone the next (5,000 granted on the 26th with 3,000 used that month leaves at most 2,000 for next month). Pass `recurring: true` (with or without `expiresAt`) for credits that renew in full every month; an `expiresAt` later than the default without `recurring: true` is `422`. On Pro and Scale, credits are used in this order: the plan's included credits, then grants, then paid overage. A grant covers usage from the moment it is granted onward and is not a refund: overage reported before it stays billed. Example: on a plan with 10,000 included credits, a 5,000-credit grant made when the account had used 12,000 this period keeps the next 5,000 credits (12,000 to 17,000) off the overage bill; the 2,000 used before the grant stay billed. Positions are counted within the current period of a monthly subscription, or the calendar month (UTC) otherwise.

```bash
curl https://anymd.cc/api/v1/admin/credits \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: outage-2026-10-usr_…" \
  -d '{"userId":"usr_…","credits":500,"reason":"October incident"}'
```

### Audit and system

| Endpoint | Query | Scope |
|---|---|---|
| `GET /admin/audit` | `?action=user.*&actorUserId=&target=&targetType=&since=&until=&cursor=&limit=` | `audit:read` |
| `GET /admin/audit/export` | Same filters; NDJSON, up to 5,000 rows (`X-Anymd-Count`, `X-Anymd-Truncated`) | `audit:read` |
| `GET /admin/system/overview` | | `system:read` |
| `GET /admin/system/usage` | `?days=7&channel=&kind=` (`days` 1–30) | `system:read` |
| `GET /admin/system/traces` | `?sort=recent\|slowest&status=&kind=&userId=&since=&cursor=&limit=` (`since` at most 30 days ago; `slowest` ranks the newest 5,000 traces in the window) | `system:read` |
| `GET /admin/system/traces/:id` | | `system:read` |

`GET /admin/roles` lists role templates, scopes, key presets and plans for any signed-in caller.
