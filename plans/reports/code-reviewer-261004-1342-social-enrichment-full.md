# Code Review Summary

## Scope and validation

- Reviewed all pending social-conversion, enrichment, accounting, cache, library, channel, and migration changes against `REVIEW.md` and the accepted plan.
- Treated the supplied live evidence as authoritative: X returned seven members at seven credits; Facebook returned five comments at twenty total credits; Instagram post/media, Threads detail/carousel, and LinkedIn post/comments schemas were verified; Instagram and Threads comment outages are represented as partial results.
- `npm run typecheck`, all 108 Vitest tests, all 38 CLI tests, and `git diff --check` passed.

## Findings

### High — Provider plaintext is interpreted as active Markdown and can trigger paid image fetches

`socialResult` inserts the provider's plain post text directly into Markdown (`src/convert/social-common.ts:13-17`). `runConversion` then passes that content to `enrichImages` (`src/convert/service.ts:138-147`), whose Markdown lexer treats any image syntax in the post text as an article image (`src/convert/image-enrichment.ts:9-18`). A hostile public post containing `![x](https://attacker.example/image)` can therefore make an opted-in conversion fetch an author-selected URL, send it to OpenRouter, and charge five image credits even though the URL was text rather than provider media. The SSRF guard blocks private targets, but it does not prevent attacker-selected public requests or unintended user charges.

The same trust-boundary issue affects the returned Markdown: post text, comment author/text values, and the generated `${author} post` heading retain Markdown control characters. anymd's HTML renderer blocks raw HTML and `javascript:` links, but downstream Markdown consumers and permitted HTTP image syntax still receive active constructs. Escape provider plaintext before composing Markdown, then add only provider-verified links/media through explicit renderers. Add a test proving caption/comment Markdown syntax remains literal and cannot enter `articleImages`.

### Medium — New internal library columns leak through REST and MCP document reads

The migration adds `enrichment_json` and `base_markdown`, but `DocumentRow` does not declare either (`src/library/store.ts:9-28`), indicating they are storage details. `getDocument` still executes `SELECT *` (`src/library/store.ts:122-123`), and both REST and MCP spread the runtime row (`src/routes/api.ts:191-198`, `src/mcp/server.ts:97-102`). Every JSON document read now returns raw enrichment JSON plus a second potentially large Markdown body despite the typed and documented response shape not containing those fields.

Select the public `DocumentRow` columns explicitly, as list queries already do, or map the row before returning it. If enrichment should become public library metadata, expose a deliberate typed field instead of leaking database column names and duplicated content.

### Medium — Metadata-only refreshes are silently discarded

`saveDocument` hashes rendered Markdown and enrichment, then takes the unchanged fast path at `src/library/store.ts:63-66`, updating only `updated_at`. Metadata fields are updated only in the content-change branch at lines 68-74. A source can keep the same body while changing its title, author/display name, description, canonical image, published value, language, or source kind; the saved document then retains stale metadata indefinitely. Social posts make this readily observable when an author changes display name without changing post text.

Include persisted metadata in change detection or update metadata in the unchanged-content branch. Preserve `embedded_chunks` when only metadata changes unless the embedding contract includes that metadata.

### Medium — LinkedIn pagination can report complete coverage after stopping short of `total`

The LinkedIn adapter advances only when the current page is non-empty and `rootCount < total` (`src/convert/linkedin.ts:40-43`). If a provider page is empty while `rootCount` is still below the verified `total`, it returns no `next` cursor with `complete` still true. `collectComments` then terminates and publishes complete coverage for fewer roots than the provider says exist. This also hides transient short/empty pages in nested-comment collection.

When `total` is known, set `complete = false` whenever pagination terminates with `rootCount < total`. Keep the current bounded stop rather than retrying an empty page indefinitely.

### Medium — X ancestry accepts a same-author parent from another conversation and can charge for it

Ancestor traversal checks only the parent's author at `src/convert/x-thread.ts:69-71`; it does not require the parent to share the initial conversation. With malformed upstream data containing a same-author parent from another conversation, that parent becomes `root`. `threadMembers` then excludes the requested post because it correctly requires the root conversation (`src/convert/x-thread.ts:33-44`), but rendering can still fetch and charge for the foreign parent before leaving the original result unchanged (`src/convert/x-thread.ts:90-106`). Coverage can remain `complete: true` and count one while the thread breakdown contains a credit for content absent from the output.

Reject a parent whose non-empty conversation ID differs from the initial conversation as `upstream_schema`, before it is added to `ancestors`. Add an ancestry test for this relationship invariant.

## Verified behavior

- Cache variants include authentication class, comment/image opt-ins, their bounds, and `maxCredits`; incomplete enrichment is not cached. Cache publication occurs only after synchronous library save and successful charge settlement.
- Social adapters route before the web fallback and use the fixed ten-credit base. A seven-post X thread costs one base plus six additional posts. Comment charging starts one ten-credit unit per accepted group of twenty, so five Facebook comments cost ten comment credits plus the ten-credit base.
- D1 reservation accounting atomically includes competing active reservations, excludes duplicate telemetry by trace ID, and settles once. Cached conversions are free.
- Every RapidAPI call, image redirect hop, FxTwitter member attempt, and OpenRouter call consumes the shared forty-call/deadline budget. Provider failures retain accepted units and mark coverage incomplete.
- Image fetches normalize every target and redirect, reject credentialed redirects, enforce byte limits, and do not charge failed analyses.
- Same-author X descendants require author, conversation, and rooted parent membership. The live seven-member result and cost are consistent with the implementation.

## Remaining test gaps

- No adapter-level fixture test covers hostile plaintext, LinkedIn early pagination termination, or the X ancestor conversation invariant.
- No library integration test verifies metadata-only refreshes or that storage-only columns stay out of REST/MCP responses.
- Live Instagram and Threads comment completion remains externally unavailable/intermittent; the current partial states are honest, but complete nested traversal cannot be claimed from this run.

## Unresolved questions

- Should library JSON reads expose a structured public `enrichment` object? Current types and routes provide no such contract, so this review treats the raw database columns as unintended.
