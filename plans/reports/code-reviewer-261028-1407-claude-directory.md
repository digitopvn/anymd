# Code review: 24922b8 feat(claude-directory)

## Scope
- Commit 24922b8 (branch claude/affectionate-goodall-lood5f). 19 files, +478/-21. Note: two later commits (9094da7, 72ba090) landed on the branch during review; they are out of scope except where noted.
- Checks run: `npx vitest run test/mcp-directory-readiness.test.ts test/admin-operations-tooling.test.ts test/mcp-admin-authorization.test.ts` -> 38/38 pass. Full `npx vitest run` (at 72ba090) -> 512/512 pass. `tsc --noEmit` clean. `claude plugin validate ./plugins/anymd-research` -> passed, no directory findings. `claude plugin validate .` -> passed.

## Verdict
Nothing blocking in the code. The authorization change is correct for every principal kind and call path. The real risks are claims in the plugin and docs that don't match server behaviour, plus a privacy-policy gap the directory review is likely to catch.

## Authorization verification (no defects)
- `tools/call` (src/mcp/server.ts:400-405): `scopeDenial` returns null for the access tool because its scope is `null`. `visibleTools` then filters it out through `holdsToolScope` -> `visibleTo`, so the call returns "Unknown tool". No data reaches the caller.
- Legacy batch: each message goes through the same `handleMessage` -> `callTool`. Same outcome.
- Step-up (server.ts:592-597): `scopeDenial` is null for a `scope: null` tool, so a non-admin OAuth caller never gets a 403/WWW-Authenticate for it.
- `callsMutation` (server.ts:542-547): the tool is READ_ONLY, so it doesn't matter.
- Principals: `session`, `api_key` and `oauth` all resolve `role` through `isRole(...) ? role : 'user'` (identity.ts, worker.ts:180), so `ROLE_TEMPLATES[role]` in `roleHasAdminAccess` can't be undefined. `anonymous` is rejected with 401 before any tool logic (server.ts:568). Role is re-read on each request, so a demoted admin loses the tool right away.
- `roleHasAdminAccess(role)` is equivalent to `roleAdmin.length > 0` in `adminAccessStatus`, which matches the `not_eligible` state.
- `instructionsFor`: customer -> core only. Owner/admin -> core + admin text, even on a default-scope connection. That is consistent, because they can see `get_admin_access_status`. Page text: see L2.
- `MCP_TOOL_CATALOG` drops `visibleTo`, but its only consumer (`adminAccessStatus`) filters by admin scopes, so the access tool never appears there anyway.

## High
### H1. "Deep options only when you ask" is false for accounts with saved reading defaults
- Where: src/content/docs/claude.md:59 ("only run when asked"), plugins/anymd-research/README.md ("Credits" bullet: "the skill uses them only when you ask"), plugins/anymd-research/skills/research/SKILL.md step 2.
- Code: `resolveReadingOptions` (src/convert/reading-preferences.ts:226-246) fills every omitted `expandThread/includeComments/analyzeImages/downloadVideo/analyzeVideo/maxCredits` from the account's saved preferences. The `read_url` description itself says this.
- Scenario: a user turned on "include comments" and "download video" in dashboard reading defaults. The skill calls `read_url {url, save:false}` for a YouTube link. comments and video download run and charge extra credits, which contradicts the plugin README the reviewer reads.
- Fix: either (a) reword claude.md, the README and SKILL to "unless you turned them on as saved reading defaults", or (b) have SKILL pass explicit `false` for the five deep options unless the user asks. (a) respects the user's own setting and is the smaller change.

### H2. search_social sends queries to third-party processors that the privacy policy doesn't list
- Where: src/convert/social-search-providers.ts:161,194-203 sends the keywords to RapidAPI hosts (twitter-api45, facebook-scraper3, instagram-pro-and-cheap-api, threads-scraper-api2, fresh-linkedin-profile-data). src/content/legal/privacy.md:55-67 lists RapidAPI only for YouTube transcripts. Social URL conversion appears to use the same kind of providers.
- Why this commit makes it matter: `search_social` is now in the directory-reviewed default tool set. claude.md and the README point to the privacy policy as the authority. The README's "What it sends and where" only mentions AnyMD. The connector criteria require the privacy policy to cover the data flows.
- Fix: before submitting, add the social search and social-post providers to privacy.md. Add one line to the README and claude.md saying that anymd forwards social search keywords to third-party data providers.

## Medium
### M1. "Saves only when you ask" depends on the model following the skill, and the server default is save=true
- Where: plugin.json/marketplace.json description, README, claude.md:12. Server: `save` defaults to true (server.ts READ_URL_INPUT), and `convert_url` behaves the same. `INSTRUCTIONS_CORE` says anymd "keeps a private, searchable library of everything read".
- Scenario: the model calls `read_url` without `save`, or uses `convert_url`, and the page is saved silently. A connector-only user saves every read. The server instructions also contradict the plugin's promise.
- Fix: word it as intent ("the research skill tells Claude to pass save:false unless you ask"). Optionally soften INSTRUCTIONS_CORE to "a private, searchable library of what you save".

### M2. Wrong dashboard path
- Where: src/content/docs/claude.md:48 says "**Dashboard → Connected apps**".
- Code: no such nav item. The "Connected apps (OAuth)" card lives on Dashboard → API keys (`/dashboard/keys`, src/views/dashboard.tsx:30,1072).
- Fix: "**Dashboard → API keys → Connected apps**".

### M3. Unverified client-dedup claim
- Where: src/content/docs/claude.md:14 says "If you add both, Claude uses one anymd connection". The README says "the skill uses whichever AnyMD connection is present".
- Problem: in Claude Code, `claude mcp add anymd` plus the plugin registers both `anymd` and `plugin:anymd-research:anymd` unless the client dedupes. Directory pairing (docs/claude-directory.md step 3) covers only directory installs.
- Fix: limit the claim to directory pairing, or tell users to keep one entry.

## Low
- L1: src/mcp/admin-tools.ts:341. The tool description still ends "roles without admin access learn only that". Those roles can no longer see the tool over MCP. Drop the clause.
- L2: src/mcp/server.ts:66 (`instructionsFor`). The page-builder text is gated on `pages:read`. A `viewer` session, or a read-only content key, is told about `create_page/apply_page_ops/publish_page`, which it can't see. Gate on visibility instead (`visibleTools(p).some(t => t.name === 'create_page')`) or on `pages:write`.
- L3 (pre-existing, informational): a customer calling a hidden admin tool by name (e.g. `system_overview`) gets `forbidden: Your role (user) does not allow system_overview (needs system:read)`, so staff tool names are still discoverable. Calling the hidden access tool gets "Unknown tool". No data is exposed. Consider returning "Unknown tool" when `!roleAllows`, for consistency.
- L4: tests are weaker than their names claim:
  - test/admin-operations-tooling.test.ts asserts only `isError` for the hidden call. Assert "Unknown tool" and the absence of `structuredContent`.
  - "tells a user-role caller over REST" calls the service directly, not `GET /api/v1/admin/access`.
  - test/mcp-directory-readiness.test.ts builds scopes with `capScopes`, not the production `oauthPrincipalScopes(role, props.scopes, v, auth.scope)`.
  - Instructions are tested only through legacy `initialize` (2025-06-18 is in LEGACY_VERSIONS). Modern `server/discover` is not covered.
  - docs/claude-directory.md cites test/mcp-admin-authorization.test.ts for titles, but that test checks only the four hints. Titles are enforced by the `ToolDef.title: string` type and the readiness test checks them for the customer set only.
- L5: claude.md:31 and the README use the in-app form `/plugin install anymd-research --marketplace digitopvn/anymd`. The `claude plugin install` CLI supports `--marketplace`. Verify the slash-command form, or document `/plugin marketplace add digitopvn/anymd` then `/plugin install anymd-research@anymd`.
- L6: SKILL step 4 says "a cached re-read is free". The cache TTL is 1 h (service.ts:59) and only complete results are cached, so a later "save it" costs credits again. Reword to "free within an hour".
- L7: src/content/docs/mcp.md adds a "Claude (claude.ai, Cowork, Desktop)" heading directly above the existing "Claude Desktop" section, which is redundant. claude.md:48 "Read tools are marked read-only" is ambiguous, because `read_url` is not read-only.
- Follow-up (later commit 9094da7, out of scope): it changed `read_url`/`get_document` inputs (offset/maxChars windowing). Under the new AGENTS.md rule that requires a SKILL/README update and a plugin `version` bump. Neither happened.

## Plan / task status
Commit contents match its message. Submission table correctly says "not submitted yet". Fix H1/H2 before the portal submission.

## Unresolved questions
- Does product want deep options to follow saved defaults inside the skill (H1 option a), or always be explicit-off (option b)?
- Does Claude Code dedupe a plugin MCP server against a manually added server with the same URL (M3)?
