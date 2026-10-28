# AnyMD Research

Source-grounded web research for Claude, powered by [AnyMD](https://anymd.cc). Claude reads public web pages as clean Markdown, answers with inline citations and a sources list, saves a source to your private AnyMD library only when you ask, and finds what you saved before searching the web again.

## What's inside

| Component | What it does |
|---|---|
| `skills/research` | Teaches Claude the research loop: recall from your library, read the sources, answer with citations, save only with your intent. |
| `.mcp.json` | Connects the AnyMD remote MCP server at `https://anymd.cc/mcp` (Streamable HTTP). |

The plugin has no hooks, scripts, commands or local code. It runs nothing on your machine.

## Setup

1. Install the plugin. In Claude Code:

   ```
   /plugin install anymd-research --marketplace digitopvn/anymd
   ```

2. When Claude first uses an AnyMD tool, sign in to AnyMD in the browser window that opens (OAuth 2.1 with PKCE). A free AnyMD account works.
3. Approve the default access on the consent screen: read the web (`convert`) and read and save your own library (`library:read`, `library:write`). The plugin never asks for more.

If you already added the AnyMD connector in Claude, you don't need this plugin's server entry as well; the skill uses whichever AnyMD connection is present.

## Try it

- "Research how HTTP/3 differs from HTTP/2 using two or three authoritative sources, with citations."
- "Read https://www.rfc-editor.org/rfc/rfc9114 and summarize the connection setup. Save it to my library with the tag http3."
- "What did I save about HTTP/3? Answer only from my library."

## What it sends and where

- **To AnyMD (`anymd.cc`) only.** Each tool call sends its arguments, such as the URL to read or your search query, to the AnyMD MCP server under your account. AnyMD fetches the public page and returns Markdown. No other destination is contacted by this plugin.
- **Your library is private.** Saved documents belong to your account; searches only reach your own documents.
- **Credits.** Reading a page uses AnyMD credits from your plan (cached reads and library search are free). Deep options (threads, comments, image or video analysis) and social search cost extra, and the skill uses them only when you ask. See [pricing and credits](https://anymd.cc/docs/billing).
- **Saving is opt-in in this skill.** Claude passes `save: false` unless you ask it to keep a source.

## Tools Claude uses

`read_url`, `search_library`, `get_document`, `list_documents`, `list_tags`, `tag_document`, `search_social`, `get_video_download` and `delete_document` (only when you ask to delete a document). `convert_url` is the same tool as `read_url` under its original name.

## Support, privacy and security

- Docs: [anymd.cc/docs/claude](https://anymd.cc/docs/claude) and [anymd.cc/docs/mcp](https://anymd.cc/docs/mcp)
- Privacy policy: [anymd.cc/legal/privacy](https://anymd.cc/legal/privacy)
- Terms: [anymd.cc/legal/terms](https://anymd.cc/legal/terms)
- Support and security reports: hello@digitop.ai, or [open an issue](https://github.com/digitopvn/anymd/issues)

## License

MIT. See [LICENSE](./LICENSE).
