# AnyMD Research

Source-grounded web research for Claude, powered by [AnyMD](https://anymd.cc). Its research skill has Claude read public web pages as clean Markdown, answer with inline citations and a sources list, save a source to your private AnyMD library when you ask, and look in what you saved before searching the web again.

## What's inside

| Component | What it does |
|---|---|
| `skills/research` | Teaches Claude the research loop: recall from your library, read the sources, answer with citations, save only with your intent. |
| `.mcp.json` | Connects the AnyMD remote MCP server at `https://anymd.cc/mcp` (Streamable HTTP). |

The plugin has no hooks, scripts, commands or local code. It runs nothing on your machine.

## Setup

1. Install the plugin. In Claude Code:

   ```
   /plugin marketplace add digitopvn/anymd
   /plugin install anymd-research@anymd
   ```

2. When Claude first uses an AnyMD tool, sign in to AnyMD in the browser window that opens (OAuth 2.1 with PKCE). A free AnyMD account works.
3. Approve the default access on the consent screen: read the web (`convert`) and read and save your own library (`library:read`, `library:write`). Deleting a document needs one more permission, `library:delete`, which you approve by name only if you ask Claude to delete something.

If you already added the AnyMD connector in Claude, you don't need this plugin's server entry as well; the skill uses whichever AnyMD connection is present.

## Try it

- "Research how HTTP/3 differs from HTTP/2 using two or three authoritative sources, with citations."
- "Read https://www.rfc-editor.org/rfc/rfc9114 and summarize the connection setup. Save it to my library with the tag http3."
- "What did I save about HTTP/3? Answer only from my library."

## What it sends and where

- **To AnyMD (`anymd.cc`) only.** Each tool call sends its arguments, such as the URL to read or your search query, to the AnyMD MCP server under your account. The plugin itself contacts nothing else. AnyMD fetches the public page and returns Markdown; for some sources it uses third-party providers, for example social network data providers receive your keywords when you use `search_social`. The [privacy policy](https://anymd.cc/legal/privacy) lists each provider and what it receives.
- **Your library is private.** Saved documents belong to your account; searches only reach your own documents.
- **Credits.** Reading a page uses AnyMD credits from your plan; a repeat read within the hour and library search are free. Deep options (threads, comments, image or video analysis, video download) and social search cost extra. The skill doesn't switch them on unless you ask, but options you turned on under **Account → Reading defaults** on anymd.cc apply to every read. See [pricing and credits](https://anymd.cc/docs/billing).
- **Saving follows your request.** The skill tells Claude to pass `save: false` unless you ask it to keep a source. Without the skill, AnyMD's `read_url` saves by default.

## Tools Claude uses

`read_url`, `search_library`, `get_document`, `list_documents`, `list_tags`, `tag_document`, `search_social`, `get_video_download`, and `delete_document` once the connection holds `library:delete` (only when you ask to delete a document). `convert_url` is the same tool as `read_url` under its original name.

## Support, privacy and security

- Docs: [anymd.cc/docs/claude](https://anymd.cc/docs/claude) and [anymd.cc/docs/mcp](https://anymd.cc/docs/mcp)
- Privacy policy: [anymd.cc/legal/privacy](https://anymd.cc/legal/privacy)
- Terms: [anymd.cc/legal/terms](https://anymd.cc/legal/terms)
- Support and security reports: hello@digitop.ai, or [open an issue](https://github.com/digitopvn/anymd/issues)

## License

MIT. See [LICENSE](./LICENSE).
