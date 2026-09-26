---
title: "Introducing anymd.cc: The Internet, as Markdown"
slug: introducing-anymd
excerpt: "Put anymd.cc/ in front of any URL and get clean, LLM-ready Markdown back. Web pages, X posts, YouTube, PDFs and more. Open source, edge-fast."
category: announcement
tags: [launch, markdown, ai-agents, open-source, mcp]
published_at: 2026-09-20
seo_title: "Introducing anymd.cc: Convert Anything on the Internet to Markdown"
seo_description: "anymd.cc turns any URL into clean, LLM-ready Markdown with YAML frontmatter. Web pages, X, YouTube, PDFs, a searchable library, REST, CLI and MCP."
---

The internet was built for eyeballs. Your AI agent does not have eyeballs.

It has a context window. And every time you paste a web page into that window, you are paying to ship it navigation bars, cookie banners, tracking scripts, twelve nested `<div>`s and a newsletter pop-up. The actual article is in there somewhere. Good luck.

Today we are launching **anymd.cc**. It does one thing, and it does it everywhere:

**Convert anything on the internet to clean Markdown.**

## The trick

Put `anymd.cc/` in front of any URL.

```text
https://stephango.com/saw
        becomes
https://anymd.cc/stephango.com/saw
```

That is the whole interface. Open it in a browser, `curl` it, fetch it from a script, hand it to an agent. You get Markdown with YAML frontmatter on top: title, author, source, dates, whatever the page actually knows about itself. Below that, the content. No chrome. No noise.

```bash
curl https://anymd.cc/stephango.com/saw
```

Need structured data instead? Ask for it.

```bash
curl -H "Accept: application/json" https://anymd.cc/stephango.com/saw
```

Need cleaned HTML for a renderer that expects it?

```bash
curl "https://anymd.cc/stephango.com/saw?format=html"
```

Same URL. Three shapes. Pick the one your pipeline wants.

## Why we built it

We build AI tooling at [Digitop.ai](https://digitop.ai). Agents, gateways, knowledge bases. Every one of those projects hit the same wall: getting clean text out of the web is annoyingly hard.

Not hard like "unsolved research problem". Hard like "death by a thousand edge cases". A blog post is easy. An X thread with quote posts, a poll and a community note is not. A YouTube video has no article at all; the content is in the transcript. A Hacker News thread is a tree. A PDF is a PDF. A single-page app renders nothing until JavaScript runs, and then only if it likes your user agent.

We kept writing the same glue code. So we stopped, and wrote it once, properly.

## Standing on good shoulders

The core is a proven, open-source content-extraction engine. It is excellent at the hard part: finding the actual content on a page and throwing away the rest.

anymd inherits the GoClaw Fetch lineage from [nextlevelbuilder](https://nextlevelbuilder.io), uses **linkedom** for fast server-side DOM parsing, and adds a stack of site-aware handlers on top:

- **X / Twitter** posts and long-form Articles, via the FxTwitter API. Quotes, polls, media, community notes and engagement stats come through.
- **YouTube** metadata via oEmbed, plus timestamped transcripts from a RapidAPI transcript service (VidCap as fallback).
- **Hacker News** threads through the official API, with replies nested under their parents.
- **GitHub, Reddit, Wikipedia, Substack, Medium** through site-aware extractors. Threads, LinkedIn and Facebook are on the roadmap.
- **Shared AI conversations** from ChatGPT, Claude and Gemini.
- **Files**: PDFs, images (described with vision), DOCX, XLSX and CSV, through Cloudflare Workers AI's `toMarkdown`.

When a page renders client-side and returns an empty shell, anymd retries with bot and browser user agents before giving up. Most of the time, it does not give up.

## Open source, for real

The engine is **MIT licensed** at [github.com/digitopvn/anymd](https://github.com/digitopvn/anymd). Read it, fork it, run it yourself, send a pull request. If a site converts badly, you can see exactly why and fix it.

The hosted service at anymd.cc runs that same engine on Cloudflare's edge: Workers for compute, D1 for data, Vectorize for embeddings, R2 for storage. Requests are handled close to wherever they come from.

## More than a converter

A converter is a function. We wanted a tool you keep coming back to.

### Your Markdown library

Sign in, and every conversion is saved to your personal library. That turns "I read something about this last month" into a search query.

Library search is not a toy `LIKE '%foo%'`:

- **BM25 ranking** on SQLite FTS5, with full-text syntax: phrases, prefixes, boolean operators.
- **Semantic search** with bge-m3 embeddings stored in Vectorize, for when you remember the idea but not the words.
- **Query fan-out**: an LLM rewrites your query into variants, and the results are fused with Reciprocal Rank Fusion.
- **Jev** (TypeSafe System One) as an optional decider that picks between near-tied top results.

We wrote up how the pieces fit together in [Hybrid search, explained](/blog/hybrid-search-bm25-semantic-query-fanout).

### Every interface you would want

- **REST API.** The URL prefix is the API.
- **CLI.** The `anymd` command, for your terminal and your shell scripts.
- **MCP server** at `https://anymd.cc/mcp`, over HTTP, with OAuth 2.1 or API keys. Plug it into Claude, Cursor or any MCP client and your agent can convert pages and search your library on its own. Setup is in the [MCP docs](/docs/mcp).
- **WebMCP tools** in the browser, for agents that drive web pages.
- **A `.md` twin of every page on this site**, plus `llms.txt` and `llms-full.txt`. We eat our own cooking.

### A dashboard that shows its work

Usage logs for every request. **Traces** with per-conversion span timings, so when something is slow you can see which step was slow. API keys with role templates, so the key in your CI job cannot do what your admin key can.

## Pricing

Credits keep it simple. One web page costs one credit. YouTube videos and PDF or Office files cost three. Images cost five, because vision models are not free.

- **Free**: $0, 500 credits a month. Enough to kick the tires properly.
- **Pro**: $9/month, or $84/year ($7/month). 10,000 credits a month, overage at $1 per 1,000.
- **Scale**: $49/month, or $468/year ($39/month). 100,000 credits a month, overage at $0.60 per 1,000.

Payments go through Polar.sh, which handles tax and VAT. Full details on the [pricing page](/pricing).

**Launch offer: 30% off with code LAUNCH30, until 2026-10-31.**

## Who it is for

- **Agent builders** who need a reliable "read this URL" tool that returns something a model can actually use.
- **RAG pipelines** that want clean chunks with real metadata, not scraped soup.
- **Researchers and writers** who want a searchable archive of everything they read, in a format that will still open in thirty years.
- **Obsidian and plain-text people** who already know Markdown is the right answer.

## Who made it

anymd.cc is built by [Digitop.ai](https://digitop.ai), led by Duy Nguyen, better known as /zuey/ (a.k.a. Goon), founder of the Build in Public VN community. You can find him on [X](https://x.com/goon_nguyen) and [GitHub](https://github.com/mrgoonie).

It sits alongside the rest of our ecosystem: Dewee.sh, AgentBrain.sh, AgentKit.best, GoClaw.sh, AgentWiki.cc, UI UX Pro Max and TOSE.sh. Same philosophy across all of them. Build tools that agents and humans can both use without a manual.

## Try it now

Pick a URL you read today. Put `anymd.cc/` in front of it. See what comes back.

Then read the [docs](/docs), wire up the [MCP server](/docs/mcp), and browse the rest of the [blog](/blog) for guides. If something converts badly, tell us at hello@digitop.ai or open an issue on GitHub. Broken pages are how this thing gets better.

The internet, as Markdown. Finally.
