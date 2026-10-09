---
title: "Library & search"
description: "How anymd saves your conversions and searches them with BM25, full-text, semantic and hybrid modes, query fan-out, RRF and Jev."
updated: "2026-10-09"
---

Sign in (or use an API key) and every conversion lands in your private library. Then you can find it again the way you remember it: by exact words, by a phrase, or by the idea.

## What gets saved

- **One document per source URL.** Converting the same URL again refreshes the document instead of duplicating it.
- **Markdown plus metadata:** title, author, domain, site, published date, language, source kind, word count, and your tags.
- **Only yours.** Every query, keyword and semantic, is filtered to your user id. Nobody else's documents can appear in your results.
- **Opt out per call** with `save=0` (URL API), `"save": false` (REST), `--no-save` (CLI) or `save: false` (MCP).

Semantic indexing runs in the background right after a save. A brand-new document is findable by keyword immediately and by meaning a moment later.

The Free plan keeps up to 1,000 documents; paid plans are unlimited. See [Billing & credits](/docs/billing).

## Search modes

| Mode | Best for | How |
|---|---|---|
| `hybrid` (default) | Most queries | `bm25` + `semantic`, fused with Reciprocal Rank Fusion |
| `bm25` | Keywords you remember | SQLite FTS5 BM25 over title, description, body, domain and tags. Title and tag matches weigh most. |
| `fulltext` | Precise queries | Raw FTS5 syntax (see below) |
| `semantic` | Ideas, not words | `bge-m3` embeddings in Cloudflare Vectorize |

Search costs **0 credits** in every mode.

### Full-text syntax

`mode=fulltext` passes your query to SQLite FTS5:

| Syntax | Example |
|---|---|
| Phrase | `"reciprocal rank fusion"` |
| Boolean | `cloudflare AND workers NOT pages` |
| Prefix | `embed*` |
| Column filter | `title:markdown`, `domain:github.com`, `tags:rag` |

If the syntax is invalid, anymd falls back to plain keyword matching instead of failing the request.

## Query fan-out

Add `fanout=1` and a small, fast language model rewrites your query into up to three variants: one with synonyms, one more specific, one more general. anymd runs every variant through the selected mode and fuses all the lists. The variants come back in the response so you can see what was searched.

Fan-out helps most with short or vague queries ("that post about pricing"). It adds a little latency; if the rewrite fails, the search simply runs with your original query.

## Reciprocal Rank Fusion

Hybrid mode and fan-out produce several ranked lists. anymd merges them with Reciprocal Rank Fusion using **k = 60**: each document scores the sum of `1 / (60 + rank)` over every list it appears in. Documents that rank well in several lists rise to the top; no score normalisation between BM25 and vectors is needed.

Each hit's `matched` array tells you which retrievers found it (`bm25`, `fulltext`, `semantic`).

## Jev: breaking near-ties

Sometimes the top two fused results are too close to call. When the gap between #1 and #2 is under 25% of #1's score, anymd can ask **Jev** (TypeSafe System One) which candidate most directly answers the query.

- Jev only sees candidates that were already filtered to your library.
- It only reorders when it is confident (a high top probability with a clear margin over the runner-up). Otherwise the fused order stands.
- Timeouts or errors fall back to the fused order. Search never fails because of Jev.
- Emails and API-key-looking strings are masked in the query before it is sent.

The `jev` field in the response reports what happened: `used`, `choice`, `confidence` and a `reason` such as `decided`, `low_confidence`, `none` or `disabled`.

## Request

```bash
curl -G https://anymd.cc/api/v1/search \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  --data-urlencode "q=why markdown for agents" \
  -d mode=hybrid -d fanout=1 -d limit=10
```

| Param | Default | Notes |
|---|---|---|
| `q` | required | Up to 500 characters are used |
| `mode` | `hybrid` | `hybrid`, `bm25`, `fulltext`, `semantic` |
| `limit` | `10` | 1 to 50 |
| `fanout` | off | `1` to enable query fan-out. Pro and above |
| `decide` | off | `1` lets Jev break near-ties. Pro and above |

On Free, `fanout` and `decide` are skipped and named in the response's `gated` array; results use standard ranking.

Same fields work as a JSON body on `POST /api/v1/search`, via `anymd search` in the [CLI](/docs/cli), and via the `search_library` [MCP tool](/docs/mcp).

## Response

```json
{
  "query": "why markdown for agents",
  "mode": "hybrid",
  "variants": ["markdown benefits for AI agents", "…"],
  "hits": [
    {
      "id": "doc_…",
      "title": "Why Markdown is the language of AI agents",
      "url": "https://…",
      "domain": "anymd.cc",
      "source_kind": "web",
      "snippet": "…models read <mark>markdown</mark> structure…",
      "score": 0.03252,
      "matched": ["bm25", "semantic"],
      "created_at": 1790000000000,
      "word_count": 1480
    }
  ],
  "jev": null,
  "took_ms": 212
}
```

Values are illustrative. Snippets from keyword matches wrap hits in `<mark>` tags; escape or strip them before rendering. `created_at` is a Unix timestamp in milliseconds.

## Tips

- Remember exact words? `bm25`. Remember a phrase? `fulltext` with quotes. Remember the gist? `semantic` or `hybrid`.
- Tag documents to find them again; tags are indexed and weighted highly (see Tags below).
- Browse instead of search with `GET /api/v1/library?domain=github.com`, `?kind=youtube` or `?tag=rag`.

## Tags

Tags are your own labels on library documents. They are lowercased and keep only letters, digits, `-` and `_` (`Machine Learning` becomes `machinelearning`). A document holds at most 20; an edit that would exceed that fails with `too_many_tags` rather than dropping tags.

| Channel | Edit | List tags | Filter by tag |
|---|---|---|---|
| REST | `POST /library/:id/tags` `{ add?, remove? }` or `{ set }`; `PATCH /library/:id` `{ tags }` replaces | `GET /library/tags` | `GET /library?tag=a&tag=b` |
| MCP | `tag_document` | `list_tags` | `list_documents` `{ tags }` |
| WebMCP | `tag_document` | `list_tags` | `list_documents` `{ tags }` |
| CLI | `anymd tag <id> --add a,b --remove c` or `--set a,b` | `anymd tags` | `anymd ls --tag a,b` |
| Dashboard | Tags field on a document | Tag chips on the Library page | Click a tag chip |

Tag filters match whole tags: `ai` never matches `rai` or `ai-safety`. Several tags mean every one must be present. Search modes don't take a tag filter; in `fulltext` mode you can use the FTS5 column filter `tags:rag`. It matches tokens, not whole tags, so `tags:ai` also matches `ai-safety`; prefer the exact tag filter when that matters. Editing tags needs `library:write`; listing and filtering need `library:read`.
