# Delivery

Read docs/architecture.md, docs/operations.md and REVIEW.md; reuse the accepted advisory design.

Implement changes in src/convert, billing/plans, lib/usage, library/store and additive migrations. Update channel callers, browser controls, OpenAPI and existing public docs. Existing content markdown changes are explicitly requested public-contract work; new planning records stay in plans/.

Bound requests, pages, comments and images. Preserve upstream relationship IDs; never infer thread membership from author alone. Source completeness must reflect provider evidence and budget/timeout truncation. Use optional integrations with truthful unavailable errors, not fabricated data or silent success.

Verify live schemas before implementing provider parsers. New provider subscription availability is an external prerequisite for claiming all sources work. Public data only. Keep keys inside processes and never log values or credentialed requests.

Credit reservation must be atomic across concurrent requests, released on failure, settled exactly once, and distinct from background telemetry. Cache hits are free. Preserve enrichment in the per-user library with timestamps and explicit coverage.

Validation: focused semantic unit tests, actual D1 accounting tests where possible, all current test suites, typecheck/build, live provider probes, authenticated staging conversion, UI 375/768/1440, production revision and smoke tests. Back up each database before migrations. Keep migrations additive and record previous Worker version for rollback.

Do not ship until verified. On unavailable external credentials/subscriptions, complete independent implementation and record exact remaining requirements; never label untested adapters as operational.
