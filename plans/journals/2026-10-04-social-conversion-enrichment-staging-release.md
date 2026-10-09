---
title: Social conversion enrichment staging release
date: 2026-10-04
summary: "Local gates pass and staging enrichment is verified, but provider comment gaps and production release actions remain open."
---

# Social conversion enrichment staging release

**Date**: 2026-10-04 14:46
**Severity**: Medium
**Component**: Social conversion enrichment, staging release verification
**Status**: Ongoing

## What Happened

The social conversion enrichment work reached a staging candidate after implementing full same-author X thread traversal, four RapidAPI social sources, opt-in raw comments, Qwen3.6 35B-A3B image OCR/descriptions, atomic credit reservations, free cache hits, partial-failure accounting, and library preservation across all channels. Local validation finished cleanly: 108 Worker tests, 41 CLI tests, typecheck, build, and diff checks passed.

The first authenticated staging pass exposed a real deployment defect: Workers rejected redirects. The redirect handling was fixed manually and covered with tests. A transient Instagram upstream timeout later recovered. Staging evidence then showed X seven-member traversal at seven credits with zero cache cost and capped partial behavior; Facebook returned five comments at twenty credits; LinkedIn returned five comments at twenty credits; Instagram OCR cost fifteen credits; the base cap was 402 and contradiction handling returned 400. Anonymous requests correctly returned 401. Plain refresh preserved saved enrichment. Responsive checks at 375, 768, and 1440 pixels had no overflow.

## The Brutal Truth

This was exhausting because the implementation was locally green while the real release still depended on providers behaving consistently. The redirect failure was exactly the kind of operational edge case that gets missed when tests stop at mocked or fixture responses. The relief from the recovered Instagram pass is tempered by the fact that Threads detail works while its comments endpoint still fails upstream, so the most visible “all sources” claim remains unfinished.

## Technical Details

X cost 7, cache cost 0, cap 2 partial; Facebook 5 comments/20 credits; LinkedIn 5 comments/20 credits; Instagram OCR 1 image/15 credits. Threads comments are represented as free partial failure. No production deploy or merge has happened.

## What We Tried

We validated provider schemas, added bounded traversal and explicit incomplete coverage, fixed redirect rejection, reran focused tests, and repeated authenticated staging checks. We kept failed units free and preserved library enrichment instead of discarding partial results.

## Root Cause Analysis

The redirect issue came from a staging Worker behavior mismatch that was not caught before live verification. Provider comment failures are external upstream availability problems, not parser success. The larger release risk is treating local correctness as evidence of provider completeness.

## Lessons Learned

Live provider probes and authenticated staging must remain separate gates. Cache, credit settlement, and partial coverage need evidence from real requests. Never label provider comments fully operational while the upstream endpoint returns errors.

## Next Steps

Recheck Instagram and Threads comment providers, investigate alternate Threads comment sources, rerun the relevant gates after any source changes, then obtain the authorized production backup, migration, deploy, smoke test, and merge sequence. The owner of the ship workflow should record the final provider receipts before claiming completion.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

## Release follow-up, 2026-10-04

Replaced the failing Threads provider with API4 and verified real nested replies. Activated four paid social subscriptions totaling $47.97/month. Instagram single-photo conversion now uses the verified detail response's full image URL, avoiding a redundant media request that intermittently times out; carousel/video still use the media endpoint. Instagram comments also passed live verification after a transient upstream failure, with failed comment units uncharged. The final candidate's eleven conversion scenarios passed across the full and focused staging runs; provider pagination limits remain explicit. Production D1 and Worker recovery points and a backup of the current CLI artifact were recorded before publication. See the release-evidence report for exact versions and limitations; production completion will be recorded on the PR.
