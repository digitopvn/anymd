# Final code review — social conversion enrichment

## Verdict

**No new evidence-based blocker found.** The integrated candidate is ready to proceed through the authorized release workflow. This review does not claim that production has been migrated, deployed, or smoke-tested.

## Scope

- Reviewed the full pending diff, `REVIEW.md`, the accepted plan, the earlier early/full code-review reports, and the final tester report.
- Rechecked the highest-risk paths: D1 reservation/settlement, `maxCredits`, cache isolation and publication order, library enrichment merging, provider redirects and response bounds, image fetching and model charging, hostile social plaintext, nested comment traversal, and X ancestry/thread membership.
- Rechecked the public channel wiring for URL API, REST, CLI, MCP, WebMCP, and the browser converter.

## Blocking findings

None.

## Guard verification

- Reservations are rechecked atomically in the D1 `INSERT`; active reservations and settled charges count against allowance, telemetry with the same trace is excluded, and settlement is bounded by the reservation and can happen only once.
- `maxCredits` is the `ConversionBudget` ceiling for authenticated and anonymous conversions. Plain web conversions reserve only the safe maximum base cost needed for post-fetch document detection, while enrichment and X reserve up to the caller's cap. Detected base cost is checked before it replaces the provisional base charge.
- Cache keys include authentication class and every output/cost-changing enrichment option. Incomplete enrichment is not cached. A new cache value is scheduled only after library saving and successful settlement; cache hits cost zero.
- Provider credential requests use manual redirects, bounded bodies, timeouts, and the shared call/deadline budget. FxTwitter and OpenRouter redirects are rejected. Image redirects are followed manually and each destination is normalized again before fetching.
- Image credits are charged only after a successful, complete model response. Failed fetches, provider redirects, incomplete model responses, and unavailable providers remain uncharged and explicitly partial.
- Instagram photo posts use the valid provider-declared `display_url` after public-URL normalization, avoiding the redundant media endpoint that repeatedly timed out. Missing or invalid photo URLs still fall back to the bounded media endpoint, and carousel/video posts retain the all-items media path.
- Provider captions, comment authors, and comment text are escaped before Markdown composition, so plaintext cannot create headings, rules, links, or images. Provider-declared media URLs still pass the public URL guard.
- Facebook, Instagram, Threads, and LinkedIn traversal is bounded by comment limits, cursor-cycle checks, the shared call/deadline budget, and explicit incomplete coverage. The Threads API4 parser additionally requires the focused post on each initial root/nested page, skips the returned ancestor/focus context, and accepts only rows marked as replies. Accepted comments and their charges survive a later-page failure.
- X ancestors must share the requested author's ID and conversation ID. Descendants additionally require a parent already in the rooted chain. Cross-author, cross-conversation, cyclic, and disconnected rows do not enter the rendered thread.
- Library reads select public columns explicitly. Metadata-only refreshes update persisted metadata, reset embeddings when title/body-derived vectors need refresh, and preserve richer saved enrichment and its base Markdown.
- CMS insert and recursive duplicate paths now retain the full `b_` plus 22-character time/random ID. Page documents persist IDs as JSON strings; REST, MCP, and client operation contracts treat them as opaque strings; and browser selectors escape them. No existing length contract rejects the full form.

## Validation evidence

- `npm run typecheck`: passed with no diagnostics, including after the Threads API4 delta.
- The pre-delta broad `npm test -- --run` passed 115/115 tests across 10 files, with no failures or skips.
- The final focused `npx vitest run test/enrichment.test.ts` passed 31/31 tests, including API4 envelope mapping, focus/ancestor filtering, nested and cursor pagination, null-cursor partial coverage, and zero comment charging on an initial comments-page failure.
- The final focused `npx vitest run test/editor.test.ts` passed 34/34 tests. Its insert and nested-duplicate regressions exercise the 80-block document limit, require 80 unique IDs, and deterministically require the full `b_[base32]{22}` shape.
- The release smoke script requires Instagram to return five comments at the expected twenty-credit total in addition to the existing image-analysis assertion; that live case passed.
- `npm --prefix cli test`: passed 41/41 tests across 9 suites.
- `npm run build`: passed; Tailwind and all three client bundles built successfully.
- `git diff --check`: passed.

The supplied authenticated staging evidence is consistent with the reviewed contracts: X returned seven posts for seven credits, a cache hit cost zero, and a two-credit cap returned an explicit partial; Facebook and LinkedIn each returned five requested comments for twenty total credits; a plain Facebook refresh preserved saved comments; Instagram returned one analyzed photo for fifteen total credits using the configured model and five comments for twenty total credits; Threads API4 returned seventeen comments through three provider calls for twenty total credits, including nested traversal; base-budget, contradictory-option, and anonymous paid-enrichment requests returned 402, 400, and 401 respectively. Responsive checks at 375, 768, and 1440 pixels reported no overflow and the anonymous error state was verified.

## Residual operational limits

- The live Threads result remained explicitly partial because the provider advertised another page with a null cursor after returning seventeen comments. The implementation retained those comments, charged one started comment batch, and marked `source_incomplete`; this is truthful handling of contradictory provider pagination rather than a correctness blocker.
- Instagram's redundant photo-media endpoint repeatedly timed out, while the post payload supplied a valid direct photo URL. The reviewed delta uses that normalized URL for photo posts; other media types retain the bounded endpoint and partial-result behavior remains the fallback when their provider path is unavailable. The earlier live comment request failed with a real provider 408 and correctly charged zero comment units; the subsequent release case passed.
- Production migration, deployment, and smoke evidence are outside this report and should be recorded by the release controller after those authorized steps run.

Status: **DONE**
