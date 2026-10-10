---
title: "Supported sources"
description: "What anymd converts today (web pages, social posts, X, YouTube, GitHub, Reddit, Hacker News, PDFs, Office files and images), what each returns, limits, and what's planned."
updated: "2026-10-10"
---

anymd picks a converter per URL. Specialised adapters go first; everything else goes through the general web pipeline. The `kind` field in the frontmatter (and the `X-Anymd-Kind` header) tells you which one ran.

## At a glance

| Source | `kind` | What you get | Credits |
|---|---|---|---|
| Any web page | `web` | Main content with clutter removed | 1 |
| X / Twitter | `x` | Posts, long-form Articles, quotes, polls, media, engagement stats | 1 |
| Facebook | `facebook` | Public post text, author, media and optional comments | 10 |
| Instagram | `instagram` | Public post or reel text, author and media; optional comments | 10 |
| Threads | `threads` | Public post text, author and carousel media; optional comments | 10 |
| LinkedIn | `linkedin` | Public post text, author, media and optional comments | 10 |
| YouTube | `youtube` | Title, channel, thumbnail and a timestamped transcript | 3 |
| GitHub | `github` | READMEs, issues, PRs, discussions | 1 |
| Reddit | `reddit` | Threads with comments | 1 |
| Hacker News | `hackernews` | Story plus the top of the discussion, nested | 1 |
| PDF | `pdf` | Text with layout and tables kept | 3 |
| DOCX, XLSX, XLS, ODS, ODT, CSV | `document` | Documents as Markdown, sheets as tables | 3 |
| Images (JPEG, PNG, WebP, SVG) | `image` | A vision-model description and transcription | 5 |
| Plain text, Markdown, JSON URLs | `text` | Passed through (JSON in a code block) | 1 |

Cached results cost 0. Failed conversions cost 0. Full pricing: [Billing & credits](/docs/billing).

## Web pages

The web pipeline fetches the page, parses it with linkedom, and runs a content-extraction engine that finds the main content, removes navigation, ads and boilerplate, standardises headings, code blocks and footnotes, and emits Markdown.

anymd adds a few things on top:

- **Retry for empty shells.** If a client-rendered page comes back with almost no text, anymd retries once with its bot user agent and keeps the richer result. It always identifies as `anymd`.
- **GitHub gets a bot user agent** first, because it serves server-rendered content to bots.
- **Documents behind URLs.** If a URL serves a PDF, Office file or image, it is routed to the document converter automatically.
- **Your overrides.** `selector` picks the content block when automatic detection misses; `images=0` strips images; `lang` sets `Accept-Language`. See [URL API](/docs/url).

Limit: 5 MB of HTML per page.

### Site rules anymd follows

Before fetching a page itself, anymd checks the site's `robots.txt` for the `anymd` token (or `*`) and refuses disallowed pages with `403 robots_disallowed`. If robots.txt cannot be read because of a server error, the request fails with `503 robots_unreachable`. Each site also has a shared per-minute fetch budget (`429 domain_rate_limited`), and domains whose owners opted out are refused on every source with `403 site_opted_out`. None of these use credits. Site owners: see [Site Owners & Abuse](/legal/abuse).

## X / Twitter

Status URLs on `x.com` and `twitter.com` (including `mobile.`) go through the [FxTwitter](https://github.com/FixTweet/FxTwitter) API. You get the post text, long-form Articles, quoted posts, polls, photos and videos, plus `likes`, `retweets`, `replies` and `views` in the frontmatter.

Every read converts the requested post. Signed-in callers can opt in to the rooted same-author thread with `expandThread` (per request or as a saved default), bounded by `maxThreadPosts` (default 20, maximum 100); each additional post is a separate 1-credit unit. Threads no longer expand automatically for signed-in callers. Thread membership follows the provider's relationship and conversation identifiers, so unrelated replies and other authors are excluded.

## Social posts

Facebook, Instagram, Threads and LinkedIn adapters require an account and a configured `RAPIDAPI_KEY`; they accept public post URLs and cost 10 credits for the base post. Comments are opt-in with `includeComments=1` and are charged in started batches of 20. The response can include media without enabling comment retrieval.

Comment retrieval depends on upstream provider availability. Threads uses the `threads-api4.p.rapidapi.com` provider and supports nested replies within the bounded request budget. When that provider reports `has_next_page: true` without a cursor, anymd marks coverage `source_incomplete` instead of treating the page as a successful complete result. Instagram base post, media and image analysis are available, but chronological comments can time out and fall back to a popular subset; reply requests can return 429, so reply coverage is not fully proven. Check `enrichment.comments.complete`, `count` and `reason` instead of assuming comments are complete.

## YouTube

Watch, `youtu.be`, Shorts and Live URLs. Title, channel and thumbnail come from YouTube's oEmbed endpoint. The transcript comes from a third-party caption provider and is grouped into readable paragraphs with timestamps:

```markdown
## Transcript

**0:00** · Welcome back. Today we're looking at…

**0:42** · The first thing to notice is…
```

Pass `lang=vi` (or any language code) to prefer a transcript language. When no transcript is available, the output says so and still includes the video's metadata. That conversion is still charged.

### Video download to the anymd CDN

Off by default. Turn on **Download YouTube videos to the anymd CDN** in [Account → Deep reading defaults](/dashboard/account#reading-defaults) (or `PUT /api/v1/account/reading-preferences` with `{"downloadVideo": true}`). Every YouTube read from your account then also downloads the lowest-quality MP4 of the video (the smallest stream that has sound; a video-only stream only when no other exists, up to 500 MB) to `cdn.anymd.cc`, in the background. The read does not wait for it: the Markdown ends with a section like this, and the JSON response carries the same data in `video_download`:

```markdown
## Video download

The lowest-quality MP4 of this video is being downloaded to the anymd CDN in the background.

- Job: `vid_…` (status: `queued`)
- Check: `GET https://anymd.cc/api/v1/videos/vid_…` with your API key, or the MCP tool `get_video_download` with `{"id": "vid_…"}`.
- Poll every 15 to 30 seconds until `status` is `ready` (the MP4 is at `cdn_url`) or `failed` (see `error`). 20 credits are charged only when it is ready.
```

Status goes `queued` → `downloading` → `ready` or `failed`. Reading the same video again returns the running or finished job instead of starting a new one. When the account cannot pay for a download or the feature is unavailable, the section says why and no job starts.

## Hacker News

`news.ycombinator.com/item?id=…` uses the official Hacker News API: the story (points, author, comment count, link, text) and the top 20 comment threads, each with up to 3 replies, nested as blockquotes up to 3 levels deep.

## Files and documents

PDFs, images, Office documents and spreadsheets are converted with Cloudflare Workers AI `toMarkdown`:

- **PDF:** text layout kept, tables preserved.
- **DOCX, ODT:** document text as Markdown.
- **XLSX, XLS, ODS, CSV:** sheets become Markdown tables.
- **Images:** a vision model describes and transcribes the image; the Markdown starts with the image itself.

Convert a file behind a URL with the [URL API](/docs/url), or upload one with [`POST /api/v1/convert/file`](/docs/api) or `anymd file <path>`. Limit: 20 MB per file.

## What won't convert

- Private networks, `localhost`, internal hostnames and URLs with credentials. They're blocked on purpose.
- Pages behind a login or paywall. anymd sees what an anonymous visitor sees.
- Content types other than HTML, text, JSON and the document types above return `415 unsupported_type`.

If a public page converts badly, [open an issue](https://github.com/digitopvn/anymd/issues) with the URL. That's how adapters get better.

## Planned

These are on the roadmap and **not available yet**:

- Audio and podcasts
- Any video (speech-to-text, beyond YouTube captions)
- TikTok
- Notion
- Google Docs
- EPUB

Until then, the general web pipeline may still extract something useful from some of these, with no guarantee of quality.
