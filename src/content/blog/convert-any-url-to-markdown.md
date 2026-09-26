---
title: "How to Convert Any URL to Markdown"
slug: convert-any-url-to-markdown
excerpt: "The URL prefix trick, curl recipes, JSON and HTML output, supported sources, and what to do when a page will not convert."
category: guide
tags: [guide, api, curl, markdown, web-scraping]
published_at: 2026-09-22
seo_title: "Convert Any URL to Markdown: A Practical Guide to anymd.cc"
seo_description: "Turn any web page into clean Markdown with YAML frontmatter. The anymd.cc URL prefix, curl examples, JSON and HTML formats, supported sites and errors."
---

This is the practical guide. No philosophy, just recipes. By the end you will know how to turn any URL into Markdown from a browser, a terminal, a script and an agent, and what to do when a page fights back.

## The one-line version

Put `anymd.cc/` in front of the URL.

```text
https://anymd.cc/stephango.com/saw
```

Open that in a browser and you get Markdown. That is it. That is the API.

It works with or without the scheme. Both of these point at the same page:

```text
https://anymd.cc/stephango.com/saw
https://anymd.cc/https://stephango.com/saw
```

The `#fragment` part of a URL is dropped, since it never reaches the server anyway. Targets with their own query strings, like YouTube's `watch?v=` or Hacker News's `item?id=`, work as they are; just quote them in your shell. If a target's own parameters could clash with anymd's options, like `format`, URL-encode the target. Private and internal addresses (`localhost`, `192.168.x.x` and friends) are refused.

## From the terminal

```bash
curl https://anymd.cc/stephango.com/saw
```

Save it to a file:

```bash
curl -s https://anymd.cc/stephango.com/saw -o saw.md
```

Grab a list of pages in one go:

```bash
while read -r url; do
  name=$(echo "$url" | tr '/:?' '___')
  curl -s "https://anymd.cc/$url" -o "$name.md"
done < urls.txt
```

Every file starts with YAML frontmatter (title, source and whatever else the page exposes) and then the content. Drop the folder into Obsidian and it just works.

## Authenticate for your library and higher limits

Anonymous requests work, and results are cached briefly. To save conversions to your library and draw from your plan's credits, send an API key. Create one in the dashboard, then:

```bash
curl -H "Authorization: Bearer amd_your_key_here" \
  https://anymd.cc/stephango.com/saw
```

Keys support role templates, so give your cron job a key that can convert and nothing else. Keep keys out of your repository. Use an environment variable:

```bash
export ANYMD_API_KEY=amd_your_key_here
curl -H "Authorization: Bearer $ANYMD_API_KEY" https://anymd.cc/stephango.com/saw
```

## Choose your output format

Same URL, three formats.

**Markdown (default).** Human-readable, model-friendly, frontmatter on top.

```bash
curl https://anymd.cc/stephango.com/saw
```

**JSON.** Ask with the `Accept` header. Good for pipelines that want the content and metadata as fields rather than parsing frontmatter.

```bash
curl -H "Accept: application/json" https://anymd.cc/stephango.com/saw | jq 'keys'
```

Run `jq 'keys'` once to see what fields come back for your source, then pick the ones you need.

**Cleaned HTML.** Add `?format=html`. You get the extracted content with page furniture removed, but HTML semantics intact. Useful when you feed a renderer or an HTML-based chunker.

```bash
curl "https://anymd.cc/stephango.com/saw?format=html"
```

## From code

It is just HTTP, so any client works.

**JavaScript / TypeScript:**

```ts
const target = "stephango.com/saw";
const res = await fetch(`https://anymd.cc/${target}`, {
  headers: { Authorization: `Bearer ${process.env.ANYMD_API_KEY}` },
});
if (!res.ok) throw new Error(`anymd ${res.status}: ${await res.text()}`);
const markdown = await res.text();
```

**Python:**

```python
import os, requests

res = requests.get(
    "https://anymd.cc/stephango.com/saw",
    headers={"Authorization": f"Bearer {os.environ['ANYMD_API_KEY']}"},
    timeout=60,
)
res.raise_for_status()
markdown = res.text
```

Prefer a command? The `anymd` CLI wraps the same API for your terminal and shell scripts. Setup is in the [docs](/docs).

## What it understands

A generic extractor handles most articles and docs pages well. anymd adds site-aware handling where generic extraction falls short.

| Source | What you get |
| --- | --- |
| Articles, blogs, docs | Main content, with page furniture removed |
| X / Twitter | Posts and long-form Articles via FxTwitter: quotes, polls, media, community notes, engagement stats |
| YouTube | oEmbed metadata plus a timestamped transcript (RapidAPI, VidCap fallback) |
| Hacker News | Threads via the official API, replies nested under their parents |
| GitHub, Reddit, Wikipedia | Site-aware extraction |
| Substack, Medium | Site-aware extraction |
| Substack, Medium, Wikipedia | Site-aware extraction |
| ChatGPT, Claude, Gemini | Shared conversations, turn by turn |
| PDF, DOCX, XLSX, CSV | Converted with Cloudflare Workers AI `toMarkdown` |
| Images | A vision-generated description |

For the special cases, like transcripts, threads and spreadsheets, see [YouTube, X, PDFs and more](/blog/youtube-x-pdf-to-markdown).

## What it costs

One web page is **1 credit**. YouTube videos and PDF or Office files are **3**. Images are **5**. The Free plan includes 500 credits a month. Pro and Scale add far more, and paid plans keep going past the allowance at a small per-1,000 overage instead of stopping. Details on the [pricing page](/pricing).

## When a page will not convert

Most pages just work. Some do not. Here is how to think about it.

**The page renders client-side.** Single-page apps sometimes return an empty shell to anything that is not a real browser. anymd retries automatically with bot and browser user agents, which rescues most of these. If the content only appears after a login or user interaction, it is not publicly reachable, and anymd will not get it either.

**The page is behind a login or paywall.** anymd fetches what is publicly reachable. It does not log in as you and it does not bypass paywalls. That is both a technical fact and a rule in our [terms](/legal/terms).

**The site blocks automated access.** Some sites refuse requests that are not from a person with a browser. Respect that. If you own the site, you know where to look.

**The output looks thin.** Occasionally the extractor picks the wrong block, usually on unusual layouts. Try `?format=html` to see what was extracted, and check the trace for that request in your dashboard.

**You get an error status.** Failed conversions return a non-2xx status, a human-readable message and a short machine code. The ones you are most likely to meet:

| Status | Code | What it means | What to do |
| --- | --- | --- | --- |
| 400 | `invalid_url` | Not a valid http(s) URL, or it contains credentials | Fix the URL |
| 400 | `blocked_host` | Private, internal or self-referential address | Use a public URL |
| 404 | `not_found` | The page, post or video does not exist or is private | Check the link |
| 413 | `too_large` | Over 5 MB of HTML, or a document over 20 MB | Link a smaller file |
| 415 | `unsupported_type` | A content type anymd does not convert | Check the file format |
| 422 | `empty_content` | The page loaded but had no readable content | See client-side rendering above |
| 422 | `document_failed` | The file could not be converted | Check the file opens normally |
| 502 | `fetch_failed`, `upstream_status`, `upstream_error` | The target site or an upstream API failed | Retry later |

Running out of credits or hitting a rate limit also returns an error with a message. For rate limits, back off and try again. For credits, check your balance in the dashboard. The full list lives in the [docs](/docs).

**Use the trace.** Signed-in requests are logged with a trace: per-step span timings for fetching, extracting and converting. When something is slow or empty, the trace shows which step was responsible.

And if a popular site converts badly, tell us at hello@digitop.ai or open an issue on [GitHub](https://github.com/digitopvn/anymd). The engine is open source, so you can also look at the handler and send a fix.

## Give it to your agent

The same conversion is available as a tool over MCP, so an agent can fetch pages on its own and save them to your library as it goes. Connect Claude, Cursor or any MCP client to `https://anymd.cc/mcp`. The walkthrough is in [Give your agent a Markdown memory](/blog/give-your-agent-a-markdown-memory-with-mcp) and the reference lives in the [MCP docs](/docs/mcp).

## Cheat sheet

```bash
# Markdown
curl https://anymd.cc/example.com/page

# JSON
curl -H "Accept: application/json" https://anymd.cc/example.com/page

# Cleaned HTML
curl "https://anymd.cc/example.com/page?format=html"

# Authenticated, saved to your library
curl -H "Authorization: Bearer $ANYMD_API_KEY" https://anymd.cc/example.com/page
```

Bookmark this, or better, put `anymd.cc/` in front of it. More guides on the [blog](/blog).
