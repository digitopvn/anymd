---
title: "Supported sources"
description: "What anymd converts today (web pages, X, YouTube, GitHub, Reddit, Hacker News, PDFs, Office files, images), what each returns, limits, and what's planned."
updated: "2026-09-26"
---

anymd picks a converter per URL. Specialised adapters go first; everything else goes through the general web pipeline. The `kind` field in the frontmatter (and the `X-Anymd-Kind` header) tells you which one ran.

## At a glance

| Source | `kind` | What you get | Credits |
|---|---|---|---|
| Any web page | `web` | Main content with clutter removed | 1 |
| X / Twitter | `x` | Posts, long-form Articles, quotes, polls, media, engagement stats | 1 |
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

- **Retry for empty shells.** If a client-rendered page comes back with almost no text, anymd retries with bot and browser user agents and keeps the richest result.
- **GitHub gets a bot user agent** first, because it serves server-rendered content to bots.
- **Documents behind URLs.** If a URL serves a PDF, Office file or image, it is routed to the document converter automatically.
- **Your overrides.** `selector` picks the content block when automatic detection misses; `images=0` strips images; `lang` sets `Accept-Language`. See [URL API](/docs/url).

Limit: 5 MB of HTML per page.

## X / Twitter

Status URLs on `x.com` and `twitter.com` (including `mobile.`) go through the [FxTwitter](https://github.com/FixTweet/FxTwitter) API. You get the post text, long-form Articles, quoted posts, polls, photos and videos, plus `likes`, `retweets`, `replies` and `views` in the frontmatter.

## YouTube

Watch, `youtu.be`, Shorts and Live URLs. Title, channel and thumbnail come from YouTube's oEmbed endpoint. The transcript comes from a third-party caption provider and is grouped into readable paragraphs with timestamps:

```markdown
## Transcript

**0:00** · Welcome back. Today we're looking at…

**0:42** · The first thing to notice is…
```

Pass `lang=vi` (or any language code) to prefer a transcript language. When no transcript is available, the output says so and still includes the video's metadata. That conversion is still charged.

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
- Facebook
- LinkedIn
- Threads
- TikTok
- Notion
- Google Docs
- EPUB

Until then, the general web pipeline may still extract something useful from some of these, with no guarantee of quality.
