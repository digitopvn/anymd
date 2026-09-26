---
title: "CLI"
description: "The anymd command: convert URLs and files, search your library, manage pages and print MCP config from your terminal."
updated: "2026-09-26"
---

`anymd` is a zero-dependency command-line client. It needs Node.js 18 or newer and nothing else.

## Install

```bash
npm i -g https://cdn.anymd.cc/cli/anymd-cli-latest.tgz
```

Or run it once without installing:

```bash
npx https://cdn.anymd.cc/cli/anymd-cli-latest.tgz https://stephango.com/saw
```

## Sign in

```bash
anymd login --key amd_…   # or just `anymd login` and paste when asked
anymd whoami              # who am I, which plan, which scopes
anymd logout
```

`anymd login` stores the key in `~/.config/anymd/config.json`. Environment variables take care of CI and containers:

| Variable | Purpose |
|---|---|
| `ANYMD_API_KEY` | API key (`amd_…`) |
| `ANYMD_BASE_URL` | Point at another deployment, e.g. `https://staging.anymd.cc` or your [self-hosted](/docs/self-host) copy |

Without a key the CLI works anonymously, with the same 50-per-day limit as the [URL API](/docs/url).

## Commands

| Command | What it does |
|---|---|
| `anymd <url>` | Convert and print Markdown |
| `anymd convert <url> [--json] [-o file] [--no-save] [--fresh]` | Convert with options |
| `anymd file <path>` | Convert a local file (PDF, DOCX, XLSX, CSV, images…) |
| `anymd search <query> [--mode hybrid] [--limit 10] [--json]` | Search your library |
| `anymd ls [--limit 20] [--domain x]` | List library documents |
| `anymd get <id>` | Print a saved document |
| `anymd rm <id>` | Delete a saved document |
| `anymd usage` | Credits used and remaining |
| `anymd login [--key amd_…]` · `anymd logout` · `anymd whoami` | Manage credentials |
| `anymd pages ls` · `get <id>` · `create --slug --title [--template]` · `ops <id> --file ops.json` · `publish <id>` · `blocks` | Page builder |
| `anymd mcp` | Print MCP config snippets for your clients |

## Recipes

Save an article as a file:

```bash
anymd convert https://stephango.com/saw -o saw.md
```

Pipe into another tool (Markdown goes to stdout):

```bash
anymd https://news.ycombinator.com/item?id=1 | llm "summarise the discussion"
```

Get JSON for scripting:

```bash
anymd convert https://stephango.com/saw --json | jq '.'
```

Convert without touching your library, bypassing the cache:

```bash
anymd convert https://example.com --no-save --fresh
```

Convert a local PDF:

```bash
anymd file ./quarterly-report.pdf > report.md
```

Search with a specific mode:

```bash
anymd search '"vector database" NOT pinecone' --mode fulltext --limit 5
anymd search "notes about pricing experiments" --json
```

## Page builder from the terminal

```bash
anymd pages blocks                                   # block catalog
anymd pages create --slug launch --title "Launch" --template product-launch
anymd pages get launch                               # note the revision
anymd pages ops launch --file ops.json               # apply a batch of ops
anymd pages publish launch
```

`ops.json` is the same body as [`POST /admin/pages/:id/ops`](/docs/page-builder):

```json
{
  "baseRevision": 1,
  "ops": [
    { "op": "set_meta", "title": "Launch week" },
    { "op": "insert", "block": { "type": "faq", "props": { "items": [{ "q": "Is it free?", "a": "Yes, 500 credits every month." }] } } }
  ]
}
```

If someone edited the page since you read it, the command fails with `revision_conflict`. Run `anymd pages get` again and retry with the new revision.

## Hook it up to your agent

```bash
anymd mcp
```

prints ready-to-paste config for Claude Code, Claude Desktop, Cursor and generic MCP clients. See [MCP server](/docs/mcp).
