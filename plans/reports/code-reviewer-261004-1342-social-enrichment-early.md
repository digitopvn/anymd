# Code Review Summary

## Scope

- Reviewed the pending social-enrichment primitives and their integration points in `src/convert/service.ts`, `src/convert/enrichment-types.ts`, `src/convert/provider-fetch.ts`, `src/convert/image-enrichment.ts`, `src/convert/x-thread.ts`, `src/convert/x-twitter.ts`, `src/lib/conversion-budget.ts`, `src/lib/usage.ts`, and `migrations/0005_conversion_enrichment.sql`.
- Compared them with `REVIEW.md` and `plans/261004-1326-social-conversion/{plan.md,phase-01-delivery.md}`.
- Did not treat unfinished channel wiring, new adapters, or library-preservation work as defects.
- `npm run typecheck` passed. No focused enrichment/accounting tests exist yet; the baseline report explicitly records those gaps.

## Findings

### High — A request can fail after its charge is irrevocably settled

`runConversion` settles the reservation at `src/convert/service.ts:142`, then performs the synchronous library write at lines 145-149. If `saveDocument` throws, control reaches the error handler, but `settled` is already true, so line 164 cannot release the charge. The caller receives an error and the error usage event reports zero credits, while `conversion_charges` continues to count the settled credits. For overage plans, the external billing ingest is also skipped because it appears after the library write, leaving internal quota and provider billing inconsistent.

This contradicts the repository rule that failed conversions cost zero and the accepted requirement to release failed reservations. Settle only after every synchronous operation required for a successful response has completed, or introduce an explicit idempotent reversal state and keep usage/billing settlement consistent.

### High — The 40-call processing bound does not bound actual outbound calls

`ConversionBudget.canFetch()` enforces `calls < 40` (`src/convert/enrichment-types.ts:42`), but several paths do not reserve a call before each attempt:

- `enrichImages` increments once per image at `src/convert/image-enrichment.ts:53-54`. `imageData` can perform four redirect-hop fetches at lines 23-31, and a successful image adds an OpenRouter request at line 58 without another increment.
- X member rendering checks `canFetch()` at `src/convert/x-thread.ts:95`, but increments only after `fetchTweetData` succeeds at line 97. Failed FxTwitter requests therefore consume no call slot. A bounded search response can supply many candidates, causing every failed candidate to be attempted while `calls` remains unchanged.

Consequently a nominal 40-call request can issue substantially more than 40 outbound requests; redirecting images alone permit up to 80 image fetch attempts for 20 images, before combining X traversal or model calls. Increment/reserve immediately before every outbound attempt, preferably through one helper used by RapidAPI, FxTwitter, image redirects, and OpenRouter.

### High — Repeated FxTwitter member fetches have no response-size bound

`fetchTweetData` reads `response.json()` directly at `src/convert/x-twitter.ts:637`. Thread enrichment now calls it once per rendered member (`src/convert/x-thread.ts:96`), expanding the existing single-response exposure into repeated upstream-controlled allocations. Timeouts do not cap response bytes, and the failed-call accounting defect above can compound this under malformed or oversized responses.

Read FxTwitter responses through `readBounded` before parsing, using a provider-appropriate limit. Treat invalid or oversized JSON as a stable upstream error and preserve partial thread coverage.

### Medium — Plain conversions reserve the default 100-credit budget despite having a known smaller maximum

Every authenticated cache miss calls `reserveConversion(..., req.maxCredits ?? 100)` at `src/convert/service.ts:112`. For a non-X conversion with neither comments nor image analysis, the only possible charge is the known base cost, yet the reservation temporarily consumes up to 100 credits in `CHARGES_SQL`. A free-plan account with 100 credits remaining can therefore have a one-credit web conversion reserve all remaining allowance and make a concurrent one-credit conversion fail with `quota_exceeded`.

The single-statement allowance recheck in `src/lib/conversion-budget.ts:20-23` is atomic and prevents overspend; the problem is the unnecessarily broad reservation supplied to it. Derive the maximum possible charge from the selected adapter and enabled enrichments, or reserve additional units atomically as paid work is scheduled.

## Verified Boundaries

- The D1 reservation insert rechecks non-overage allowance in the same write statement and settled charges are excluded from usage telemetry totals by trace ID. No duplicate-counting defect was found in that SQL path.
- Image URLs and every redirect location pass through `normalizeTargetUrl`; redirects are manual and RapidAPI/OpenRouter credentialed calls reject redirects. No direct credential-forwarding SSRF path was found in the reviewed code.
- X membership requires matching author ID and conversation ID plus a parent already in the rooted chain. It does not infer membership from author alone.
- Thread and image credits are charged after a successful returned unit; comment batches are charged when the first retained comment in each 20-comment batch is accepted.

## Verification Gaps

- No focused tests currently exercise atomic concurrent reservations, failure after settlement, call-cap exhaustion, redirect chains, failed member fetches, or partial-unit charging.
- The plan only records a successful `/tweet.php` probe. It does not establish the live `/search.php` pagination shape or filter semantics used by `x-thread.ts`. Parser field correctness should remain unclaimed until sanitized live fixtures cover first/middle/last thread entry, cursors, malformed rows, and nested comments; this review does not infer an alternative provider schema.

## Recommended Order

1. Move/fix settlement lifecycle so an error response cannot retain a charge.
2. Centralize outbound-attempt accounting and apply it before every network request.
3. Bound FxTwitter response bodies.
4. Narrow reservations for requests whose maximum charge is already known.
5. Add focused D1 and enrichment tests before broader suite/build verification.

## Unresolved Questions

- Does product policy intentionally allow a successful conversion to be returned when library persistence fails? The current code returns an error, so the billing path must follow that observable contract unless the save behavior is changed.
- What exact sanitized `/search.php` response and cursor contract was observed from the subscribed provider?
