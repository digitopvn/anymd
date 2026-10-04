# Social conversion enrichment

Status: implementation complete; stable publication in progress. Accepted design: full same-author X threads from any member; four new public social adapters; opt-in raw comments (100 total by default), and Qwen OCR/descriptions of article images; fixed unit credits, request budget, free cache hits; preserve library enrichment.

## Phases
1. Verify provider contracts and subscriptions; keep RapidAPI base subscriptions within $100/month.
2. Add bounded extraction, enrichment, cost accounting, cache and library preservation.
3. Expose options consistently in web, URL API, REST, CLI, MCP and WebMCP; document contracts.
4. Independent verification/review, staging verification, stable merge and production deployment.

Execution detail: [phase-01-delivery.md](phase-01-delivery.md).

## Acceptance
- Real provider responses validate full thread traversal, media and nested comments.
- No paid work above maxCredits, no duplicate billing, no anonymous paid enrichment.
- Partial data is explicit; failed units are free; cache variants remain isolated.
- Plain conversions do not erase saved enrichment.
- Typecheck, unit/CLI tests, build and responsive/live checks pass before stable shipping.

## Dependencies / evidence
- Existing local environment has RapidAPI, OpenRouter and Cloudflare credentials (values never logged).
- Twitter API45 tweet endpoint returned 200 on 2026-10-04.
- Instagram Cheapest, Threads API Pro and Fresh LinkedIn Data probes returned 403 not subscribed.
- Stable target is main per CI and operations; GitHub default dev is staging.
- User explicitly authorized ship stable and deploy, including necessary verification.

## Delivery evidence

Phases 1–3 are complete. Phase 4 has independent review, local gates and authenticated staging evidence; merge CI, production smoke and CLI publication follow the PR. See [release evidence](reports/release-evidence.md) and [final review](../reports/code-reviewer-261004-final.md). Provider failures produce explicit partial coverage; Instagram nested replies remain subject to provider `upstream_blocked` responses, including after the paid upgrade.
