---
title: "Quickstart"
description: "Convert your first URL, create an API key, search your library and plug anymd into your agent in five minutes."
updated: "2026-09-26"
---

Five minutes, five steps. Step 1 needs nothing but a terminal or a browser.

## 1. Convert a URL (no account)

Prefix any link with `anymd.cc/`:

```bash
curl https://anymd.cc/stephango.com/saw
```

Or paste `https://anymd.cc/stephango.com/saw` into your browser. You get Markdown with YAML frontmatter (title, author, source, kind, word count…) followed by the clean content.

Want JSON or an HTML preview instead?

```bash
curl -H "Accept: application/json" https://anymd.cc/stephango.com/saw
curl "https://anymd.cc/stephango.com/saw?format=html"
```

Anonymous use is capped at 50 conversions a day per IP. Details: [URL API](/docs/url).

## 2. Create an account and an API key

1. [Sign up](/signup). The Free plan includes 500 credits a month.
2. Open **Dashboard → API keys** and create a key. Pick the **Convert + library (agents)** preset if you're not sure.
3. Copy the key. It starts with `amd_` and is shown **once**.

```bash
export ANYMD_API_KEY="amd_…"
```

Keep it out of source control. Learn what presets and scopes do in [API keys & roles](/docs/api-keys-roles).

## 3. Convert with your key

With a key, conversions count against your plan's credits and land in your library.

```bash
curl https://anymd.cc/api/v1/convert \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://stephango.com/saw"}'
```

The same key works on the URL API too:

```bash
curl -H "Authorization: Bearer $ANYMD_API_KEY" https://anymd.cc/stephango.com/saw
```

Check the `X-Anymd-Credits` and `X-Anymd-Cache` response headers to see what a call cost.

## 4. Search your library

```bash
curl -G https://anymd.cc/api/v1/search \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  --data-urlencode "q=saying yes to things" \
  -d mode=hybrid -d limit=5
```

Hybrid mode fuses keyword (BM25) and semantic results. Search costs 0 credits. More in [Library & search](/docs/library-search).

## 5. Give your agent anymd

**Claude Code:**

```bash
claude mcp add --transport http anymd https://anymd.cc/mcp \
  --header "Authorization: Bearer $ANYMD_API_KEY"
```

**Cursor** (`.cursor/mcp.json`) and other clients that accept a remote URL:

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

Now ask your agent to "convert this URL and summarise it" or "search my library for…". Claude Desktop setup and the tool list are in [MCP server](/docs/mcp).

## Prefer the terminal?

```bash
npm i -g https://cdn.anymd.cc/cli/anymd-cli-latest.tgz
anymd login --key "$ANYMD_API_KEY"
anymd https://stephango.com/saw
```

Full command list: [CLI](/docs/cli).

## Next steps

- [REST API](/docs/api) for every endpoint, with curl, JavaScript and Python examples.
- [Supported sources](/docs/sources) for what X, YouTube, Hacker News and file conversion return.
- [Billing & credits](/docs/billing) to see what each source costs.
