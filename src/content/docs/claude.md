---
title: "Use anymd with Claude"
description: "Connect anymd to Claude on claude.ai, Cowork, Claude Desktop and Claude Code as a connector, or install the AnyMD Research plugin for cited web research and a private library."
updated: "2026-10-28"
---

anymd gives Claude the public web as clean Markdown and a private library of the sources you choose to keep. There are two ways to add it, and they work together:

| | What you get | Where |
|---|---|---|
| **anymd connector** | The anymd tools: read a URL, search your library, open a saved document, tag, search social posts | claude.ai, Cowork, Claude Desktop, Claude Code |
| **AnyMD Research plugin** | The connector plus a `research` skill that tells Claude to recall from your library first, read the sources, answer with citations, and save a source only when you ask | Claude Code and other plugin surfaces |

Both use the same server, `https://anymd.cc/mcp`, and the same sign-in. Keep one anymd entry per client: in Claude Code, if you install the plugin, you don't also need `claude mcp add`.

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
/plugin marketplace add digitopvn/anymd
/plugin install anymd-research@anymd
```

The plugin contains one skill and the server entry. It has no hooks, scripts or local code.

## What Claude can access

Sign-in uses OAuth 2.1 with PKCE. By default the consent screen asks for three permissions:

| Permission | Lets Claude |
|---|---|
| `convert` | Read public URLs (uses your credits) |
| `library:read` | Search and open documents in your own library |
| `library:write` | Save and tag documents in your own library |

With these, Claude sees these tools: `read_url` (and its original name `convert_url`), `search_library`, `get_document`, `list_documents`, `list_tags`, `tag_document`, `search_social` and `get_video_download`. The library tools that only read are marked read-only. Deleting needs a fourth permission, `library:delete` (permanently delete documents in your own library), which is never part of the default: Claude can ask you to reconnect and approve it by name, and only then sees `delete_document`, marked destructive so Claude asks before deleting. Tick **Read-only connection** on the consent screen to keep Claude from saving or changing anything. Your library is private to your account: no other user, connection or key of another account can search it. Revoke the connection any time under **Dashboard → API keys → Connected apps**.

## Credits

Reading a new page costs credits by complexity (a web page is 1); a repeat read within the hour and library search are free. Thread expansion, comments, image and video analysis, video download and social search cost extra. They run when you ask for them, or when you turned them on under **Account → Reading defaults**; the research skill doesn't switch them on by itself. Long pages come back in windows of 40,000 characters; reading the next window within the hour, or from a saved document, is free. See [Billing & credits](/docs/billing).

## Things to ask Claude

- "Research how HTTP/3 differs from HTTP/2 using two or three authoritative sources, with citations."
- "Read https://www.rfc-editor.org/rfc/rfc9114 and summarize how a connection is set up. Save it to my library with the tag http3."
- "What did I save about HTTP/3? Answer only from my library and link the documents."
- "Find recent public posts on X about Cloudflare Workers and summarize the main complaints, with links."

## Privacy, security and support

- What anymd stores and why, and which providers receive what (for example, social search keywords go to the social network data providers): [Privacy policy](/legal/privacy).
- anymd reads only the URLs you or Claude request, only public content, and follows robots.txt and site opt-outs: [Site owners & abuse](/legal/abuse).
- Page content is treated as data, not instructions; review what Claude does with it, and keep confirmations on for deletes.
- Help: [hello@digitop.ai](mailto:hello@digitop.ai) or [open an issue](https://github.com/digitopvn/anymd/issues).
