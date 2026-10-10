---
title: "Social search"
description: "Search public posts on X, Facebook, Instagram, Threads and LinkedIn from the dashboard, REST API, CLI or MCP, then convert the ones you need."
updated: "2026-10-10"
---

Social search finds public posts by keyword on five platforms and returns them in one normalized shape. Use it to discover what to read, then convert the posts you want into your library.

| Platform | `platform` | Order | Paging |
|---|---|---|---|
| X | `x` | Latest | Cursor |
| Facebook | `facebook` | Provider ranking | Cursor |
| Instagram | `instagram` | Provider ranking | Cursor |
| Threads | `threads` | Recent, falling back to Top when Recent is empty | One page |
| LinkedIn | `linkedin` | Latest | One page of up to 20 posts |

## What it costs

- **10 credits per page that returns results.** How many posts a page holds depends on the platform.
- **Empty pages and provider failures are free.**
- **Requires an account.** Sign in, or send an API key with the `convert` scope. Anonymous callers get `401 authentication_required`.
- A Free account needs at least 10 credits left this month, otherwise the call fails with `402 quota_exceeded` before anything is fetched.

Results are not cached or saved. To keep a post, convert its `url` (a Facebook, Instagram, Threads or LinkedIn post is 10 credits, an X post is 1). See [Billing & credits](/docs/billing).

## Dashboard

Open [Dashboard → Social search](/dashboard/social), type keywords, pick a platform and press **Search**. Each result links to the original post and has a **Convert** button that opens it in the converter. **More results** loads the next page.

## REST API

`POST /api/v1/social/search` with a JSON body. Scope: `convert`.

| Field | Required | Notes |
|---|---|---|
| `platform` | yes | `x`, `facebook`, `instagram`, `threads` or `linkedin` |
| `query` | yes | 1–200 characters: keywords, a `#hashtag` or a phrase (`q` is accepted as an alias) |
| `cursor` | no | `next_cursor` from the previous page |

```bash
curl https://anymd.cc/api/v1/social/search \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"platform":"x","query":"cloudflare workers"}'
```

```json
{
  "platform": "x",
  "query": "cloudflare workers",
  "count": 20,
  "results": [
    {
      "platform": "x",
      "id": "1844000000000000000",
      "url": "https://x.com/someone/status/1844000000000000000",
      "author": { "name": "Someone", "handle": "someone", "url": "https://x.com/someone" },
      "text": "Shipped our API on Cloudflare Workers today…",
      "published_at": "2026-10-10T08:18:31.000Z",
      "stats": { "likes": 12, "replies": 3, "reposts": 2, "views": 840 },
      "media": []
    }
  ],
  "next_cursor": "DAACCgACG…",
  "credits": 10,
  "trace_id": "trc_…",
  "duration_ms": 1830
}
```

`author`, `published_at` and each `stats` field are `null` when the platform does not expose them. `text` is capped at 5,000 characters and `media` at 4 URLs. `next_cursor` is `null` on the last page, and always for Threads and LinkedIn, whose providers answer one page per query. The response also carries `X-Anymd-Credits` and `X-Anymd-Trace` headers.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Unknown platform, or an empty or too long query |
| 401 | `authentication_required` | No account behind the request |
| 402 | `quota_exceeded` | Fewer than 10 credits left this month |
| 502 | `upstream_error` | The platform provider failed; nothing was charged |
| 503 | `provider_unavailable` | Social search is not configured on this server |

## CLI

```bash
anymd social x "cloudflare workers"
anymd social x "cloudflare workers" --cursor 'DAACCgACG…'
anymd social linkedin ai agents
anymd social instagram "#travel" --json
```

Results go to stdout. The credits used and the command for the next page go to stderr, so you can pipe the posts on their own. Needs an API key (`anymd login`). See [CLI](/docs/cli).

## MCP

The `search_social` tool takes `{ platform, query, cursor? }` and returns the same JSON as the REST API. It needs the `convert` scope. Ask your agent things like "search LinkedIn for posts about AI agents this week and read the two most discussed". See [MCP server](/docs/mcp).
