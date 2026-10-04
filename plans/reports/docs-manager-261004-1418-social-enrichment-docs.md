# Documentation update report

## Scope

Updated the smallest owning surfaces for the social conversion enrichment contract. No product code, migrations, remote database, provider subscription, or deployment was changed by this documentation pass.

## Authority surfaces changed

- `docs/architecture.md`: points to enrichment owners, records the signed-in X and social-account boundaries, and documents optional provider degradation and the exact image model.
- `docs/operations.md`: corrects production billing to Polar, records the additive `0005` migration and the required D1 recovery point before remote migrations, and names the social/model prerequisites without recording secret values.
- `src/content/site.ts`: exposes Facebook, Instagram, Threads and LinkedIn as current source metadata and removes them from the planned list.
- `src/content/docs/url.md`, `api.md`, `cli.md`, `mcp.md`, `webmcp.md`: documents the shared options, authenticated opt-ins, anonymous basic X behavior, automatic signed-in X same-author thread expansion, cache-free reads, library enrichment preservation, credit breakdown, bounds and partial coverage.
- `src/content/docs/sources.md`: documents the four new source kinds, public-source restrictions, base and enrichment costs, and current provider behavior without claiming full operational verification.
- `src/content/docs/billing.md`: records the social/enrichment unit prices and `maxCredits`, item, call and time bounds.
- `src/content/docs/self-host.md`: documents `RAPIDAPI_KEY`, `OPENROUTER_API_KEY`, and the exact Qwen model used for image analysis.
- `cli/README.md`: documents the distributed CLI's enrichment flags, bounds, authentication requirements and partial-result fields while preserving the CDN install route.
- `docs/operations.md`: adds the minimally scoped CLI artifact route: `npm pack cli`, backup of the existing `latest` R2 object via remote GET, versioned/latest gzip uploads, and SHA-256 verification of the immutable artifact. It explicitly records that no publication is implied.

## Evidence class

- Source-backed: option bounds, unit prices, cache behavior, library merge behavior, adapter account checks, source kinds, provider host ownership, call/deadline bounds, secret names and model name were checked in current source.
- Live evidence supplied for this task: X seven-post traversal, Facebook post/comments, Instagram post/media/OCR, Threads API4 post/carousel and 17 comments including nested replies in three calls, and LinkedIn Fresh Data post/comments passed. Instagram chronological comments can time out and fall back to a 13-comment popular subset; reply requests returned 429. Threads can report `has_next_page: true` with a null cursor, which is documented as `source_incomplete`; the prior broken V2/`SCRAPER_ERROR` wording was removed.
- Provider planning evidence: Threads API4 offers a free tier of 50 requests and a Pro tier at $19.99 for 20,000+ requests with a $0.0035 rate and 3 requests/second; no paid provider subscription has been purchased.
- Operational route evidence: staging D1 full export is unsuitable because the database contains FTS5 virtual tables; the retained runbook requirement is `npx wrangler d1 time-travel info <database> --env <environment>` (or an equivalent recoverable backup) before remote additive migrations. Production was not touched.

## Validation

- `npm run typecheck` passed.
- `npm run build` passed (CSS and client bundles).
- `node cli/bin/anymd.mjs --help` showed all five documented enrichment flags and bounds.
- Reviewed modified Markdown for current option names, source kinds, links and provider caveats.
- The broader Vitest/CLI suites were not claimed as part of this docs-only refresh; the release verification pass should use the latest Threads API4 code and tests.
- No CLI artifact was uploaded or overwritten during this documentation pass.

## Unresolved questions

- The external social-provider subscriptions and production deployment remain release gates; the docs intentionally contain no shipping claim.
- Provider comment availability may change and should be rechecked during the release verification pass.
- At initial report time no paid provider subscriptions had been purchased. Release-controller follow-up: all four social subscriptions are now confirmed, totaling $47.97/month; see `plans/261004-1326-social-conversion/reports/release-evidence.md`. Subscription activation and live test responses do not establish production deployment.

Status: DONE_WITH_CONCERNS
