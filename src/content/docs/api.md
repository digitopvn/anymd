---
title: "REST API"
description: "The anymd REST API v1: authentication, errors, conversion, library, search, usage, keys and admin endpoints with curl, JavaScript and Python examples."
updated: "2026-09-26"
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
| 403 | `forbidden` (missing scope), `bad_origin` |
| 404 | `not_found`, `upstream_status` |
| 409 | `revision_conflict`, `slug_taken` |
| 413 | `too_large` |
| 415 | `unsupported_type` |
| 422 | `empty_content`, `document_failed`, `invalid_props`, `idempotency_mismatch` |
| 429 | `anonymous_limit`, rate limits |
| 502 | `fetch_failed`, `upstream_status` |

Read `code`, not `message`. Messages are for humans and may change.

## Endpoints at a glance

| Method | Path | Scope |
|---|---|---|
| POST | `/convert` | `convert` |
| POST | `/convert/file` | `convert` |
| GET | `/library` | `library:read` |
| GET | `/library/:id` | `library:read` |
| PATCH | `/library/:id` | `library:write` |
| DELETE | `/library/:id` | `library:write` |
| GET, POST | `/search` | `library:read` |
| GET | `/usage` | `usage:read` |
| GET | `/traces`, `/traces/:id` | `usage:read` |
| GET, POST | `/keys` | `keys:manage` |
| DELETE | `/keys/:id` | `keys:manage` |
| GET | `/me` | any signed-in caller |
| POST | `/billing/checkout`, `/billing/portal` | browser session |
| * | `/admin/pages…`, `/admin/blocks`, `/admin/templates` | `pages:*` (admins: [builder guide](/admin/docs/page-builder)) |
| * | `/admin/posts…` | `content:*` |
| GET, PATCH | `/admin/users…` | `users:read` / `users:write` |
| GET | `/admin/roles` | any signed-in caller |
| GET, PUT | `/admin/settings` | `settings:write` |

## Convert

### POST /convert

Convert a URL. Scope: `convert`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | Any public http(s) URL |
| `language` | string | | Preferred language, e.g. `"vi"` |
| `selector` | string | | CSS selector for the main content |
| `removeImages` | boolean | `false` | Strip images |
| `frontmatter` | boolean | `true` | Include the YAML frontmatter block |
| `save` | boolean | `true` | Save to your library (needs `library:write`) |
| `fresh` | boolean | `false` | Skip the cache |
| `format` | `"json"` \| `"markdown"` | | `markdown` returns `text/markdown` instead of JSON |

The JSON response carries the Markdown, the extracted metadata, the library document id (when saved), credits charged, cache status and trace id. See the OpenAPI spec for the exact schema. The `X-Anymd-*` headers from the [URL API](/docs/url) are set here too.

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

`?limit=20&before=<ts>&domain=&kind=` returns `{ items, next_cursor }`, newest first. Pass `next_cursor` as `before` to get the next page. Filter by `domain` (e.g. `github.com`) or `kind` (e.g. `youtube`).

```bash
curl "https://anymd.cc/api/v1/library?limit=20&kind=youtube" \
  -H "Authorization: Bearer $ANYMD_API_KEY"
```

### GET /library/:id

Returns the document. Add `?format=md` for the raw Markdown:

```bash
curl "https://anymd.cc/api/v1/library/doc_…?format=md" \
  -H "Authorization: Bearer $ANYMD_API_KEY" -o saved.md
```

### PATCH /library/:id

Replace tags. Tags are lowercased and limited to letters, digits, `-` and `_`.

```bash
curl -X PATCH https://anymd.cc/api/v1/library/doc_… \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tags":["research","rag"]}'
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
| `GET /traces?limit=50` | Recent traces |
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

## Admin: pages, posts, users, settings

These endpoints power the AI-operable CMS. They need role-granted scopes (`pages:*`, `content:*`, `users:*`, `settings:write`).

- **Pages:** `/admin/blocks`, `/admin/templates`, `/admin/pages` and friends. Admins will find the full guide in the dashboard under [Pages → Builder guide](/admin/docs/page-builder).
- **Posts:** `GET/POST /admin/posts` with `{ slug?, title, markdown, excerpt?, tags?, category?, cover_url?, seo_title?, seo_description? }`; `GET/PATCH/DELETE /admin/posts/:id`; `POST /admin/posts/:id/publish` with `{ "publish": true | false }`.
- **Users:** `GET /admin/users` (`users:read`), `PATCH /admin/users/:id` with `{ role?, plan? }` (`users:write`).
- **Roles:** `GET /admin/roles` lists role templates and key presets.
- **Settings:** `GET/PUT /admin/settings` for key/value site settings (`settings:write`).
