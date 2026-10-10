---
title: "CLI"
description: "The anymd command: convert URLs and files, search your library, manage pages and print MCP config from your terminal."
updated: "2026-10-10"
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
| `anymd convert <url> [--json] [-o file] [--no-save] [--fresh] [enrichment flags]` | Convert with options |
| `anymd file <path>` | Convert a local file (PDF, DOCX, XLSX, CSV, images…) |
| `anymd search <query> [--mode hybrid] [--limit 10] [--json]` | Search your library |
| `anymd social <x\|facebook\|instagram\|threads\|linkedin> <query> [--cursor c] [--json]` | Search public social posts (10 credits per page with results; see [Social search](/docs/social-search)) |
| `anymd ls [--limit 20] [--domain x] [--tag a,b]` | List library documents (`--tag`: every tag must match) |
| `anymd get <id>` | Print a saved document |
| `anymd rm <id>` | Delete a saved document |
| `anymd tag <id> [--add a,b] [--remove c]` · `--set a,b` | Edit a document's tags and print the result (`--set ""` clears) |
| `anymd tags [--limit 100]` | List your tags with document counts |
| `anymd usage` | Credits used and remaining |
| `anymd login [--key amd_…]` · `anymd logout` · `anymd whoami` | Manage credentials |
| `anymd pages ls` · `get <id>` · `create --slug --title [--template]` · `ops <id> --file ops.json` · `publish <id>` · `blocks` | Page builder |
| `anymd mcp` | Print MCP config snippets for your clients |
| `anymd prefs [show]` / `set <field>=<value>…` / `reset` | Show, change or reset your saved deep reading defaults |

## Recipes

Tag a saved document, then list everything with that tag:

```bash
anymd tag doc_… --add rag,research --remove todo
anymd ls --tag rag
```

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

Signed-in conversions also accept `--expand-thread`, `--max-thread-posts <1..100>`, `--include-comments`, `--analyze-images`, `--max-comments <1..1000>`, `--max-images <1..20>` and `--max-credits <1..1000>`, plus `--no-expand-thread`, `--no-include-comments` and `--no-analyze-images` to switch a saved default off for one conversion, and `--keep-images` / `--no-images` for image/media URLs (no credit effect). Flags you leave out follow your saved defaults, otherwise thread expansion, comments and image analysis are off; `maxCredits` defaults to 100. X posts convert as the single requested post unless you opt in; a key alone never expands threads. Social post adapters require a key. JSON output includes the `credit_breakdown` and `enrichment` coverage fields, so provider failures or request limits remain visible.

For example:

```bash
anymd convert https://x.com/example/status/123 --expand-thread --max-thread-posts 10 --include-comments --max-comments 40 --max-credits 200 --json
```

Save defaults once, then override per conversion:

```bash
anymd prefs set expandThread=on maxThreadPosts=30
anymd convert https://x.com/example/status/123 --no-expand-thread   # this conversion only
anymd prefs reset                                                    # deep reading off again
```

`anymd prefs` works with any key that has `convert`. `prefs set` and `prefs reset` change what every key and client of your account may spend, so they need a key with the `keys:manage` scope (the **Everything my role allows** preset); a **Convert only** key gets `forbidden`.

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

`ops.json` is the same body as `POST /admin/pages/:id/ops`:

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
