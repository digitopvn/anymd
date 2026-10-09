# Document tagging tools: implementation report

Date: 2026-10-09 (Asia/Saigon). Branch `feat/library-document-tags` from `origin/main`, PR into `dev`.

## Outcome

Library documents can be tagged, untagged, re-tagged, listed by tag and filtered by tag over MCP, WebMCP, REST, CLI and the dashboard. No migration: the existing `documents.tags` column (space-separated, FTS-indexed) is reused.

## Changes

- `src/library/store.ts`: `normalizeTag(s)`, `applyTagEdit`, `editTags` (read-modify-write guarded by `WHERE tags = ?`, 3 attempts, then `409 tag_conflict`), `addTags`, `removeTags`, `listTags` (recursive CTE split, count desc then tag asc, limit 1..500), `listDocuments({ tags })` with an AND whole-tag match via `instr(' ' || tags || ' ', ' tag ')`, so no LIKE wildcards are involved. `TagError` carries `status` and `code`. An edit past 20 tags throws `422 too_many_tags` and nothing is truncated. `updateTags` (PATCH) keeps its old lenient behavior.
- `src/mcp/server.ts`: `tag_document { id, add?, remove?, set? }` (`library:write`; readOnly false, destructive false, idempotent true), `list_tags { limit? }` (`library:read`), `tags` filter on `list_documents`. Tools are hidden when the caller lacks the scope.
- `src/routes/api.ts`: `GET /library/tags` (registered before `/library/:id`), `POST /library/:id/tags`, and `?tag=` on `GET /library` (repeatable or comma-separated, max 10, max 40 chars). PATCH is unchanged.
- `src/openapi.ts`: new paths plus the `tag` query parameter.
- `client/lib/webmcp.ts`: `tag_document` and `list_tags` (signed in), plus `tags` on `list_documents`.
- Dashboard: tag chips on the library page (top 12, `aria-current` on the active chip, clicking it again clears the filter), tag links on each document row, and a tag-specific empty state.
- CLI 0.1.2: `anymd tag <id> --add/--remove | --set`, `anymd tags`, and `anymd ls --tag a,b`. README and help updated.
- Docs: `api.md`, `mcp.md`, `library-search.md` (new Tags section), `cli.md`, `webmcp.md`. The changelog is generated from GitHub commits, so it needs no manual entry.

## Decisions

- `POST /library/:id/tags` also accepts `{ set }`, which cannot be combined with add/remove. That gives MCP, WebMCP and the CLI one endpoint that returns the resulting tags and rejects overflow, where PATCH would silently truncate.
- `tag_document` has `idempotentHint: true` because repeating the same add, remove or set call gives the same result.
- `search_library` gets no tag filter. Semantic and hybrid hits come from Vectorize plus RRF, so a filter would need post-filtering that shrinks result counts. The docs point to the FTS5 `tags:rag` column filter in `fulltext` mode instead.

## Verification

- `npm run typecheck`: pass.
- `npm test`: 12 files, 139 tests pass. The new `test/library-tags.test.ts` (15 tests) runs against node:sqlite and covers normalization, add/remove/set, the cap error, cross-user isolation, the whole-tag filter (`ai` vs `rai`, literal `_`), MCP visibility by scope and the REST routes. The new `test/library-tags-view.test.tsx` (2 tests) covers the dashboard chips.
- `node --test cli/test/*.test.mjs`: 48 pass, 7 of them new.
- `npm run build`: pass.

No deploy, no remote migration, no CLI publish.

## Unresolved questions

- The root `package.json` version stays at 0.1.1, because only the CLI bump was requested.
