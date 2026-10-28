---
title: "Use anymd with Claude"
description: "Connect anymd to Claude on claude.ai, Cowork, Claude Desktop and Claude Code as a connector, or install the AnyMD Research plugin for cited web research and a private library."
updated: "2026-10-28"
---

anymd gives Claude the public web as clean Markdown and a private library of the sources you choose to keep. There are two ways to add it, and they work together:

| | What you get | Where |
|---|---|---|
| **anymd connector** | The anymd tools: read a URL, search your library, open a saved document, tag, search social posts | claude.ai, Cowork, Claude Desktop, Claude Code |
| **AnyMD Research plugin** | The connector plus a `research` skill: recall from your library, read the sources, answer with citations, save only when you ask | Claude Code and other plugin surfaces |

Both use the same server, `https://anymd.cc/mcp`, and the same sign-in. If you add both, Claude uses one anymd connection.

## Add the connector

On claude.ai, Cowork or Claude Desktop: **Settings → Connectors → Add custom connector**, URL `https://anymd.cc/mcp`, then sign in to anymd when asked. A free anymd account works.

In Claude Code:

```bash
claude mcp add --transport http anymd https://anymd.cc/mcp
```

Then run `/mcp` in Claude Code and choose anymd to sign in. Prefer an API key? See [MCP server](/docs/mcp#claude-code).

## Install the plugin

The plugin lives in the open-source repository under [`plugins/anymd-research`](https://github.com/digitopvn/anymd/tree/main/plugins/anymd-research). In Claude Code:

```bash
/plugin install anymd-research --marketplace digitopvn/anymd
```

The plugin contains one skill and the server entry. It has no hooks, scripts or local code.

## What Claude can access

Sign-in uses OAuth 2.1 with PKCE. The consent screen asks for three permissions and nothing more:

| Permission | Lets Claude |
|---|---|
| `convert` | Read public URLs (uses your credits) |
| `library:read` | Search and open documents in your own library |
| `library:write` | Save, tag and delete documents in your own library |

With these, Claude sees these tools: `read_url` (and its original name `convert_url`), `search_library`, `get_document`, `list_documents`, `list_tags`, `tag_document`, `delete_document`, `search_social` and `get_video_download`. Read tools are marked read-only; `delete_document` is marked destructive, so Claude asks before deleting. Your library is private to your account: no other user, connection or key of another account can search it. Revoke the connection any time in **Dashboard → Connected apps**.

## Credits

Reading a new page costs credits by complexity (a web page is 1); cached reads and library search are free. Thread expansion, comments, image and video analysis and social search cost extra and only run when asked. The research skill uses them only when you request them. See [Billing & credits](/docs/billing).

## Things to ask Claude

- "Research how HTTP/3 differs from HTTP/2 using two or three authoritative sources, with citations."
- "Read https://www.rfc-editor.org/rfc/rfc9114 and summarize how a connection is set up. Save it to my library with the tag http3."
- "What did I save about HTTP/3? Answer only from my library and link the documents."
- "Find recent public posts on X about Cloudflare Workers and summarize the main complaints, with links."

## Privacy, security and support

- What anymd stores and why: [Privacy policy](/legal/privacy).
- anymd reads only the URLs you or Claude request, only public content, and follows robots.txt and site opt-outs: [Site owners & abuse](/legal/abuse).
- Page content is treated as data, not instructions; review what Claude does with it, and keep confirmations on for deletes.
- Help: [hello@digitop.ai](mailto:hello@digitop.ai) or [open an issue](https://github.com/digitopvn/anymd/issues).
