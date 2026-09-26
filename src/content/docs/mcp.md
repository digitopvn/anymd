---
title: "MCP server"
description: "Connect Claude Code, Claude Desktop, Cursor or any MCP client to anymd.cc/mcp so your agents can read the public web, remember it and search it."
updated: "2026-09-26"
---

anymd runs a remote [Model Context Protocol](https://modelcontextprotocol.io) server. It is the main way agents use anymd as their web context layer: connect it once and your agent can read public web content as structured Markdown, recall everything it has read from your private library, and (with the right scopes) manage pages.

| | |
|---|---|
| Endpoint | `https://anymd.cc/mcp` |
| Transport | Streamable HTTP, stateless JSON responses |
| Auth | `Authorization: Bearer amd_…`, or OAuth 2.1 |

## Authentication

**API key.** Simplest option. Create a key in **Dashboard → API keys**. The **Convert + library (agents)** preset is a good default for an assistant. Details: [API keys & roles](/docs/api-keys-roles).

**OAuth 2.1.** For clients that support it, just add the URL and sign in when prompted. anymd supports Dynamic Client Registration and PKCE:

| | |
|---|---|
| Metadata | `/.well-known/oauth-authorization-server` |
| Authorize | `/oauth/authorize` |
| Token | `/oauth/token` |
| Registration | `/oauth/register` |

Either way, your agent only sees the tools its scopes allow.

## Client setup

Run `anymd mcp` from the [CLI](/docs/cli) to print these snippets with your key filled in.

### Claude Code

```bash
claude mcp add --transport http anymd https://anymd.cc/mcp \
  --header "Authorization: Bearer amd_…"
```

### Claude Desktop

Add anymd as a custom connector: **Settings → Connectors → Add custom connector**, URL `https://anymd.cc/mcp`, then sign in through OAuth.

If you'd rather use an API key, bridge the remote server through `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "anymd": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://anymd.cc/mcp", "--header", "Authorization: Bearer amd_…"]
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "anymd": {
      "url": "https://anymd.cc/mcp",
      "headers": { "Authorization": "Bearer amd_…" }
    }
  }
}
```

### Any other client

Any client that speaks Streamable HTTP can use the same shape: URL `https://anymd.cc/mcp` plus an `Authorization` header, or OAuth discovery from the metadata URL above.

## Tools

Tools are listed only when the caller holds the scope they need.

### Conversion and library

| Tool | Input | Needs |
|---|---|---|
| `read_url` | `{ url, save?, fresh? }` | `convert` (saving also needs `library:write`) |
| `convert_url` | `{ url, save?, fresh? }` | Same as `read_url`, kept under its original name for existing clients |
| `search_library` | `{ query, mode?, limit? }` | `library:read` |
| `get_document` | `{ id }` | `library:read` |
| `list_documents` | `{ limit?, domain? }` | `library:read` |
| `delete_document` | `{ id }` | `library:write` |
| `usage_summary` | `{}` | `usage:read` |

`read_url` and `convert_url` are the same tool with the same input and output; new integrations should use `read_url`. `mode` is `hybrid` (default), `bm25`, `fulltext` or `semantic`. See [Library & search](/docs/library-search).

### Pages and posts

| Tool | Input | Needs |
|---|---|---|
| `list_blocks` | `{}` | `pages:read` |
| `list_page_templates` | `{}` | `pages:read` |
| `list_pages` | `{}` | `pages:read` |
| `get_page` | `{ id }` | `pages:read` |
| `create_page` | `{ slug, title, description?, template? }` | `pages:write` |
| `apply_page_ops` | `{ pageId, baseRevision, ops, idempotencyKey? }` | `pages:write` |
| `publish_page` | `{ pageId, revision? }` | `pages:publish` |
| `unpublish_page` | `{ pageId }` | `pages:publish` |
| `list_posts` | `{}` | `content:read` |
| `upsert_post` | `{ id?, slug?, title, markdown, excerpt?, tags? }` | `content:write` |
| `publish_post` | `{ id, publish }` | `content:publish` |

The ops format, revision rules and the safe editing loop are in the admin [builder guide](/admin/docs/page-builder).

## Things to ask your agent

- "Read https://stephango.com/saw and give me the three key ideas."
- "Before you read anything new, check my library for what we already know about this vendor."
- "Search my library for what I saved about vector databases last month."
- "Read this YouTube video's transcript and list the timestamps where pricing comes up."
- "Create a landing page from the `ads-landing` template for our research audience, show me the preview link, and don't publish yet."

## Credits

`read_url` (and `convert_url`) costs the same credits as any other conversion; cached reads are free. Reads such as `search_library`, `get_document` and `list_documents` are free. See [Billing & credits](/docs/billing).

## Troubleshooting

| Symptom | Fix |
|---|---|
| A tool is missing | Your key or OAuth grant lacks its scope. Check with `GET /api/v1/me` or `anymd whoami`. |
| `401 invalid_api_key` | The key was revoked, expired or mistyped. Create a new one. |
| `402 quota_exceeded` | Free plan credits are used up for the month. |
| `revision_conflict` from `apply_page_ops` | Someone changed the page. Call `get_page`, then retry with the new `revision`. |
