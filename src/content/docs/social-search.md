---
title: "Social search"
description: "Search public posts on X, Facebook, Instagram, Threads, LinkedIn or all of them at once from the dashboard, REST API, CLI or MCP, filter them by date, then convert the ones you need."
updated: "2026-10-25"
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

`platform: "all"` asks every platform in parallel and merges the posts newest first; each result keeps its own `platform`. The `platforms` array reports how each one did. When one platform fails, the others still answer and the failed one carries an `error`; the call fails with `502` only when every platform fails. `next_cursor` continues only the platforms that have another page, so later pages ask fewer platforms. A platform that fails on a later page keeps its place and is asked again on the next one, while another platform is still paging.

## Time filters

Limit a search to a time range with **either** `period` **or** `since`/`until`:

- `period`: `24h`, `7d` or `30d`, counted back from when the search starts. The window stays fixed while you page.
- `since` / `until`: an ISO-8601 time with a zone (`2026-10-01T00:00:00Z`, `2026-10-01T09:00:00+07:00`) or a date (`2026-10-01`, read as UTC midnight). Either end may be left open.

The range is half-open in UTC: a post counts when `since <= published_at < until`. `since` must be before `until`, not in the future and not before 2004, and a range with both ends spans at most 366 days. Anything else, or `period` together with `since`/`until`, is `400 invalid_request`. While a range is active, posts without a publish time are left out.

X applies the range at the provider, so paging walks through the range itself. Facebook, Instagram, Threads and LinkedIn have no verified date filter, so their posts are filtered after they are fetched: `coverage` is then `provider_limited`, posts from the range can be missing, and a page can come back short or empty while `next_cursor` still continues. Keep paging to look further.

## Duplicates

Results are de-duplicated by exact post identity: the X post id, the Instagram or Threads shortcode, the LinkedIn activity id, the Facebook post id, otherwise the post URL without tracking parameters (`twitter.com` and `x.com`, `threads.com` and `threads.net` count as the same site). This applies within a page and across every page of the same search, so a later page never repeats a post. When copies differ, the most complete one is kept; engagement stats are not added up. The same post shared on two platforms stays two results.

Each response says what was removed: `raw_count` (posts the platforms returned) equals `count` + `duplicate_count` + `out_of_range_count` + `missing_timestamp_count`, overall and per platform.

## What it costs

| Search | Credits per page that returns results |
|---|---|
| X, Facebook, Instagram or Threads | 10 |
| LinkedIn | 100 (its provider costs about ten times more per search) |
| All | The sum for the platforms that returned results, at most 140 |

- **Empty pages and provider failures are free.** With `all`, a platform that returns nothing or fails costs nothing.
- **Filtering does not change the price.** A platform that returned posts is charged its page price even when every post was a duplicate or outside the time range.
- **Requires an account.** Sign in, or send an API key with the `convert` scope. Anonymous callers get `401 authentication_required`.
- The full page price must be left this month before anything is fetched: 10 for X, Facebook, Instagram or Threads, 100 for LinkedIn, and 140 for a first `all` page (later `all` pages need only the price of the platforms still paging). Otherwise the call fails with `402 quota_exceeded`. Unused credits are released right after the search. `next_page_credits` in each response is the most the next page can cost.

To keep a post, convert its `url` (a Facebook, Instagram, Threads or LinkedIn post is 10 credits, an X post is 1). See [Billing & credits](/docs/billing).

## Search history

Every successful search page, from any channel, is saved to your account with its results. The dashboard lists your most recent searches under **Recent searches**; open one to see its results again without spending credits. The newest 200 searches are kept, and older ones are dropped as new ones arrive. Saved results show the posts as they were found; search again for fresh posts or more pages (paging cursors are single-use and last 24 hours, so a saved search does not page on). Deleting your account deletes the history.

## Dashboard

Open [Dashboard → Social search](/dashboard/social), type keywords, pick a platform (or **All**), optionally pick a **Time range** (Any time, Last 24 hours, Last 7 days, Last 30 days or Custom range) and press **Search**. Custom range dates are whole days in your browser's time zone, and the end date is included. Each result links to the original post and has a **Convert** button that opens it in the converter. With **All**, each post is labelled with its platform and a status line shows how many posts each platform returned. Below the status line, a summary shows the range searched, how many posts were removed as duplicates, outside the range or without a date, and a partial-coverage note when a platform was filtered after fetching. **More results** loads the next page with the same range and shows its price. Past searches are listed below the form.

## REST API

`POST /api/v1/social/search` with a JSON body. Scope: `convert`.

| Field | Required | Notes |
|---|---|---|
| `platform` | yes | `all`, `x`, `facebook`, `instagram`, `threads` or `linkedin` |
| `query` | yes | 1–200 characters: keywords, a `#hashtag` or a phrase (`q` is accepted as an alias) |
| `cursor` | no | `next_cursor` from the previous page; it keeps the time range |
| `period` | no | `24h`, `7d` or `30d`; not with `since`/`until` |
| `since` | no | Earliest publish time, inclusive (ISO-8601 with a zone, or `YYYY-MM-DD`) |
| `until` | no | Latest publish time, exclusive (same format) |

```bash
curl https://anymd.cc/api/v1/social/search \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"platform":"x","query":"cloudflare workers","period":"7d"}'
```

```json
{
  "platform": "x",
  "query": "cloudflare workers",
  "count": 20,
  "raw_count": 22,
  "duplicate_count": 2,
  "out_of_range_count": 0,
  "missing_timestamp_count": 0,
  "time_range": { "period": "7d", "since": "2026-10-03T08:20:00.000Z", "until": "2026-10-10T08:20:00.000Z" },
  "coverage": "native",
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
  "next_cursor": "amdss2.sss_…",
  "next_page_credits": 10,
  "session_limit_reached": false,
  "credits": 10,
  "platforms": [
    { "platform": "x", "count": 20, "credits": 10, "error": null, "raw_count": 22, "duplicate_count": 2, "out_of_range_count": 0, "missing_timestamp_count": 0, "filter_mode": "native" }
  ],
  "trace_id": "trc_…",
  "duration_ms": 1830
}
```

`author`, `published_at` and each `stats` field are `null` when the platform does not expose them. `text` is capped at 5,000 characters and `media` at 4 URLs. `next_cursor` is `null` on the last page, and always for Threads and LinkedIn, whose providers answer one page per query. `platforms` has one entry per platform searched, with its result `count`, the `credits` it cost, an `error` (or `null`), its removal counts and `filter_mode` (`none` without a range, `native` or `post_filter`). `time_range` is the resolved UTC range (`null` without a filter) and `coverage` is `unfiltered`, `native` or `provider_limited`. The response also carries `X-Anymd-Credits` and `X-Anymd-Trace` headers.

### Paging

`next_cursor` is an opaque handle that works **once**, for 24 hours, for the account that started the search. It is tied to the platform, query and time range: send the same `platform` and `query`, and either omit `period`/`since`/`until` (the cursor carries the range) or repeat them unchanged. A search pages through at most 50 pages or 5,000 remembered posts; then `session_limit_reached` is `true` and `next_cursor` is `null`. Cursors issued before time filters existed still work, but not together with a time filter.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Unknown platform, an empty or too long query, an invalid time filter, a malformed cursor, or a cursor sent with a different platform, query or time range |
| 400 | `cursor_expired` | The cursor is older than 24 hours, unknown or from another account; start the search again |
| 401 | `authentication_required` | No account behind the request |
| 402 | `quota_exceeded` | Fewer credits left this month than the page price |
| 409 | `cursor_conflict` | The cursor was already used (a replay), or its page is still loading in another request; continue from the latest `next_cursor`. A request that was cut off mid-page frees its cursor within two minutes |
| 502 | `upstream_error` | The platform provider failed (with `all`, every provider failed); nothing was charged |
| 503 | `provider_unavailable` | Social search is not configured on this server |
| 503 | `provider_quota` | The platform provider's request quota is used up for now (with `all`, every provider failed); nothing was charged, retry later |

## CLI

```bash
anymd social x "cloudflare workers"
anymd social x "cloudflare workers" --period 7d
anymd social x "cloudflare workers" --cursor 'amdss2.sss_…'
anymd social facebook "cloudflare" --since 2026-10-01 --until 2026-10-08
anymd social linkedin ai agents
anymd social all "cloudflare workers"
anymd social instagram "#travel" --json
```

Results go to stdout; with `all`, each post is tagged with its platform. The credits used, any platform that failed, the time range, removed posts, any partial-coverage note and the command for the next page go to stderr, so you can pipe the posts on their own. Needs an API key (`anymd login`). See [CLI](/docs/cli).

## MCP

The `search_social` tool takes `{ platform, query, cursor?, period?, since?, until? }` (`platform` can be `all`) and returns the same JSON as the REST API. It needs the `convert` scope. Ask your agent things like "search LinkedIn for posts about AI agents this week and read the two most discussed". See [MCP server](/docs/mcp).
