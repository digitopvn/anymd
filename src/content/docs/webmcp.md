---
title: "WebMCP"
description: "anymd.cc registers WebMCP tools in the browser so in-page AI agents can convert URLs, read page Markdown and search your library."
updated: "2026-09-26"
---

[MCP](/docs/mcp) connects agents to anymd over the network. **WebMCP** is the in-browser counterpart: a web page declares tools, and an AI agent running in the browser (an extension, a built-in assistant, an automation harness) calls them directly instead of scraping the DOM.

anymd.cc provides WebMCP tools on its own pages. If your browser agent supports WebMCP, it gets structured, reliable actions on anymd.cc with zero setup.

## How it works

When `navigator.modelContext` exists, anymd pages call:

```js
navigator.modelContext.provideContext({ tools });
```

Browsers or agents without WebMCP simply don't see the tools. Nothing else on the page changes. Each tool ships its own name, description and JSON input schema, so a compliant agent discovers what to send without reading these docs.

Tools run with the page's own session. If you're signed in to anymd.cc, library tools act on your library, under your role's scopes. No API key ever enters the page.

## Tools on every page

| Tool | What it does | Availability |
|---|---|---|
| `read_url` | Read a public URL and return structured Markdown | Everyone (anonymous limits apply) |
| `convert_url` | Same as `read_url`, under its original name | Everyone (anonymous limits apply) |
| `get_page_markdown` | Return the current page as Markdown (its `.md` twin) | Everyone |
| `search_library` | Search your saved documents | Signed in |
| `list_documents` | List recent library documents | Signed in |

## Extra tools in the page editor

When you open a page in the dashboard editor, it adds tools for building that page:

| Tool | What it does |
|---|---|
| `get_page` | Read the page: revision, draft blocks, preview URL |
| `list_blocks` | The block catalog with JSON Schemas |
| `apply_page_ops` | Apply a batch of ops against a `baseRevision` |
| `publish_page` | Publish the draft (or a given revision) |

These follow exactly the same rules as the REST API and MCP versions: optimistic concurrency, validation per block, scopes from your role. Admins: see the [builder guide](/admin/docs/page-builder).

## When to use which

| You are… | Use |
|---|---|
| An agent in the user's browser, already on anymd.cc | WebMCP |
| A desktop or CLI agent (Claude Code, Cursor, Claude Desktop) | [MCP server](/docs/mcp) |
| Your own backend or script | [REST API](/docs/api) or [URL API](/docs/url) |
| An agent that can only fetch URLs | [URL API](/docs/url) and `.md` twins |

## Checking support

In the browser console:

```js
'modelContext' in navigator
```

`false` means the browser doesn't expose WebMCP. anymd still works normally, and agents can fall back to the `.md` twin of any page (`/pricing.md`, `/docs/api.md`).
