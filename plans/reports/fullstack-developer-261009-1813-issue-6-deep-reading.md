# Issue #6: deep reading becomes explicit opt-in, with saved preferences

Branch: `feat/deep-reading-preferences` (from origin/main, PR targets `dev`). Status: done.

## Outcome
- Every enrichment that costs credits (expandThread, includeComments, analyzeImages) is now off by default. Being authenticated no longer turns any of them on.
- Precedence, applied the same way on every surface: explicit request option > the account's saved preference > safe default. This is resolved in a single place, `resolveReadingOptions` (`src/convert/reading-preferences.ts`), which runs inside `runConversion`.
- New options: `expandThread` and `maxThreadPosts` (1..100, default 20). The thread walk and its search are both bounded, and hitting the bound is reported with reason `thread_limit`.
- `keepImages` is equivalent to `images=0|1` / `removeImages`. If a request explicitly sends conflicting values, it gets a 400 `invalid_options`.
- Anonymous callers that request an enrichment get a 401. Previously the request went through without enrichment and nothing told the caller.
- Cache key bumped from v3 to v4, so results expanded under the old automatic behaviour are not reused.

## Persistence
- `migrations/0006_reading_preferences.sql`: table `reading_preferences(user_id PK FK users ON DELETE CASCADE, preferences JSON CHECK json_valid, updated_at)`. Not applied remotely.
- REST endpoints `GET/PUT/DELETE /api/v1/account/reading-preferences`. They require an account plus the `convert` scope. PUT accepts a partial strict patch and answers 422 `invalid_preferences` with details. Responses are `no-store`.
- Dashboard: the `/dashboard/account#reading-defaults` section is a plain form POST that supports Save and Reset. The converter panel prefills from the saved preferences, sends only the fields the user changed, and never writes back to the saved preferences.

## Surfaces and contracts
- The new options are wired through the web converter, URL API (`expandThread`, `maxThreadPosts`, `images`), REST, OpenAPI, CLI (flags plus `anymd prefs show|set|reset`), MCP `read_url` and WebMCP.
- Usage and traces: `usage_events` meta now records `credit_breakdown` and `reading_options` with a source per field. The trace detail view has a "Credits" card, and the convert response includes `reading_options`.
- Docs updated: `src/content/docs/{api,url,mcp,webmcp,cli,sources,billing}.md`, `cli/README.md` and `docs/architecture.md`, including a note on the behaviour change.

## Tests
- `npm run typecheck`: clean.
- `npm test`: 12 files, 174 tests passed. New suites are `test/reading-preferences.test.ts` (precedence matrix, end-to-end runConversion over SQLite) and `test/reading-preferences-routes.test.tsx` (REST, OpenAPI, UI rendering).
- `node --test cli/test/*.test.mjs`: 47/47.
- `npm run build`: OK.

## Notes
- The changelog is generated from commits (`src/lib/changelog.ts`), so there is no manual entry.
- Without JS, the home/dashboard converter cannot turn off a saved enrichment for a single run, because an unchecked box is simply not submitted. With JS this works through dirty tracking. API, CLI and MCP can always send `false`.
- `deleteAccount` does not list `reading_preferences` explicitly. The rows are removed by the foreign-key cascade, the same way `conversion_charges` is handled, which keeps the code safe if it runs before the migration.

## Unresolved questions
- Should PUT/DELETE on preferences require a dedicated scope (for example `account:write`) rather than `convert`?
- Migration 0006 has to be applied remotely before deploy. That needs the user's permission.
