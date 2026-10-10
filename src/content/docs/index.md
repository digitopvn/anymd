---
title: "Documentation"
description: "anymd is the web context layer for AI agents. Docs for MCP, the URL API, REST, CLI, WebMCP, library search and self-hosting."
updated: "2026-10-10"
---

anymd is the web context layer for AI agents. It reads public web content, normalizes it into structured Markdown, remembers what your agents read in a private searchable library, and makes all of it available through MCP, the API and the CLI.

The fastest way to see it: put `anymd.cc/` in front of a link and you get the content back, with no nav bars, cookie banners or scripts. Just text your model can use, with YAML frontmatter on top.

```bash
curl https://anymd.cc/stephango.com/saw
```

The rest of these docs cover doing it from inside an agent, from code and from your terminal, and recalling what was read later.

## Pick your path

| I want to… | Start here |
|---|---|
| Try it in 60 seconds | [Quickstart](/docs/quickstart) |
| Convert a URL with zero setup | [URL API](/docs/url) |
| Call anymd from my app | [REST API](/docs/api) |
| Use it from the terminal | [CLI](/docs/cli) |
| Give Claude, Cursor or my agent web context over MCP | [MCP server](/docs/mcp) |
| Let in-browser agents use anymd.cc | [WebMCP](/docs/webmcp) |
| Find something my agents read last month | [Library & search](/docs/library-search) |
| Find public posts on X, Facebook, Instagram, Threads or LinkedIn | [Social search](/docs/social-search) |
| Know which sources have dedicated readers | [Supported sources](/docs/sources) |
| Scope a key for CI or a teammate | [API keys & roles](/docs/api-keys-roles) |
| Understand credits and plans | [Billing & credits](/docs/billing) |
| Run my own copy on Cloudflare | [Self-hosting](/docs/self-host) |

## Core ideas

- **Read, remember, use anywhere.** anymd reads a source once, keeps it as private context, and serves it to every agent you connect.
- **The URL is the API.** `https://anymd.cc/<url>` returns Markdown. No key needed for light use (50 reads a day per IP).
- **One engine, every channel.** The URL API, REST, CLI, MCP and WebMCP all run the same conversion pipeline, so output is identical wherever you call it from.
- **Pay for new context, not seats.** Processing a new source uses credits by complexity (a web page is 1). Searching your library and cached reads are free. See [Billing & credits](/docs/billing).
- **Your library remembers.** Sign in (or send an API key) and every source your agents read is saved to a private library with BM25, full-text, semantic and hybrid search.
- **Scoped access.** Every API key and OAuth grant carries scopes, capped by its owner's role. See [API keys & roles](/docs/api-keys-roles).
- **Responsible reading.** anymd only reads URLs you or your agent request, only public content, and follows robots.txt, domain opt-outs and per-site rate limits. See [Supported sources](/docs/sources) and [Site Owners & Abuse](/legal/abuse).

## These docs are Markdown too

Every page on anymd.cc has a Markdown twin. Append `.md` to the path (`/docs/api.md`, `/pricing.md`) or send `Accept: text/markdown`. Point your agent at them directly.

The machine-readable API spec lives at [`/api/v1/openapi.json`](/api/v1/openapi.json), with an interactive reference at [`/docs/api/reference`](/docs/api/reference).

## Get help

- Something converts badly? Open an issue at [github.com/digitopvn/anymd](https://github.com/digitopvn/anymd/issues). Broken pages are how the engine gets better.
- Everything else: [hello@digitop.ai](mailto:hello@digitop.ai).

anymd is open source under the MIT license and built by [Digitop.ai](https://digitop.ai).
