# Social conversion release evidence

Date: 2026-10-04. Candidate: 0.1.1, branch `codex/social-conversion-enrichment`, stable target `main`.

## Provider provisioning

RapidAPI checkout confirmed all four subscriptions as upgraded successfully:

| Provider | Plan | Monthly base fee |
|---|---|---:|
| Facebook Scraper | Pro | $4.99 |
| Instagram Pro and Cheap API | Pro | $12.99 |
| Threads API (API4) | Pro | $19.99 |
| Fresh LinkedIn Profile Data | Basic | $10.00 |

New recurring base fees total $47.97/month; checkout tax was zero. This excludes existing subscriptions, provider overages and OpenRouter usage. Existing subscriptions were not cancelled. The user authorized the RapidAPI provisioning budget of $100/month.

The initially investigated Threads API Pro and V2 endpoints were unreliable in live probes. API4 returned real post data and nested replies. One sample returned 17 comments through three requests but advertised another page with a null cursor; the adapter truthfully reports `source_incomplete`.

Instagram's media endpoint intermittently returned 408 after about 15 seconds even on the paid plan. For explicit single-photo responses, the detail endpoint supplies the full `display_url`; the adapter uses that normalized image directly. Other media types still use the complete media endpoint, avoiding accidental carousel truncation.

## Recovery points

- Staging D1 pre-migration bookmark: `000000d9-00000000-000050fa-fed7053023d7b351742ba0506a8950b0`.
- Staging previous Worker: `9d766f45-8532-4b46-b0eb-e751f4ee7fda`.
- Production D1 pre-migration bookmark: `00000560-00000000-000050fa-c2a964833c5cc11937b66907f26b4562`.
- Production previous Worker: `0c475dcc-1cd3-4854-8c85-83137a3aff1d`.
- Existing CLI CDN artifact downloaded before replacement to the local temporary file `anymd-cli-before-0.1.1.tgz`.

The migration is additive. Worker rollback does not require reversing the schema. D1 full export is unsupported for this database's FTS5 virtual tables; Time Travel is the verified recovery route.

## Verification before publication

- Independent tester: final typecheck, 122 Vitest tests, 41 CLI tests and build passed. The final suite includes photo/carousel routing and both CMS block-ID regression tests; 163/163 tests passed.
- Independent reviewer: no blocking findings; atomic accounting, public-URL guards, incomplete coverage and saved-enrichment preservation reviewed.
- Responsive browser verification at 375, 768 and 1440 pixels: no horizontal overflow; reading options and anonymous enrichment error verified. Screenshots were displayed in the Codex session; persistent screenshot export was unavailable through the browser API.
- Authenticated staging on Worker `713d28ec-1ff7-4a34-b406-15aa99f691f3`: ten conversion cases passed, 94 credits, zero unsettled reservations; temporary verification account/documents removed.
- Updated staging Worker `2e692e36-57a1-49ef-9221-b30229a3301d` includes the single-photo optimization. The release script now additionally checks Instagram comments.
- All eleven conversion scenarios passed on that Worker across two runs: the initial run passed X, Facebook, LinkedIn and Instagram OCR but correctly failed the smoke assertion when the Instagram comment provider timed out with zero charged comment units; a focused rerun passed Instagram OCR/comments, Threads comments and both validation errors (55 credits, no unsettled reservations). A direct provider probe confirmed the recent-comments timeout and a successful 13-comment popular response. This transient provider limitation is not hidden by the tests.

Production deployment and CLI publication are pending at the time this pre-merge record is written. Their actual revisions and smoke results belong in the PR completion comment after deployment.

The paid Instagram reply endpoint still returned 429 `upstream_blocked` in the final direct probe. Base posts, OCR and top-level comments passed; no claim of complete Instagram reply coverage is made. Full verification also exposed an existing CMS collision caused by truncating almost all random ID entropy. Both insertion and recursive cloning now preserve the full existing ID format in a separate focused fix.
