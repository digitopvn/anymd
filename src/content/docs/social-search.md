---
title: "Social search"
description: "Search public posts on X, Facebook, Instagram, Threads, LinkedIn or all of them at once from the dashboard, REST API, CLI or MCP, then convert the ones you need."
updated: "2026-10-10"
---

Social search finds public posts by keyword on five platforms, or on all of them at once, and returns them in one normalized shape. Use it to discover what to read, then convert the posts you want into your library.

| Platform | `platform` | Order | Paging |
|---|---|---|---|
| X | `x` | Latest | Cursor |
| Facebook | `facebook` | Provider ranking | Cursor |
| Instagram | `instagram` | Provider ranking | Cursor |
| Threads | `threads` | Recent, falling back to Top when Recent is empty | One page |
| LinkedIn | `linkedin` | Latest | One page of up to 20 posts |
| All of the above | `all` | Newest first across platforms (posts without a date last) | Cursor, for the platforms that have more |

### Searching all platforms

`platform: "all"` asks every platform in parallel and merges the posts newest first; each result keeps its own `platform`. The `platforms` array reports how each one did. When one platform fails, the others still answer and the failed one carries an `error`; the call fails with `502` only when every platform fails. `next_cursor` continues only the platforms that have another page, so later pages ask fewer platforms.

## What it costs

| Search | Credits per page that returns results |
|---|---|
| X, Facebook, Instagram or Threads | 10 |
| LinkedIn | 100 (its provider costs about ten times more per search) |
| All | The sum for the platforms that returned results, at most 140 |

- **Empty pages and provider failures are free.** With `all`, a platform that returns nothing or fails costs nothing.
- **Requires an account.** Sign in, or send an API key with the `convert` scope. Anonymous callers get `401 authentication_required`.
- The full page price must be left this month before anything is fetched: 10 for X, Facebook, Instagram or Threads, 100 for LinkedIn, and 140 for a first `all` page (later `all` pages need only the price of the platforms still paging). Otherwise the call fails with `402 quota_exceeded`. Unused credits are released right after the search.

To keep a post, convert its `url` (a Facebook, Instagram, Threads or LinkedIn post is 10 credits, an X post is 1). See [Billing & credits](/docs/billing).

## Search history

Every successful search page, from any channel, is saved to your account with its results. The dashboard lists your most recent searches under **Recent searches**; open one to see its results again without spending credits. The newest 200 searches are kept, and older ones are dropped as new ones arrive. Saved results show the posts as they were found; search again for fresh posts. Deleting your account deletes the history.

## Dashboard

Open [Dashboard → Social search](/dashboard/social), type keywords, pick a platform (or **All**) and press **Search**. Each result links to the original post and has a **Convert** button that opens it in the converter. With **All**, each post is labelled with its platform and a status line shows how many posts each platform returned. **More results** loads the next page and shows its price. Past searches are listed below the form.

## REST API

`POST /api/v1/social/search` with a JSON body. Scope: `convert`.

| Field | Required | Notes |
|---|---|---|
| `platform` | yes | `all`, `x`, `facebook`, `instagram`, `threads` or `linkedin` |
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
  "platforms": [{ "platform": "x", "count": 20, "credits": 10, "error": null }],
  "trace_id": "trc_…",
  "duration_ms": 1830
}
```

`author`, `published_at` and each `stats` field are `null` when the platform does not expose them. `text` is capped at 5,000 characters and `media` at 4 URLs. `next_cursor` is `null` on the last page, and always for Threads and LinkedIn, whose providers answer one page per query. `platforms` has one entry per platform searched, with its result `count`, the `credits` it cost and an `error` (or `null`). The response also carries `X-Anymd-Credits` and `X-Anymd-Trace` headers.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Unknown platform, an empty or too long query, or a cursor that did not come from an `all` search |
| 401 | `authentication_required` | No account behind the request |
| 402 | `quota_exceeded` | Fewer credits left this month than the page price |
| 502 | `upstream_error` | The platform provider failed (with `all`, every provider failed); nothing was charged |
| 503 | `provider_unavailable` | Social search is not configured on this server |

## CLI

```bash
anymd social x "cloudflare workers"
anymd social x "cloudflare workers" --cursor 'DAACCgACG…'
anymd social linkedin ai agents
anymd social all "cloudflare workers"
anymd social instagram "#travel" --json
```

Results go to stdout; with `all`, each post is tagged with its platform. The credits used, any platform that failed and the command for the next page go to stderr, so you can pipe the posts on their own. Needs an API key (`anymd login`). See [CLI](/docs/cli).

## MCP

The `search_social` tool takes `{ platform, query, cursor? }` (`platform` can be `all`) and returns the same JSON as the REST API. It needs the `convert` scope. Ask your agent things like "search LinkedIn for posts about AI agents this week and read the two most discussed". See [MCP server](/docs/mcp).
