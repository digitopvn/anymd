# Re-review: MCP Events review fixes

Reviewed commit 277de7d against 6a004f3, in an isolated subagent. Nothing was blocking. Every fix was confirmed correct; the `changes()` guard and the per-subscription cap were checked against real SQLite with migration 0013.

## Should-fix items and how they were handled

- **The backlog-cap COUNT used the `(status, next_attempt_at)` index and scanned every pending delivery.**
  - Added `event_deliveries_subscription_status` on `(subscription_id, status)` to migration 0013. The migration is not applied anywhere yet, so it was edited in place.
- **The claim lease used the batch start time, so a long run could double-send.**
  - The lease is now `Date.now() + CLAIM_MS` at claim time.
- **Scheduled delivery ran in `waitUntil` after the handler returned.**
  - The handler now awaits all its tasks, so the 45 s budget falls under the scheduled wall-time limit.
- **An outage of our own DNS-over-HTTPS resolver spent attempts, then suspended subscriptions and dead-lettered their backlogs.**
  - Added the `resolver_unavailable` reason. A deferred delivery gives its attempt back and waits a minute. The subscription is not touched.
- **Test gaps.**
  - Added tests for:
    - the 500 cap per subscription;
    - an outbox with only a suspended subscription;
    - a resolver outage.
  - The deadline is still untested: it is a wall-clock guard, and fake timers would have to drive D1 calls.
- **The catalog's `tags` description contradicted the docs.**
  - Aligned with `mcp.md`.

## Nits

- **Fixed:**
  - The loop exit now counts events, not deliveries.
  - The backlog log is reworded.
  - Every trailing dot is stripped.
  - The operations budget wording is corrected.
  - The migration comment is corrected.
- **Accepted:**
  - The ordering of a second `changed`-guarded event. No caller relies on it, and it is commented.
  - Health fields that stay stale after a refresh. This predates the change; delivery state is reset on the next success.

## Open question

- `changes()` carry-over inside a batch is verified on SQLite and on local workerd D1. Remote D1 runs the batch as one SQLite transaction on one connection, so the same semantics are expected. It is checked on staging after the merge.
