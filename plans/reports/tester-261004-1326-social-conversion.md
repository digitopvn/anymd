# Test Report — 2026-10-04 — Social conversion enrichment

## Outcome

The final precommit candidate at version 0.1.1 passes every local gate in scope: 122 Worker tests and 41 CLI tests with no failures or skips. The focused suites cover enrichment helpers, hostile plaintext handling, redirect safety, social comments, adapter routing, thread membership, conversion budgets, actual SQLite reservation semantics, and full-entropy CMS block IDs.

## Pre-implementation baseline

- `npm run typecheck`: passed with no diagnostics in 13.17 seconds.
- `npm test`: passed 83/83 tests across 7/7 files, with 0 failed and 0 skipped. Vitest reported 6.87 seconds.
- `node --test cli/test/*.test.mjs`: passed 38/38 tests across 9 suites, with 0 failed, 0 skipped, and 0 todo. Node reported 364.61 milliseconds.
- `npm run build`: passed. Tailwind CSS v4.3.3 built the minified CSS, and esbuild produced all three client bundles.
- `npm audit --omit=dev --json`: reported 0 vulnerabilities at every severity for 31 production dependencies.

The baseline executed 121 tests and all 121 passed. At baseline, no tracked source changes were present; only the social-conversion plan directory was untracked.

## Focused implementation verification

- `npx vitest run test/enrichment.test.ts`: passed 33/33 tests after the Threads API4 and Instagram photo fast-path changes.
- `npx vitest run test/editor.test.ts`: passed 34/34 tests after repairing truncated block IDs in both insertion and recursive duplication.
- `npm run typecheck`: passed after adding the focused tests.
- Node 22 CI compatibility: the focused suite passed 25/25 under Node v22.23.3 in 1.91 seconds. Node 22 emits its expected `node:sqlite` experimental warning; the API used by the tests is available.

The focused tests cover:

- bounded enrichment-option validation;
- nested and relative article images, decorative-image filtering, and rejection of private or unsupported URL schemes;
- image-analysis rendering, comments, unmatched saved analyses, and explicit incomplete coverage;
- repeated image occurrences, with analysis rendered beside every occurrence;
- escaping of hostile captions, authors, quoted comments, fake images, and fake headings before Markdown parsing;
- literal preservation of list, rule, strike, plus, equals, and hyphen characters from social plaintext;
- manual redirect mode for credential-bearing RapidAPI and OpenRouter requests, rejection of redirect responses, zero image charge on rejected model redirects, and the same redirect rejection for FxTwitter;
- Facebook, Instagram, Threads, and LinkedIn adapter selection and fixed base credit cost;
- Instagram photo posts use a valid public `display_url` without the slower media endpoint, while carousels still fetch and retain every media image;
- Threads shortcode decoding and invalid shortcode rejection;
- Threads API4 documented envelopes, focus/ancestor filtering, nested reply queues, root cursor pagination, missing-cursor partial coverage, and zero comment charge when a page fails before yielding a valid unit;
- comment batch charging at the 20/21 boundary, duplicate suppression, max-count truncation, cyclic cursors, failed later pages, and empty nested pages with queued work;
- preservation of complete or richer partial library enrichment;
- supported tweet provider shapes and malformed identifiers;
- rooted same-author thread membership with ordering and rejection of duplicates, cross-author posts, unrelated replies, cycles, and other conversations;
- exact `ConversionBudget` breakdown, spend ceiling, and provider-call ceiling;
- execution of migration `0005_conversion_enrichment.sql` against Node's built-in SQLite;
- database checks for reservation/credit constraints, active versus expired reservations, telemetry de-duplication, competing reservation atomicity, settlement bounds, and exactly-once settlement.
- insertion and nested duplication retain the complete `newId('b_')` value, produce unique IDs at the 80-block page limit, and satisfy the existing 24-character block-ID shape.

## Coverage metrics

No coverage package or repository coverage command is configured, so line, branch, and function percentages were not measured. Behavioral invariants and missing integration checks are reported instead of inventing a percentage threshold.

## Observed warning

The baseline `test/pages.test.ts` emitted a Wrangler informational warning that CIMD is disabled until `global_fetch_strictly_public` is added to compatibility flags. It did not fail the suite and is unrelated to this feature.

## Final precommit broad gates

- `npm run typecheck`: passed with no TypeScript diagnostics.
- `npm test`: passed 122/122 tests across 10/10 files, with 0 failed and 0 skipped. Vitest reported 2.31 seconds.
- `node --test cli/test/*.test.mjs`: the first run found one stale test expectation (`0.1.0` instead of the released candidate version `0.1.1`). After updating that fixture, the suite passed 41/41 tests across 9 suites, with 0 failed, 0 skipped, and 0 todo. Node reported 129.02 milliseconds.
- `npm run build`: passed. Tailwind CSS v4.3.3 completed and esbuild produced all three client bundles.
- `git diff --check`: passed with no whitespace errors.

The final candidate executed 163 tests and all 163 passed. Three new CLI tests verify authenticated option forwarding, reject anonymous paid enrichment before any request, and enforce all numeric bounds before network I/O. Two editor regressions verify complete IDs for creation and recursive duplication; they also reproduce the previous collision-prone volume at the page limit without relying on random collision occurrence.

## Remaining verification

Provider network fixtures validate parsers and failure handling but cannot establish live subscription availability. Root reported that all 10 requested authenticated staging cases passed on revision `713d28ec`: X full thread/cache/credit cap; Facebook comments, save, and plaintext preservation; LinkedIn comments; Instagram OCR; Threads five comments at 20 credits; credit cap 402; option validation 400; anonymous enrichment 401; and no settlement leaks. These are staging results and do not establish production deployment success.

## Unresolved questions

- Responsive UI behavior and production deployment remain outside this local suite.
- This report establishes the tested staging/precommit candidate only; production has not been deployed or verified.
