# Page builder operations (agent workflow)

Operating procedure for an AI agent (or a human scripting the API) that builds and publishes pages on anymd.cc. The op format and block overview are public in `src/content/docs/page-builder.md` (`/docs/page-builder`). Exact block props come from the live catalog, whose source is `src/cms/blocks.ts`. Op validation, concurrency and idempotency are implemented in `src/cms/pages.ts`.

The same service backs every channel, so the procedure is identical whether you use REST (`/api/v1/admin/…`), MCP tools, the CLI (`anymd pages …`) or the editor's WebMCP tools.

## Access

Use a key with the `content-editor` preset, owned by an `editor` (to publish) or an `author` (drafts only; a human editor publishes). Check with `GET /api/v1/me` before starting.

## Loop

1. **Read the catalog.** `list_blocks` / `GET /admin/blocks`. Build props from each block's `propsSchema` and `example`. Don't rely on memory: schemas are versioned and limits (lengths, item counts, allowed sizes) are enforced.
2. **Find or create the page.** `list_pages`, then `get_page` by id or slug. Create with `create_page` only when no page owns the slug. Start from the closest template (`list_page_templates`) and replace every placeholder.
3. **Read before every write.** Take `revision` and the current `draft` from `get_page`. Plan ops against that draft.
4. **Apply one coherent batch.** `apply_page_ops { pageId, baseRevision, ops, idempotencyKey, note }`. Group related changes into one batch (up to 100 ops); the batch is all-or-nothing. Write a short `note`; it shows in the revision history.
5. **Use returned ids.** `createdBlockIds` lists new block ids in op order. Use them for follow-up ops (for example, inserting into a `columns` block's `left`/`right` slots).
6. **Verify.** Open `previewUrl` and fetch the draft Markdown (`GET /admin/pages/:id/markdown`). Check copy, links, order and that the Markdown reads well on its own.
7. **Publish.** `publish_page { pageId }`, or `{ pageId, revision }` to publish a specific reviewed revision. Then fetch `/p/<slug>` and `/p/<slug>.md` to confirm.

Default to stopping at step 6 and handing the preview link to a human unless the task explicitly authorises publishing.

## Handling failures

| Response | Meaning | Do |
|---|---|---|
| `409 revision_conflict` | Someone changed the page after your read | `get_page` again, re-plan against the new draft, send a new batch with the new `baseRevision` and a **new** idempotency key. Never just bump the number and resend the same ops; that can overwrite or duplicate another editor's work. |
| Network error or timeout, response unknown | The batch may or may not have applied | Resend the **identical** request with the **same** idempotency key. If it applied, you get the stored response with `replayed: true`; if not, it applies now. |
| `422 idempotency_mismatch` | Key reused with a different payload | Your retry wasn't identical. Re-read the page to learn what applied, then continue with a new key. |
| `422 invalid_props` | Props fail the schema | Fix the listed `path`s using the catalog schema. Nothing was applied. |
| `422 unknown_block`, `invalid_size`, `invalid_slot`, `invalid_nesting` | Structural mistake | Re-read the catalog; `columns` can't be nested and has only `left`/`right`. |
| `422 too_many_blocks` | Over 80 blocks including slot children | Consolidate content (for example into `rich-text`). |
| `409 slug_taken`, `422 reserved_slug` | Slug unavailable | Pick another slug; reserved first segments are listed in `pages.ts`. |
| `403 forbidden` | Missing scope | Stop and report; don't look for another key. |

## Idempotency keys

- One key per intended batch, 8 to 100 characters, unique per piece of work (for example `<page-slug>-<purpose>-<n>`).
- Keys are scoped to the calling principal. The stored response is replayed only for the exact same `pageId`, `baseRevision` and `ops`.
- Reuse a key only to retry the identical request.

## Content rules

- No invented numbers, testimonials, customer logos or quotes. `stats`, `testimonial` and `logo-cloud` need real, attributable sources.
- Prices come from the `pricing` block (live catalog), never hand-typed.
- `offer` blocks need a real code that exists in Polar and a real end date.
- Every `image` needs meaningful `alt`. Host images on the CDN.
- Set SEO with `set_seo`; use `noindex: true` for pages that shouldn't be indexed.

## Rollback

- Bad publish: `publish_page { pageId, revision: <last good> }`. Find the last good revision with `GET /admin/pages/:id/revisions`.
- Take a page offline: `unpublish_page`. The draft is kept.
- Leaked preview link: rotate with `POST /admin/pages/:id/preview-token`.
