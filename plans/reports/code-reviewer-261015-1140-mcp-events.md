# Code review: MCP Events (commit 591828d vs 57516ac)

## Scope
- Commit `591828d feat(mcp-events): owner-scoped webhook event subscriptions` (30 files, +2240/-90). I reviewed the commit, not the working tree, because the working tree was being merged with dev. The `src/events/*` content is identical to the pre-commit tree, so the line numbers below are valid for `591828d`.
- Focus: security (SSRF, authz, secrets, signatures), atomicity and idempotency, write-path regressions, D1 compatibility, hot-path cost, and whether the docs match the code.
- Checks run on a detached worktree of 591828d (since removed): `tsc --noEmit` passes, and `vitest run` passes (29 files, 448 tests).
- Local D1 check (workerd through wrangler `getPlatformProxy`, no remote): the outbox guard `INSERT ... SELECT ... WHERE changes() > 0` inside `DB.batch`:
  - Inserts when the UPDATE matched a row.
  - Inserts nothing when the UPDATE matched no row, when `ON CONFLICT DO NOTHING` hit a conflict, and when a DELETE removed no row.
  - Still inserts when the UPDATE fires an FTS trigger.
  - Remote D1 was not exercised.

## Overall
- Authorization, cross-owner isolation, Standard Webhooks signing, encryption of stored callback secrets, the no-redirect policy and the era routing are correct. Tests cover these.
- One blocking defect is in fan-out and backlog accounting.
- Hot-path cost is higher than the code comment claims.
- Several smaller robustness gaps and doc mismatches.

## Blocking

### B1. A suspended subscription starves the owner's other subscriptions, then replays old events (High)
- **Where:**
  - `src/events/delivery.ts:244`: the fan-out query has no `active = 1` filter.
  - `delivery.ts:250-251`: the backlog cap counts **all** pending deliveries per user.
  - `delivery.ts:279`: `deliverDue` only sends for `s.active = 1`.
  - `delivery.ts:344`: prune never removes `pending` rows.
- **Scenario:**
  1. The owner has subscriptions A (endpoint down) and B (healthy).
  2. A dead-letters and is suspended (`active = 0`). Fan-out keeps creating `pending` rows for A, which are never sent and never pruned while A is live (up to 24h TTL plus a day).
  3. After 500 events, `room = 0` for the owner, so B silently stops receiving anything. The only trace is a `console.warn('events backlog full')`, and this lasts until A expires and is pruned.
  4. If the client refreshes A, every queued old event (up to 500, possibly hours old) floods A. That contradicts the doc's "No replay. Events start from the moment you subscribe" (`src/content/docs/mcp.md`, Subscribe section).
- **Fix:**
  - Add `AND active = 1` to the fan-out subscription query.
  - When a delivery goes `dead` and suspends the subscription, move that subscription's other `pending` rows to `dead`/`failed` in the same batch.
  - Compute the backlog per subscription (`WHERE subscription_id = ? AND status = 'pending'`), or exclude inactive subscriptions from the count, so one bad endpoint cannot block the others.
  - Add a test: suspend A, write 501 events, assert B still receives.

## High (should fix, not blocking)

### H1. Every write by every user pays an extra D1 read once `EVENTS_SECRET_KEY` is set; the code comment says otherwise
- **Where:**
  - `src/events/outbox.ts:76`: `subscribedNames` runs before every write whether or not the owner subscribes.
  - The header comment at `outbox.ts:3-5` ("costs one indexed read per write only for subscribed owners") is false.
  - `src/library/store.ts` `updateTags` now always runs `SELECT tags ...` before the UPDATE, **even when events are disabled**. That is a regression for `PATCH /library/:id` independent of the feature.
- **Scenario:** with the key set, every `saveDocument`, tag edit, delete, video transition and feedback state change does two sequential D1 round trips instead of one, for all users including those with no subscription. The pre-read is also a check-then-act gap: a subscription created between the read and the write misses that event.
- **Fix:**
  - Drop the pre-read and always send `[write, guardedInsert]` as one `DB.batch` (one round trip).
  - Put the subscription check inside the guarded insert: `... SELECT ... WHERE changes() > 0 AND EXISTS (SELECT 1 FROM event_subscriptions WHERE user_id = ? AND name = ? AND expires_at > ?)`. When the key is unset, keep `write.run()`.
  - In `updateTags`, only do the pre-read when `eventsEnabled(env)`.
  - Correct the comment.

## Medium

### M1. Delivery triggered from a request burns retry attempts and can dead-letter early
- **Where:** `outbox.ts:83` starts `processEvents(env, { userId })` in the request's `waitUntil`. `delivery.ts:288` claims by incrementing `attempts` before the POST, and the loop is serial: up to 50 deliveries, each with two lookups of up to 5 s to the DNS resolver (DNS-over-HTTPS) and a POST of up to 10 s.
- **Scenario:**
  1. A slow endpoint (around 10 s) plus a few due deliveries goes past the roughly 30 s `waitUntil` budget after the response.
  2. The runtime cancels mid-loop. Claimed rows keep `attempts + 1` with no POST and no `last_error`.
  3. The next runs treat those as used attempts, so `attempts >= MAX_ATTEMPTS` arrives early: the row goes `dead` and the subscription is suspended (which then triggers B1).
- **Fix:** from request context, only fan out and deliver a small, time-boxed batch (for example 5 deliveries or about 20 s), and leave the rest to cron. Alternatively, claim without incrementing `attempts` (lease via `next_attempt_at` only) and increment when the attempt result is recorded.

### M2. The verification rate limit is shared across tenants per host
- **Where:** `src/events/subscriptions.ts:120`, key `events:verify:${url.hostname}` on `RL_MCP_MUTATION` (30/min).
- **Scenario:** any account can exhaust the bucket for a shared receiver host (for example a webhook relay SaaS hostname). Other users' first subscribes to that host then fail with `-32013` for the window.
- **Fix:** key by `${userId}:${hostname}` (and optionally add a looser global per-host bucket).

### M3. Cron throughput ceiling and no fairness between owners; events can be lost under load
- **Where:** `delivery.ts:29-30` (100 events and 50 deliveries per run, platform-wide), `delivery.ts:281-282` (`ORDER BY next_attempt_at` with no per-owner fairness), `delivery.ts:345` (undispatched outbox rows older than a day are deleted).
- **Scenario:**
  - One owner's 500-row backlog against a 10 s-timeout endpoint fills each minute's 50-delivery budget, delaying everyone else.
  - Writes without a request context (feedback `setState`, which never passes `ctx`) rely on cron entirely.
  - Sustained volume above 100 events a minute grows the outbox until rows older than a day are pruned undelivered.
- **Fix:** loop fan-out and delivery until a time budget is spent rather than a fixed count, cap deliveries per owner per run, and alert on outbox lag.

### M4. Docs vs code: feedback `needs_review` at submission emits no event
- **Where:** `src/services/feedback.ts` `submitFeedback` inserts with status `needs_review` directly (the `INSERT OR IGNORE ... status` path), and events are only emitted from `setState`.
- **Scenario:** a report held for review at submit time never produces `anymd.feedback.status.changed`. The catalog and `mcp.md` say the event fires when feedback "reached ... `needs_review`".
- **Fix:** emit in the same batch as the insert (with a stable id `(name, id, 'needs_review')`), or change the doc to "after submission".

## Low / optional

- **L1. Trailing dot bypasses the own-host check** (`src/events/callback-url.ts:222,233`). Verified: `https://anymd.cc./mcp` and `https://www.anymd.cc./x` pass `parseCallbackUrl`, and the host resolves to public Cloudflare IPs, so anymd will POST verification and terminated envelopes to its own endpoints. The payload is fixed and the impact is low. The same issue lets `localhost.` and `*.local.` reach DNS (which then refuses them). Fix: strip one trailing `.` from `host` before the suffix and own-host checks.
- **L2. `410 Gone` does not end the subscription** (`delivery.ts:163,314`). Every later event creates another `failed` row and the subscription stays "active". Fix: on 410, terminate the subscription (or suspend it).
- **L3. Doc wording for filters.** The `tags`/`domain` filters are evaluated at fan-out, not "when the event is delivered" (`delivery.ts:248`, `mcp.md` and `catalog.ts:28`). Say "when the event is processed".
- **L4. Stable event ids plus the 30-day prune** (`delivery.ts:345`). After a prune, the same deterministic id can be inserted again, for example feedback `failed` → `pending_retry` → `failed` a month later. Receivers that dedupe on `webhook-id` with longer retention would drop it. Acceptable; document it or include the transition timestamp for feedback.
- **L5. `changes()` carries over from earlier statements** (verified locally: a batch `[SELECT 1, guardedInsert]` inserted because of an earlier, unrelated UPDATE). `writeWithEvents` is safe today because the write is always a DML statement placed first. However, a second `changed` event after an ignored `INSERT OR IGNORE` would be silently dropped, and a future non-DML `write` would fire spuriously. Add a comment or assertion documenting this. The comment at `outbox.ts:79` does not say this.
- **L6. `emitted` can be true when nothing was inserted** (`outbox.ts:82`). In local D1, `meta.changes` includes rows written by triggers (an UPDATE with an FTS trigger reported 4, and the following insert reported 5), so `emitted` may be true without an insert. The only effect is an extra kick; harmless.
- **L7. OAuth revocation does not see per-token scope narrowing** (`delivery.ts:202-206`). It checks `grant.scope` only; grant revocation and role loss are still enforced. Acceptable.
- **L8.** A `410` or 3xx answer to the verification POST maps to a generic error code. Fine.

## Verified as correct (where the risk is real)
- **Authorization:**
  - `events/*` only in the modern era with a key or OAuth principal (`server.ts:454`); session principals get `-32601`.
  - The scope is checked against the subscribing credential (`subscriptions.ts:49`) and re-checked before each delivery, including key revocation, expiry, narrowing via `capScopes`, a missing grant in KV (`grant:<user>:<grant>`, which matches the provider's layout), role loss and account suspension. This mirrors `principalFromApiKey`.
  - Unsubscribe is scoped by `user_id` and `principal`. The dashboard delete is scoped by `user_id` and sits behind `requireUserPage` and `sameOriginWrites` (`dashboard.tsx:49`).
  - Subscribe and unsubscribe count toward the mutation rate limit.
- **Cross-owner isolation:** outbox `user_id` comes from the resource row, fan-out matches `user_id`, and `deliverDue` joins on the subscription.
- **Secrets:** the callback secret is AES-GCM encrypted under an HKDF-derived key, and is not logged or rendered (the dashboard strips the query string). `grantIdOf` matches the `userId:grantId:secret` token format.
- **Signatures:** `v1,` HMAC-SHA256 over `id.ts.body` with the base64-decoded `whsec_` key, matching Standard Webhooks. The doc snippet is correct.
- **SSRF:** https only, no credentials; IPv4 special ranges, IPv6 restricted to global unicast minus 2001::/23, 2002::/16 and documentation ranges; NAT64 and v4-mapped addresses judged by their IPv4 part; DNS-over-HTTPS check before every POST; `redirect: 'manual'`; 10 s timeout; 4 KiB read cap; `global_fetch_strictly_public` is set in `wrangler.jsonc`.
- **Claim race:** the compare-and-set on `(status = 'pending', attempts = n)` prevents double sends between overlapping runs, and `UNIQUE(subscription_id, event_id)` plus `INSERT OR IGNORE` deduplicate concurrent fan-out.
- **Write paths:**
  - Video ready/failed and analysis ready/failed use deterministic ids, so a re-run of a queue message emits once.
  - Return values of `editTags`, `updateTags`, `deleteDocument` and `saveDocument` keep their old semantics, and the `saveDocument` positional `attempt` parameter moved correctly (callers updated).
  - The scheduled handler gates the other jobs on `getUTCMinutes() % 10`.
- **D1 compatibility:**
  - Uses `INSERT ... SELECT ... WHERE changes()`, `INSERT OR IGNORE`, `ON CONFLICT DO UPDATE`, `AUTOINCREMENT` and FK cascades; all are supported.
  - The migration is additive and safe for the previous Worker.

## Recommended actions (priority order)
1. B1: filter out inactive subscriptions in fan-out, clear the pending rows of a suspended subscription, and use a per-subscription backlog cap. Add a regression test.
2. H1: move the subscription check into the batched insert, gate the `updateTags` pre-read on `eventsEnabled`, and fix the comment.
3. M1: time-box delivery started from a request, or stop counting a claim as an attempt.
4. M2: per-user verification rate-limit key.
5. M4: emit or document feedback `needs_review` at submission.
6. L1 and L2: trailing-dot normalization, and terminate on 410.
7. Before production: test the batch `changes()` guard against staging D1 with explicit user approval (only local workerd was verified here).

## Metrics
- Typecheck: 0 errors. Tests: 448/448 pass. Lint: no lint script in `package.json`.
- New-code test coverage looks good. Missing tests: overlapping delivery runs, backlog starvation with a suspended subscription, and a `waitUntil` cut-off mid-loop.

## Unresolved questions
- Is 410 meant to suspend or terminate the subscription under the MCP Events draft?
- Should owners get a terminated notice when their account is deleted? Today the FK cascade drops subscriptions silently.
