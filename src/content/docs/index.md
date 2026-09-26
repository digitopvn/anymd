---
title: "Documentation"
description: "Everything you need to turn any URL into clean Markdown with anymd: URL API, REST, CLI, MCP, WebMCP, library search and more."
updated: "2026-09-26"
---

anymd converts anything on the internet to clean Markdown. Put `anymd.cc/` in front of a link and you get the content back: no nav bars, no cookie banners, no scripts. Just text your model can use, with YAML frontmatter on top.

```bash
curl https://anymd.cc/stephango.com/saw
```

That's the whole trick. Everything else in these docs is about doing it at scale, from code, from your terminal, or from inside an agent.

## Pick your path

| I want to… | Start here |
|---|---|
| Try it in 60 seconds | [Quickstart](/docs/quickstart) |
| Convert a URL with zero setup | [URL API](/docs/url) |
| Call anymd from my app | [REST API](/docs/api) |
| Use it from the terminal | [CLI](/docs/cli) |
| Give Claude, Cursor or my agent a "read this URL" tool | [MCP server](/docs/mcp) |
| Let in-browser agents use anymd.cc | [WebMCP](/docs/webmcp) |
| Find something I converted last month | [Library & search](/docs/library-search) |
| Know what converts well (X, YouTube, PDFs…) | [Supported sources](/docs/sources) |
| Scope a key for CI or a teammate | [API keys & roles](/docs/api-keys-roles) |
| Build landing pages with an AI agent | [Page builder](/docs/page-builder) |
| Understand credits and plans | [Billing & credits](/docs/billing) |
| Run my own copy on Cloudflare | [Self-hosting](/docs/self-host) |

## Core ideas

- **The URL is the API.** `https://anymd.cc/<any-url>` returns Markdown. No key needed for light use (50 conversions a day per IP).
- **One engine, every channel.** The URL API, REST, CLI, MCP and WebMCP all run the same conversion pipeline, so output is identical wherever you call it from.
- **Credits, not seats.** A web page costs 1 credit; heavier sources cost more. Searching your library and re-serving cached results are free. See [Billing & credits](/docs/billing).
- **Your library remembers.** Sign in (or send an API key) and every conversion is saved to a private, searchable library with BM25, full-text and semantic search.
- **Scoped access.** Every API key and OAuth grant carries scopes, capped by its owner's role. See [API keys & roles](/docs/api-keys-roles).

## These docs are Markdown too

Every page on anymd.cc has a Markdown twin. Append `.md` to the path (`/docs/api.md`, `/pricing.md`) or send `Accept: text/markdown`. Point your agent at them directly.

The machine-readable API spec lives at [`/api/v1/openapi.json`](/api/v1/openapi.json), with an interactive reference at [`/docs/api/reference`](/docs/api/reference).

## Get help

- Something converts badly? Open an issue at [github.com/digitopvn/anymd](https://github.com/digitopvn/anymd/issues). Broken pages are how the engine gets better.
- Everything else: [hello@digitop.ai](mailto:hello@digitop.ai).

anymd is open source under the MIT license and built by [Digitop.ai](https://digitop.ai).
