# anymd CLI

Convert any URL or file to clean Markdown with [anymd.cc](https://anymd.cc), search your
Markdown library, and manage pages from the terminal. Zero dependencies; Node.js 18 or newer.

## Install

```sh
npm i -g https://cdn.anymd.cc/cli/anymd-cli-latest.tgz
# or run once without installing
npx https://cdn.anymd.cc/cli/anymd-cli-latest.tgz https://example.com
```

## Quick start

```sh
anymd example.com/blog/post          # Markdown to stdout (no key needed, 50/day per IP)
anymd convert https://example.com --json -o page.json
anymd login                          # paste an API key from Dashboard → API keys
anymd file report.pdf -o report.md   # PDF, DOCX, XLSX, CSV, images… (max 20 MB, key required)
anymd search "vector databases" --mode hybrid --limit 10
```

## Commands

| Command | What it does |
|---|---|
| `anymd <url>` | Same as `anymd convert <url>`. Bare domains get `https://`. |
| `anymd convert <url> [--json] [-o file] [--no-save] [--fresh]` | Without a key: the public URL API (`GET /<url>`). With a key: `POST /api/v1/convert`, saved to your library unless `--no-save`. |
| `anymd file <path> [--json] [-o file]` | Upload a local file to `POST /api/v1/convert/file`. |
| `anymd search <query> [--mode hybrid\|bm25\|fulltext\|semantic] [--limit 10] [--json]` | Ranked list: score, title, URL, snippet. |
| `anymd ls [--limit 20] [--domain x]` | Table of library documents. |
| `anymd get <id> [-o file]` | A library document as Markdown (`--json` for the record). |
| `anymd rm <id>` | Delete a library document. |
| `anymd usage` | Plan, quota and usage totals. |
| `anymd login [--key amd_…]` | Validate a key with `GET /api/v1/me` and save it. |
| `anymd logout` | Remove the saved key. |
| `anymd whoami` | Account, role, plan, scopes and the (masked) key in use. |
| `anymd pages ls` | Pages table. |
| `anymd pages get <id>` | Page details (`--json` for the full draft). |
| `anymd pages create --slug <s> --title <t> [--template <t>]` | Create a page (templates: blank, ads-landing, seo-article, product-launch). |
| `anymd pages ops <id> --file ops.json` | Apply page ops. The file holds `{"baseRevision": n, "ops": [...]}` or a bare ops array; without `baseRevision` the current revision is fetched first. |
| `anymd pages publish <id>` | Publish the page to `/p/<slug>`. |
| `anymd pages blocks` | Block catalog (types, sizes, slots). |
| `anymd mcp` | Print MCP config snippets for Claude Code, Cursor and Claude Desktop. |

`--json` prints the raw API response for every read command. `-o, --output <file>` writes
the result to a file and prints a one-line summary (bytes, credits, cache) on stderr.

## Configuration

Precedence, highest first:

1. Flags: `--key amd_…`, `--base https://staging.anymd.cc`
2. Environment: `ANYMD_API_KEY`, `ANYMD_BASE_URL`
3. Config file written by `anymd login` (`{"api_key": "…", "base_url": "…"}`, mode `0600`):
   - `$XDG_CONFIG_HOME/anymd/config.json` when `XDG_CONFIG_HOME` is set
   - `%APPDATA%\anymd\config.json` on Windows
   - `~/.config/anymd/config.json` elsewhere

The default base URL is `https://anymd.cc`. The CLI never prints a full API key; keys are
shown as `amd_xxxx…last4`.

## Errors and exit codes

Failures print `error_code: message` (from the API's `{"error": {...}}` body) to stderr and
exit with code 1. When the anonymous daily limit is hit (`anonymous_limit`), run `anymd login`
to convert with your plan's credits. Colors are used only when stdout is a TTY and `NO_COLOR`
is unset.

## MCP

```sh
claude mcp add --transport http anymd https://anymd.cc/mcp --header "Authorization: Bearer <key>"
```

Run `anymd mcp` for Cursor and Claude Desktop JSON. Clients that support OAuth can connect
to `https://anymd.cc/mcp` without a key.

## Development

```sh
node --test          # from this directory; unit tests use a mocked fetch (no network)
```

## License

MIT
