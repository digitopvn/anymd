# anymd

**Convert anything on the internet to clean Markdown.** Put `anymd.cc/` in front of any URL and get LLM-ready Markdown back.

```bash
curl https://anymd.cc/stephango.com/saw
```

[anymd.cc](https://anymd.cc) · [Docs](https://anymd.cc/docs) · [API reference](https://anymd.cc/docs/api) · [MCP](https://anymd.cc/docs/mcp) · [Pricing](https://anymd.cc/pricing)

## Features

- **The URL is the API.** `https://anymd.cc/<url>` returns Markdown with YAML frontmatter; JSON or an HTML preview on request. No key needed for light use.
- **Source-aware converters.** Web pages, X/Twitter posts and Articles, YouTube transcripts, GitHub, Reddit, Hacker News threads, PDFs, Office files, spreadsheets and images.
- **A searchable library.** Signed-in conversions are saved and searchable with BM25, full-text, semantic (bge-m3 on Vectorize) or hybrid search, with query fan-out, Reciprocal Rank Fusion and Jev tie-breaking.
- **Every interface.** REST API, zero-dependency CLI, a remote MCP server with OAuth 2.1 or API keys, and WebMCP tools in the browser.
- **Scoped access.** API keys with presets, capped by role templates.
- **Agent-readable site.** Every page has a `.md` twin, plus `llms.txt`.
- **AI-operable page builder.** Typed blocks, revisioned ops, previews and publishing over REST, MCP and CLI.
- **Runs on Cloudflare.** One Worker with D1, KV, R2, Vectorize and Workers AI.

## Quick usage

```bash
# Markdown
curl https://anymd.cc/stephango.com/saw

# JSON
curl -H "Accept: application/json" https://anymd.cc/stephango.com/saw

# With an API key: counted against your credits and saved to your library
curl https://anymd.cc/api/v1/convert \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://stephango.com/saw"}'
```

CLI:

```bash
npm i -g https://cdn.anymd.cc/cli/anymd-cli-latest.tgz
anymd https://stephango.com/saw
```

Claude Code:

```bash
claude mcp add --transport http anymd https://anymd.cc/mcp --header "Authorization: Bearer amd_…"
```

## Documentation

| | |
|---|---|
| [Quickstart](https://anymd.cc/docs/quickstart) | First conversion to agent integration in five minutes |
| [URL API](https://anymd.cc/docs/url) | Formats, options, headers, limits |
| [REST API](https://anymd.cc/docs/api) | Every endpoint, with curl, JavaScript and Python |
| [CLI](https://anymd.cc/docs/cli) | The `anymd` command |
| [MCP](https://anymd.cc/docs/mcp) · [WebMCP](https://anymd.cc/docs/webmcp) | Agent integrations |
| [Library & search](https://anymd.cc/docs/library-search) | Search modes, fan-out, RRF, Jev |
| [Sources](https://anymd.cc/docs/sources) | What converts and what's planned |
| [API keys & roles](https://anymd.cc/docs/api-keys-roles) | Scopes, presets, roles |
| [Page builder](https://anymd.cc/docs/page-builder) | Blocks, ops, revisions |
| [Billing](https://anymd.cc/docs/billing) | Credits and plans |
| [Self-hosting](https://anymd.cc/docs/self-host) | Run your own copy |

The docs source is in [`src/content/docs/`](src/content/docs). Maintainer docs: [`docs/`](docs). AI coding agents: [`AGENTS.md`](AGENTS.md). Reviewers: [`REVIEW.md`](REVIEW.md).

## Self-hosting

anymd deploys as a single Cloudflare Worker:

1. Create a D1 database, two KV namespaces (`OAUTH_KV`, `CACHE`), an R2 bucket, and a 1024-dimension Vectorize index with `user_id` and `doc_id` metadata indexes.
2. Point `wrangler.jsonc` at your account, resources and hostnames.
3. Apply `migrations/` with `wrangler d1 migrations apply`.
4. Set the optional secrets you need (names in `src/env.ts`).
5. `npm install && npm run deploy:production`.

Full guide: [Self-hosting](https://anymd.cc/docs/self-host). Upstream CI deploys `dev` to staging.anymd.cc and `main` to anymd.cc.

## Development

```bash
npm install
npm run dev        # build + wrangler dev (staging config)
npm run typecheck
npm test
```

## Contributing

Issues and pull requests are welcome. If a page converts badly, open an issue with the URL. Read [`AGENTS.md`](AGENTS.md) for layout and conventions, and [`REVIEW.md`](REVIEW.md) for what reviews check.

## License

[MIT](LICENSE). Copyright (c) 2026 Digitop.ai.

Built by [Digitop.ai](https://digitop.ai). Contact: [hello@digitop.ai](mailto:hello@digitop.ai).
