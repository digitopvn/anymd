# anymd

**The web context layer for AI agents.** anymd reads public web content, normalizes it into structured Markdown, remembers what matters in a private searchable library, and makes it available anywhere through MCP, API and CLI.

The fastest way to try it: put `anymd.cc/` in front of a public URL.

```bash
curl https://anymd.cc/stephango.com/saw
```

Connect your agent over MCP:

```bash
claude mcp add --transport http anymd https://anymd.cc/mcp
```

[anymd.cc](https://anymd.cc) · [Docs](https://anymd.cc/docs) · [API reference](https://anymd.cc/docs/api) · [MCP](https://anymd.cc/docs/mcp) · [Pricing](https://anymd.cc/pricing)

## What it does

- **Read.** A source-aware reader extracts the content of a public URL and normalizes it into structured Markdown with YAML metadata. Dedicated readers handle GitHub, YouTube transcripts, Reddit, Hacker News, X posts, PDFs, Office files, spreadsheets and images.
- **Remember.** What your agents read while signed in becomes private, reusable context: BM25, full-text, semantic (bge-m3 on Vectorize) and hybrid search, with query fan-out, Reciprocal Rank Fusion and optional Jev tie-breaking. Recall is free.
- **Use anywhere.** A remote MCP server (`read_url`, `search_library`, `get_document`…) with OAuth 2.1 or API keys, a REST API, a zero-dependency CLI, WebMCP tools in the browser, and the URL prefix: `https://anymd.cc/<url>` returns Markdown, JSON or an HTML preview.

## Responsible by design

- Reads only the URLs a user or their agent requests; no autonomous crawling.
- Public content only; no login, paywall or CAPTCHA bypass.
- Follows robots.txt (`anymd` token or `*`), honours domain opt-outs on every channel, and enforces per-site rate limits.
- Libraries are private to each account. Site owners can opt out or request a takedown: [Site Owners & Abuse](https://anymd.cc/legal/abuse).

## Also included

- **Scoped access.** API keys with presets, capped by role templates.
- **Agent-readable site.** Every page has a `.md` twin, plus `llms.txt`.
- **Admin page builder.** Typed blocks, revisioned ops, previews and publishing over REST, MCP and CLI.
- **Runs on Cloudflare.** One Worker with D1, KV, R2, Vectorize and Workers AI; self-hostable.

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
| [Sources](https://anymd.cc/docs/sources) | Dedicated readers and what's planned |
| [API keys & roles](https://anymd.cc/docs/api-keys-roles) | Scopes, presets, roles |
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
