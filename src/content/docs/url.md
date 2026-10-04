---
title: "URL API"
description: "Prefix any link with anymd.cc/ to get clean Markdown back. Formats, options, headers, limits and Markdown twins."
updated: "2026-10-04"
---

The simplest API there is: put `https://anymd.cc/` in front of a URL.

```text
https://stephango.com/saw
        becomes
https://anymd.cc/stephango.com/saw
```

No key, no SDK, no signup. It works in a browser, in `curl`, in a shell script, and in any agent that can fetch a URL.

## Request

```http
GET https://anymd.cc/<any-url>
```

The scheme is optional. All of these convert the same page:

```text
https://anymd.cc/stephango.com/saw
https://anymd.cc/https://stephango.com/saw
https://anymd.cc/convert?url=https://stephango.com/saw   (redirects to the first form)
```

Only public `http(s)` URLs are accepted. Private addresses, `localhost`, internal hostnames and URLs with embedded credentials are refused with `400 blocked_host` or `400 invalid_url`.

## Response formats

| You send | You get |
|---|---|
| nothing extra | `text/markdown` with YAML frontmatter (default) |
| `?format=json` or `Accept: application/json` | JSON, same shape as [`POST /api/v1/convert`](/docs/api) |
| `?format=html` | Rendered HTML preview |

```bash
curl https://anymd.cc/stephango.com/saw
curl -H "Accept: application/json" https://anymd.cc/stephango.com/saw
curl "https://anymd.cc/stephango.com/saw?format=html"
```

### What the Markdown looks like

Frontmatter first, then the content. Fields appear only when the source knows them; values below are illustrative.

```markdown
---
title: "Example article"
author: "Jane Doe"
published: "2026-09-01"
source: "https://example.com/article"
domain: "example.com"
site: "Example"
language: "en"
description: "One-line summary from the page."
image: "https://example.com/cover.png"
kind: web
word_count: 1234
---

# Example article

The clean content starts here…
```

`kind` tells you which converter handled the URL (`web`, `x`, `facebook`, `instagram`, `threads`, `linkedin`, `youtube`, `github`, `reddit`, `hackernews`, `pdf`, `document`, `image`, `text`). X posts also carry `likes`, `retweets`, `replies` and `views`. See [Supported sources](/docs/sources).

## Options

Add these as query parameters.

| Option | Example | Effect |
|---|---|---|
| `format` | `format=json` | `json` or `html` instead of Markdown |
| `lang` | `lang=vi` | Preferred language, sent upstream as `Accept-Language` (also picks YouTube transcript language when available) |
| `selector` | `selector=.post` | CSS selector for the main content, when automatic detection picks the wrong block |
| `images` | `images=0` | Strip images from the output |
| `frontmatter` | `frontmatter=0` | Return the body only, no YAML block |
| `fresh` | `fresh=1` | Skip the shared cache and fetch the page again |
| `save` | `save=0` | Don't save to your library (signed-in callers only) |
| `includeComments` | `includeComments=1` | Retrieve comments and replies (signed-in callers; extra credits) |
| `analyzeImages` | `analyzeImages=1` | OCR and describe article images (signed-in callers; extra credits) |
| `maxComments` | `maxComments=100` | Comment limit; default 100, maximum 1,000 |
| `maxImages` | `maxImages=10` | Article-image limit; default 10, maximum 20 |
| `maxCredits` | `maxCredits=100` | Per-request enrichment budget; default 100, maximum 1,000 |

```bash
curl "https://anymd.cc/example.com/blog/post?selector=article&images=0&frontmatter=0"
```

### Social enrichment

Anonymous URL reads keep the existing basic X behavior. A signed-in read of an X status can expand its rooted same-author thread automatically. Facebook, Instagram, Threads and LinkedIn post adapters require an account. `includeComments=1` and `analyzeImages=1` are signed-in opt-ins; comments use batches of 20 and image analysis describes eligible images embedded in the converted Markdown.

The JSON form reports `credit_breakdown` (`base`, `thread`, `comments`, `images`) and `enrichment` coverage for each section. A section can be partial when a provider, the request budget, the item limit or the processing deadline stops traversal; inspect its `complete`, `count` and `reason` fields. Public source rules still apply: anymd reads requested public URLs and does not bypass logins, paywalls or CAPTCHAs.

Cached results cost 0 credits. A signed-in save for the same URL keeps previously saved complete or richer enrichment when a later plain or partial read is saved.

> **Target URLs with their own query string** (for example `news.ycombinator.com/item?id=…`): anymd removes only its own options (`format`, `lang`, `selector`, `images`, `frontmatter`, `fresh`, `save`, `includeComments`, `analyzeImages`, `maxComments`, `maxImages`, `maxCredits`) and passes every other parameter through to the target. So `anymd.cc/example.com/search?q=cats&format=json` converts `example.com/search?q=cats` and returns JSON. If the target itself uses one of those names, use [`POST /api/v1/convert`](/docs/api) with the URL in the JSON body.

## Response headers

| Header | Meaning |
|---|---|
| `X-Anymd-Credits` | Credits this request cost (`0` for cached results) |
| `X-Anymd-Cache` | `hit` or `miss` |
| `X-Anymd-Trace` | Trace id. Signed-in users can open it from the dashboard or `GET /api/v1/traces/:id` |
| `X-Anymd-Kind` | Source kind that handled the URL |

## Anonymous vs. signed-in

| | Anonymous | With an API key or session |
|---|---|---|
| Limit | 50 conversions/day per IP | Your plan's monthly credits |
| Saved to library | No | Yes, unless `save=0` (the key needs `library:write`) |
| Usage logs & traces | No | Yes |

Send a key the same way as the REST API:

```bash
curl -H "Authorization: Bearer $ANYMD_API_KEY" https://anymd.cc/stephango.com/saw
```

Converted results are cached for up to an hour per URL and options. A cached result costs 0 credits; `fresh=1` forces a new fetch (and a new charge).

## Errors

Errors come back as JSON with a matching HTTP status:

```json
{ "error": { "code": "anonymous_limit", "message": "Anonymous limit reached (50/day)…" } }
```

| Status | Code | When |
|---|---|---|
| 400 | `invalid_url`, `blocked_host` | Unparseable, non-http(s), private or credentialed URL |
| 402 | `quota_exceeded` | Free plan credits used up for the month |
| 408 | `processing_limit` | The bounded enrichment deadline or provider-call limit was reached |
| 404 / 502 | `upstream_status`, `fetch_failed` | The source site returned an error or couldn't be reached |
| 413 | `too_large` | HTML over 5 MB or a file over 20 MB |
| 415 | `unsupported_type` | Content type anymd can't convert |
| 422 | `empty_content` | No readable content found |
| 503 | `provider_unavailable` | A required social or enrichment provider is not configured or subscribed |
| 429 | `anonymous_limit` | Anonymous daily limit reached |

Failed conversions never cost credits.

## Markdown twins of this site

Every page on anymd.cc has a Markdown version for agents:

- Append `.md`: `/index.md`, `/pricing.md`, `/docs/api.md`, `/blog/<slug>.md`, `/p/<slug>.md`.
- Or send `Accept: text/markdown` to any page.

```bash
curl https://anymd.cc/docs/api.md
curl -H "Accept: text/markdown" https://anymd.cc/pricing
```

The site also publishes `/llms.txt` for LLM crawlers.
