---
title: "Give Your Agent a Markdown Memory with MCP"
slug: give-your-agent-a-markdown-memory-with-mcp
excerpt: "Connect Claude Desktop, Claude Code or Cursor to anymd.cc over MCP. Your agent reads any URL, saves it, and searches everything it has read."
category: guide
tags: [mcp, claude, cursor, ai-agents, guide]
published_at: 2026-09-23
seo_title: "anymd.cc MCP Server: Give Claude and Cursor a Markdown Memory"
seo_description: "Connect Claude Desktop, Claude Code and Cursor to the anymd.cc MCP server with OAuth or an API key. Convert URLs, search your library, fetch documents."
---

Agents forget. Every new session starts from zero. The article your agent summarized on Monday is gone by Thursday, and you are pasting the same link again.

anymd.cc fixes that with a Model Context Protocol server. Connect it once and your agent can:

1. **Read any URL** as clean Markdown.
2. **Keep** what it reads, automatically, in your personal library.
3. **Search** that library later, with keyword, semantic and hybrid search.

It is a memory made of documents you can actually open and read. No opaque vector blob. Just Markdown.

## The server

```text
https://anymd.cc/mcp
```

It speaks MCP over HTTP. There are two ways to authenticate:

- **OAuth 2.1.** Your client opens a browser, you sign in to anymd.cc and approve access. No keys to copy. Best for desktop apps.
- **API key.** Send `Authorization: Bearer amd_...` with each request. Best for headless setups, CI, and clients that do not support OAuth yet.

Create API keys in the dashboard. Pick a role template that matches the job. A research agent that only reads and searches does not need an admin key.

## The tools

The server exposes four tools. Your agent sees their descriptions and decides when to call them.

| Tool | What it does |
| --- | --- |
| `convert_url` | Converts a URL to Markdown with YAML frontmatter and saves it to your library. Works for web pages, X posts, YouTube, Hacker News, PDFs, images and more. |
| `search_library` | Searches your library and returns the best matches. |
| `get_document` | Fetches the full Markdown of one document from your library. |
| `list_documents` | Lists documents in your library, most useful for browsing recent items. |

`convert_url` spends credits like any other conversion: 1 per web page, 3 per YouTube video or PDF/Office file, 5 per image. The three library tools read what you already have. See [pricing](/pricing) for plan allowances.

## Claude Desktop

Claude Desktop supports remote MCP servers as custom connectors.

1. Open **Settings**, then **Connectors**.
2. Choose **Add custom connector**.
3. Name it `anymd` and set the URL to `https://anymd.cc/mcp`.
4. Click **Connect**. A browser window opens. Sign in to anymd.cc and approve.

That is OAuth doing its job. The four tools appear in the tools menu of a new chat. Menu names move around between releases, so if yours look slightly different, look for "connectors" or "integrations".

## Claude Code

One command, with OAuth:

```bash
claude mcp add --transport http anymd https://anymd.cc/mcp
```

Then run `/mcp` inside Claude Code and choose to authenticate `anymd`. Your browser opens, you approve, done.

Prefer an API key? Pass it as a header:

```bash
claude mcp add --transport http anymd https://anymd.cc/mcp \
  --header "Authorization: Bearer amd_your_key_here"
```

Use `--scope user` to make it available in every project, or `--scope project` to share it with your team through the repository's `.mcp.json`. If you share it, use OAuth or reference an environment variable. Never commit a key.

## Cursor

Add the server to `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` in a single project:

```json
{
  "mcpServers": {
    "anymd": {
      "url": "https://anymd.cc/mcp"
    }
  }
}
```

Cursor will prompt you to sign in through OAuth. To use an API key instead:

```json
{
  "mcpServers": {
    "anymd": {
      "url": "https://anymd.cc/mcp",
      "headers": {
        "Authorization": "Bearer amd_your_key_here"
      }
    }
  }
}
```

Open Cursor's MCP settings and check that `anymd` shows a green status and lists its tools.

## Any other MCP client

If your client supports remote servers over HTTP, point it at `https://anymd.cc/mcp` and either let it run the OAuth flow or give it the bearer header. That covers most modern agent frameworks. The [MCP docs](/docs/mcp) have the details.

## Prompts that work well

You do not need to name the tools. Describe the task and the agent will pick the right one. A few that show off what the combination can do:

**Research and remember.**

> Read these three posts about edge databases, summarize each in five bullets, and tell me where they disagree.
> https://example.com/post-1
> https://example.com/post-2
> https://example.com/post-3

The agent calls `convert_url` three times. Each post is now in your library, so next week you can build on it without re-fetching.

**Recall.**

> What did I save about rate limiting in the last few weeks? Give me the key ideas and link the sources.

`search_library` finds the documents, `get_document` pulls the full text of the best ones, and the answer comes back with sources.

**Watch instead of watching.**

> Get the transcript of this talk and list every tool the speaker recommends, with timestamps.
> https://www.youtube.com/watch?v=...

YouTube conversions include a timestamped transcript, so timestamps in the answer point to real moments in the video.

**Follow a debate.**

> Pull this Hacker News thread and summarize the three strongest arguments on each side.

Replies come through nested under the comments they answer, so the agent can tell a reply from a top-level comment.

**Build on your own notes.**

> Find everything in my library about pricing pages, then draft a checklist based on what those articles agree on.

This is where the memory pays off. The more your agent reads, the better this prompt gets.

## Why Markdown makes a good memory

You could build agent memory with a vector database and nothing else. Plenty of people do. But then the memory is a pile of chunks nobody can read.

Your anymd library is different:

- **Every document is readable.** Open it in the dashboard, export it as Markdown or JSON, drop it into Obsidian.
- **Every document has provenance.** The frontmatter keeps the source URL, author and dates, so your agent can cite where a fact came from.
- **Search is hybrid.** BM25 keyword ranking for exact terms, semantic search with bge-m3 embeddings for concepts, and query fan-out with Reciprocal Rank Fusion to cover phrasing you did not think of. We explain how it works in [Hybrid search, explained](/blog/hybrid-search-bm25-semantic-query-fanout).

Your agent gets recall. You keep a library you own.

## Security notes

- **Scope your keys.** Use role templates to give each client only what it needs. Revoke a key from the dashboard the moment you suspect it leaked.
- **Prefer OAuth on desktops.** No long-lived secret sits in a config file.
- **Watch the logs.** Every call shows up in your dashboard's usage logs, with a trace of per-step timings. If an agent goes on a spree, you will see it.
- **Content is data.** Pages your agent reads can contain text written to manipulate AI models. A good agent client treats fetched content as information, not instructions. Keep tool confirmations on for actions that matter.

## Troubleshooting

- **Tools do not appear.** Restart the client after adding the server, and check that the URL is exactly `https://anymd.cc/mcp`.
- **401 Unauthorized.** The key is missing, mistyped or revoked, or the OAuth session expired. Reconnect or create a new key.
- **Conversions fail on a specific site.** Test the same URL directly with `curl https://anymd.cc/<url>`. If that fails too, see [how to convert any URL](/blog/convert-any-url-to-markdown) for common causes.
- **Out of credits.** Check your balance in the dashboard, or look at [Pro and Scale plans](/pricing).

## Start now

1. Sign up for free. You get 500 credits a month.
2. Add `https://anymd.cc/mcp` to your client.
3. Ask your agent to read something.

Then ask it again next week, and watch it remember. More in the [docs](/docs) and on the [blog](/blog).
