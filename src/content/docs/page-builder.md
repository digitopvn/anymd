---
title: "Page builder"
description: "Build and publish landing pages from typed blocks through REST, MCP, CLI or WebMCP, with revisions, previews and safe concurrent edits for AI agents."
updated: "2026-09-26"
---

anymd ships a small, agent-first page builder. Pages are JSON documents made of typed **blocks**. You change them with batches of **ops**, each batch checked against the revision you last read. Humans use the dashboard editor; agents use exactly the same operations over REST, [MCP](/docs/mcp), the [CLI](/docs/cli) or [WebMCP](/docs/webmcp).

Every page gets a Markdown twin, so what you build is readable by agents and search engines alike.

## Who can do what

| Action | Scope | Roles |
|---|---|---|
| Read catalog, templates, pages, drafts | `pages:read` | viewer and up |
| Create, edit, archive, rotate preview link | `pages:write` | author and up |
| Publish, unpublish | `pages:publish` | editor and up |

For an automation key, use the `content-editor` preset. See [API keys & roles](/docs/api-keys-roles).

## The safe editing loop

1. **Read the catalog.** `GET /api/v1/admin/blocks` (MCP `list_blocks`) returns every block type with its JSON Schema, allowed sizes, slots and an example. It is the source of truth; read it instead of guessing props.
2. **Create a page.** `POST /api/v1/admin/pages` with `{ slug, title, description?, template?, layout? }`. The page starts at revision 1 as a draft.
3. **Apply ops.** `POST /api/v1/admin/pages/:id/ops` with `{ baseRevision, ops[], idempotencyKey?, note? }`. Each successful batch bumps the revision by one.
4. **Preview.** `GET /api/v1/admin/pages/:id` returns a `previewUrl` (`/p/<slug>?preview=<token>`) that renders the draft. Share it for review.
5. **Publish.** `POST /api/v1/admin/pages/:id/publish` with an optional `{ revision }`. The page goes live at `/p/<slug>` and `/p/<slug>.md`.

```bash
KEY="Authorization: Bearer $ANYMD_API_KEY"
API=https://anymd.cc/api/v1/admin

curl -s $API/blocks -H "$KEY" > blocks.json

curl -s $API/pages -H "$KEY" -H "Content-Type: application/json" \
  -d '{"slug":"research","title":"anymd for researchers","template":"seo-article"}'
# → { "id": "pg_…", "revision": 1, "previewUrl": "https://anymd.cc/p/research?preview=…", … }

curl -s $API/pages/pg_…/ops -H "$KEY" -H "Content-Type: application/json" -d @ops.json
# → { "pageId": "pg_…", "revision": 2, "createdBlockIds": ["b_…"], "slug": "research", "replayed": false }

curl -s -X POST $API/pages/pg_…/publish -H "$KEY" -H "Content-Type: application/json" -d '{}'
```

## Ops

A batch holds 1 to 100 ops, applied in order. If any op fails validation, **nothing** is applied and the revision doesn't change.

| Op | Fields | Effect |
|---|---|---|
| `insert` | `block: { type, props?, size? }`, `index?`, `parentId?`, `slot?` | Add a block (at the end if no `index`). Use `parentId` + `slot` to insert into a `columns` block. |
| `update` | `id`, `props?`, `size?` | Merge `props` into the block's props, and/or change its size |
| `replace_props` | `id`, `props` | Replace the block's props entirely |
| `move` | `id`, `index`, `parentId?`, `slot?` | Move a block, optionally into or out of a slot |
| `remove` | `id` | Delete a block (and its children) |
| `duplicate` | `id` | Copy a block right after itself, with fresh ids |
| `set_seo` | `seo: { title?, description?, image?, noindex? }` | Merge SEO fields |
| `set_layout` | `layout`: `default` \| `landing` \| `article` | Change the page layout |
| `set_meta` | `title?`, `description?`, `slug?` | Change page title, description or slug |

`id` is the block id from `get_page` or from `createdBlockIds` in an earlier ops response.

### Example batch

```json
{
  "baseRevision": 1,
  "idempotencyKey": "research-page-hero-v1",
  "note": "Hero, columns and SEO",
  "ops": [
    {
      "op": "insert",
      "index": 0,
      "block": {
        "type": "hero",
        "size": "large",
        "props": {
          "eyebrow": "For researchers",
          "title": "Turn any paper into Markdown",
          "subtitle": "PDFs, arXiv pages and blogs, clean for your notes and agents.",
          "primary": { "label": "Start free", "href": "/signup" },
          "showConverter": true
        }
      }
    },
    { "op": "insert", "block": { "type": "columns", "props": { "ratio": "2-1" } } },
    {
      "op": "set_seo",
      "seo": { "title": "Convert research papers to Markdown", "description": "Clean Markdown from PDFs and paper pages." }
    }
  ]
}
```

To fill the columns, take its id from `createdBlockIds` and send another batch against the new revision:

```json
{
  "baseRevision": 2,
  "ops": [
    { "op": "insert", "parentId": "b_…", "slot": "left", "block": { "type": "rich-text", "props": { "markdown": "## Why Markdown\n\nModels read structure." } } },
    { "op": "insert", "parentId": "b_…", "slot": "right", "block": { "type": "image", "props": { "src": "https://anymd.cc/og/share.jpg", "alt": "anymd social card" } } }
  ]
}
```

## Revisions and conflicts

Every batch must name the `baseRevision` it was built from. If someone else changed the page first, you get:

```json
{ "error": { "code": "revision_conflict", "message": "Revision conflict: page is at revision 5, you sent baseRevision 4. Re-read the page and retry." } }
```

with HTTP `409`. Re-read the page, re-plan your ops against the current draft, and retry. Never blindly resend with a bumped number: the other editor's changes are in the draft now.

`GET /api/v1/admin/pages/:id/revisions` lists recent revisions with author and note. `publish` accepts an older `revision` to roll the live page back to it.

## Idempotency

Networks drop responses. Send an `idempotencyKey` (8 to 100 characters) with each batch:

- Same key, same payload: you get the original response back with `"replayed": true`. Nothing is applied twice.
- Same key, different payload: `422 idempotency_mismatch`. Use a new key for new work.

Keys are scoped to the calling principal.

## Blocks

Always read the live catalog for exact props. This table is the overview.

| Type | What it is | Sizes |
|---|---|---|
| `hero` | Headline, subtitle, up to two CTAs, optional live converter | small, medium, large |
| `rich-text` | Free-form Markdown | small, medium, large |
| `feature-grid` | Icon + title + body cards in 2 to 4 columns | small, medium, large |
| `steps` | Numbered how-it-works steps | small, medium, large |
| `stats` | Row of big numbers with labels | small, medium, large |
| `logo-cloud` | Row of logos | small, medium, large |
| `code-tabs` | Tabbed code samples | small, medium, large |
| `pricing` | Live plan cards from the billing catalog | medium, large |
| `faq` | Questions and answers, with FAQPage structured data | small, medium, large |
| `testimonial` | One quote with attribution. **Real, attributable quotes only.** | small, medium, large |
| `cta` | Closing banner with buttons | small, medium, large |
| `offer` | Discount banner with a countdown to a real end date | small, medium |
| `image` | Image with alt text and optional caption | small, medium, large |
| `comparison` | Feature comparison table | medium, large |
| `converter` | The working URL-to-Markdown converter | medium, large |
| `ecosystem` | Digitop ecosystem product grid | medium, large |
| `founder` | Founder card | medium, large |
| `columns` | Two-column layout with `left` and `right` slots | small, medium, large |

`columns` can't be nested inside another block. A page holds at most 80 blocks, counting blocks inside slots.

## Templates

`GET /api/v1/admin/templates` (MCP `list_page_templates`):

| Template | Use it for |
|---|---|
| `blank` | Start from nothing |
| `ads-landing` | Paid campaigns: offer, hero with converter, features, pricing, FAQ, CTA |
| `seo-article` | Long-form page targeting a search query |
| `product-launch` | Announcements: hero, stats, steps, code, CTA |

Templates are starting points. Edit every placeholder before publishing.

## Slugs, preview and publishing

- Slugs are normalised to lowercase `a-z0-9-` segments. Reserved first segments (such as `api`, `docs`, `blog`, `pricing`, `p`) are refused with `422 reserved_slug`; duplicates get `409 slug_taken`.
- Published pages live at `/p/<slug>`; their Markdown twin at `/p/<slug>.md`. `GET /api/v1/admin/pages/:id/markdown` returns the draft's Markdown.
- `POST /admin/pages/:id/preview-token` rotates the preview token, invalidating old preview links.
- `unpublish` takes the page offline and keeps the draft. `DELETE /admin/pages/:id` archives it and frees the slug.

## Validation errors

| Code | Meaning |
|---|---|
| `unknown_block` | `type` isn't in the catalog |
| `invalid_props` | Props fail the block's schema; the error lists each `path` and `message` |
| `invalid_size` | Size not allowed for that block |
| `not_found` | Block, parent, page or revision doesn't exist |
| `no_slots`, `invalid_slot` | Parent has no slots, or not that slot |
| `invalid_nesting`, `invalid_move` | Nested `columns`, or a block moved into itself |
| `too_many_blocks` | Over the 80-block limit |
| `invalid_slug`, `reserved_slug`, `slug_taken` | Slug problems |

## Content rules

- Use real numbers and real quotes only. The `stats` and `testimonial` blocks are not for invented social proof.
- Offers need real codes and real end dates.
- Give every image meaningful `alt` text.
