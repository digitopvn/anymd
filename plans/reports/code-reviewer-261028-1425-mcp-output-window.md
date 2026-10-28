# Code review: MCP output windowing (9094da7, 72ba090)

Branch `claude/affectionate-goodall-lood5f`. Issue #57. Read-only review; no source files modified.

## Scope
- Files: `src/mcp/markdown-window.ts` (new, 59 LOC), `src/mcp/server.ts` (+/-11), `src/content/docs/mcp.md` (+4/-2), `test/mcp-output-window.test.ts` (new, 173 LOC)
- Verification: `npm run typecheck` clean; `npx vitest run` 33 files / 512 tests pass (11 new).
- Context read: `src/convert/service.ts` (runConversion, cacheKey, cache write), `src/library/store.ts` (getDocument, saveDocument), `src/services.ts` (convertPayload), `src/mcp/server.ts` callTool result shaping, `client/lib/webmcp.ts`, issue #57 acceptance criteria.

## Overall assessment
The window function is small and correct for every boundary the brief asks about. The wiring is right: the window is applied after `runConversion`, so it never enters the cache key or the saved copy. REST, URL API, CLI and WebMCP are untouched. Two contract claims don't hold everywhere, though. "Later windows are free (cache hit)" fails for partially enriched reads. And the 40,000-character default doesn't keep non-Latin pages within the token budget it was meant to fix. Nothing blocks the merge. Fix the should-fix items or document them before release.

## Boundary verification (questions from the brief)

| Case | Behaviour | Verdict |
|---|---|---|
| offset == length / beyond length | `markdown-window.ts:44` returns `''`, `truncated:false`, `next_offset:null`, echoes the offset | Correct, matches docs, tested (unit and e2e) |
| offset + maxChars >= length | `:46` returns the rest, `truncated:false` | Correct |
| Hard cut on a high surrogate | `:50-52` pulls `end` back by 1. `maxChars >= 1000` means `end-1 > offset`, so the window is never empty | Correct, tested |
| Line-break cut | `:47-49` `end = lineBreak+1` cannot split a pair (`\n` is BMP). CRLF stays together | Correct |
| Client offset that lands on a low surrogate | The window starts with a lone low surrogate. It can only come from a hand-crafted offset, never from `next_offset` | Nit (N1) |
| offset with no maxChars | Destructuring default -> 40,000 | Correct. Only the past-end case is tested (T2) |
| maxChars limits | zod `int().min(1000).max(200000)` at `:18`. Rejections are tested (`-1`, `10`, `500000`, `1.5`) and fail before any fetch | Correct |
| Field collisions | `windowMarkdown` keys (`markdown,total_chars,offset,truncated,next_offset`) don't collide with `convertPayload` or `DocumentRow` keys. On get_document, `markdown` is overwritten on purpose | Correct |

## Backward compatibility
- REST / URL API: `convertPayload` (`src/services.ts:14`) and `src/routes/api.ts:276` are unchanged. WebMCP calls REST (`client/lib/webmcp.ts`). The CLI is untouched. **Unaffected.**
- MCP: input is additive (optional fields) and no `outputSchema` is declared, so no client-side schema validation breaks. The behaviour change is deliberate (issue #57): a client that sends no `maxChars` and ignores `truncated` now silently gets the first ~40k characters where it used to get the whole page. LLM clients see `WINDOW_TEXT` in the tool description. Programmatic MCP clients that read `structuredContent.markdown` as the full text get no signal they would notice. That's acceptable under #57, but `SERVER_INFO.version` (`server.ts:46`, `1.1.0`) was not bumped for a change in output semantics (N3).

## Saved document and cache
- `server.ts:80` removes `offset`/`maxChars` before `runConversion`. `cacheKey` (`service.ts:68`) never sees them. The KV entry and `saveDocument` both get the full Markdown. **Confirmed.** The e2e test checks one row and one upstream fetch.
- `get_document` windows the result of `getDocument` only. The DB row is never written. **Confirmed.**

## Findings

### Blocking
None.

### Should-fix

**S1. Paging can re-charge credits and re-convert when enrichment is partial.** `src/convert/service.ts:189` (interaction with `src/mcp/server.ts:78-83`, claim in `src/content/docs/mcp.md:113`)
`cacheValue` is set only when every enrichment part is `complete`. The docs and the commit message promise "later windows are free".
Scenario: an agent calls `read_url {url: <long Reddit/HN thread>, includeComments: true}` and the comment fetch times out or hits `maxComments` (`complete:false`). Nothing is cached. Each `read_url {..., offset: next_offset}` runs the adapter again, reserves and charges base plus comment credits again, and may return different Markdown (comment set or order changed), so `next_offset` from the previous text points into a different string. The agent skips or duplicates content and is never told. This breaks the #57 acceptance criterion "next window must not cost credits again". The same thing happens on any read after the 1-hour `CACHE_TTL` (`service.ts:59`) expires, and maybe on a KV read-after-write miss: the put runs in `waitUntil` (`service.ts:214`) and KV is eventually consistent across PoPs.
Fix options, pick one: (a) in `WINDOW_TEXT` and the docs, tell agents to page with `get_document {id: document_id}` once a read is saved. The library row is stable and free. Say in the docs that windows are free only when the result was cached. (b) Return a short `content_hash` (or reuse `trace_id` semantics) in the window result and document that a changed hash means "restart from 0". (c) For `read_url` calls with `offset > 0`, fall back to the saved document when one exists. (a) plus the doc correction is the minimum.

**S2. The 40,000-character default doesn't bound tokens for non-Latin text, and the payload is still sent twice.** `src/mcp/markdown-window.ts:11-12`, `src/mcp/server.ts:424` and `:426`
The comment says "About 10k tokens of prose: fits client tool-result budgets even with the structured copy". That holds for English at ~4 chars per token. For CJK, Thai or Vietnamese pages, tokenisation runs at roughly 1-2 chars per token, so one 40k window is about 20-40k tokens. `read_url` sends it twice (content[0] plus `structuredContent`). `get_document` sends it twice as well, once as escaped pretty-printed JSON in content[0] (`server.ts:420,426`).
Scenario: `read_url https://ja.wikipedia.org/wiki/<long article>` with default args. The first window is still over Claude Code's ~25k-token tool-result cap, and the result spills to a file: the exact failure #57 reports. The allowed `maxChars` of 200,000 (x2 on the wire, about 400k chars) also re-enables the 127k-char failure from #57 for any agent that asks for it.
Fix: lower the default (for example 20k), or scale the window when the text is mostly non-ASCII. For get_document, think about sending the Markdown as its own text block the way read_url does, so the JSON escaping doesn't add size. At minimum, correct the comment and docs to say the limit is in characters, not tokens.

**S3. `read_url` offsets and `get_document` offsets index different strings, and nothing says so.** `src/convert/service.ts:193` and `:207`, `src/mcp/server.ts:49`
`read_url` windows `formatMarkdown(result, {frontmatter: true})` (plus a video tail). The saved document is `formatMarkdown(..., {frontmatter: false})` merged with earlier enrichment. Their `total_chars` and offsets differ.
Scenario: the agent reads window 1 with `read_url`, sees `document_id`, then follows the server instructions ("get_document ... pass next_offset as offset to continue") and calls `get_document {id, offset: <read_url next_offset>}`. That skips the first N characters of the body, roughly the frontmatter length, or repeats them. Fix: one sentence in `WINDOW_TEXT` and `mcp.md`: "next_offset is valid only for the same tool and the same options."

**S4. The docs overstate "free" and leave out the save side effect of paging.** `src/content/docs/mcp.md:113`
Besides S1: with `save` defaulting to true, every paging call goes through `saveDocument`, which runs `UPDATE documents SET updated_at` (`store.ts:100`) and writes a `usage_events` row with `status:'cached'`. Ten windows mean ten library touches and ten usage rows, which can reorder `list_documents` by recency. That's harmless but undocumented. Suggest "pass `save: false` when paging", or point agents at get_document (see S1a).

### Nit

**N1.** `markdown-window.ts:44-46`: a caller-supplied `offset` that points at a low surrogate yields a window that starts with a lone surrogate. Only reachable by hand-crafted offsets. Either snap `offset` forward by one when `isLowSurrogate(charCodeAt(offset))`, or leave it alone and document it.

**N2.** Units: docs and descriptions say "characters", but `total_chars`, `offset` and `maxChars` count UTF-16 code units (JS `.length`). A Python or Rust client that computes its own offset as `len(received_text)` drifts on every emoji or astral character. Say "UTF-16 code units; always use `next_offset`" in `mcp.md:113` and in the `offset` describe at `:17`.

**N3.** `server.ts:46`: `SERVER_INFO.version` is still `1.1.0` although default output semantics changed for three tools.

**N4.** `windowMarkdown` relies on the zod schema for `maxChars >= 1000`. Called directly with `maxChars: 1` on text that starts with a high surrogate, it returns an empty window with `truncated:true, next_offset: offset`, and a caller would loop forever. The function is exported, so clamp inside it (`Math.max(maxChars, 2)`) or assert.

**N5.** `plugins/anymd-research/skills/research/SKILL.md:14` ("Open promising hits with `get_document`") doesn't mention paging. AGENTS.md doesn't require a plugin bump for input-only changes, but one line ("long documents come in windows; follow `next_offset` only if needed") would stop the research skill from reading every window of every hit, or from stopping at window 1 without knowing more exists.

## Docs vs code
- Matches: parameter ranges and defaults, the 10% line-break rule, past-end behaviour, the field list, the tool table rows, "Only the MCP result is windowed", the `updated` frontmatter (2026-10-28).
- Mismatches or gaps: "later windows are free" (S1); "characters" vs UTF-16 units (N2); offsets are per tool (S3); the "fits even with the structured copy" comment (S2). The server instructions mention paging only for get_document, not read_url. That's fine, since `WINDOW_TEXT` covers read_url.

## Test gaps
- **T1 (should-fix).** `test/mcp-output-window.test.ts:125` asserts `rows[0].markdown.length >= parts.join('').length - 1000`. That's a fuzzy bound, and it would pass even if the saved row were truncated by up to 1,000 chars. Compare exactly: build the expected saved Markdown (or fetch via `get_document` with `maxChars: 200000`) and `toBe` it, and assert `parts.join('') === <full read_url markdown>`. A REST call `POST /api/v1/convert` in the same test would prove REST is byte-for-byte unchanged, which is an explicit #57 criterion that no test currently covers.
- **T2.** No test for a mid-document `offset` without `maxChars` (default window from a non-zero offset).
- **T3.** No test for partial enrichment (S1): nothing asserts what credits and cached are on window 2 when the first result was not cacheable.
- **T4.** No unit test for a line break exactly at `end - floor(maxChars*0.1)` (inclusive boundary), or for a surrogate pair right after an out-of-slack line break.
- **T5.** The get_document e2e doesn't assert `next_offset` on the first window, or that `tags` stays parsed alongside the window fields.

## Positive observations (risk calibration)
- Destructuring the window args off before `runConversion` (`server.ts:80`) is the right seam. Cache-key and library-row pollution are impossible by construction.
- Text block and `structuredContent` carry the same window. That's tested.

## Recommended actions
1. S1: point agents at `get_document` for paging (or add a content hash) and correct "free" in the docs.
2. S2: lower or tune the default, fix the "10k tokens" claim, and decide whether to keep the 200k cap.
3. S3/N2: document that offsets are per tool and options, in UTF-16 code units.
4. T1: replace the fuzzy saved-copy assertion with an exact one and add a REST unchanged check.
5. Nits as time allows.

## Metrics
- Typecheck: 0 errors. Lint: no lint script in package.json. Tests: 512/512 pass.
- Coverage: not measured. The new module's branches are all exercised except the low-surrogate start offset.

## Unresolved questions
- Does Claude Code count `structuredContent` toward its tool-result token cap, or only `content`? If only `content`, S2 halves for read_url but not for get_document (whose content[0] is the full JSON).
- Is a version bump of `SERVER_INFO` expected for output-semantics changes in this repo?

Status: DONE_WITH_CONCERNS
Summary: The window function is correct at every boundary asked about, the cache and saved document keep the full Markdown, and REST, URL API, CLI and WebMCP are unaffected. However, paging can re-charge and drift when a partially enriched read isn't cached, the 40k-char default doesn't fit the token budget for non-Latin text, and read_url and get_document offsets aren't interchangeable, so the docs need correcting.
