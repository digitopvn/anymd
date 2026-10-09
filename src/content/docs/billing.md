---
title: "Billing & credits"
description: "How anymd credits work, what each source costs, plans, overage, offers, and how checkout and the customer portal work."
updated: "2026-10-09"
---

anymd bills in **credits**, and you pay when your agents learn something new. Processing a new source uses credits by its complexity (one credit is one web page); reusing what your agents already know is free: cached reads, library search and MCP recall cost nothing.

## What things cost

| Action | Credits |
|---|---|
| Web page, GitHub, Reddit, Hacker News, X post | 1 |
| Facebook, Instagram, Threads or LinkedIn post | 10 |
| Each additional X thread post | 1 |
| Each started batch of 20 comments or replies | 10 |
| Each successfully analyzed article image | 5 |
| YouTube video with transcript | 3 |
| PDF, DOCX, XLSX, CSV and other documents (per file) | 3 |
| Image (vision description) | 5 |
| Library search, reads, MCP reads | 0 |
| Cached result | 0 |
| Failed conversion | 0 |

Every conversion response tells you what it cost in the `X-Anymd-Credits` header. `fresh=1` skips the cache, so it is charged like a new conversion.

## Deep reading

Thread expansion, comments and article-image analysis can spend credits beyond the base price, so they are **off by default** and run only when you opt in: on a single request, or as a saved default in [Account → Deep reading defaults](/dashboard/account#reading-defaults) (also `PUT /api/v1/account/reading-preferences` and `anymd prefs set`). Signing in never turns them on. One rule decides each option: **request option > your saved default > safe default (off)**. A one-time change in the converter or on a request does not change your saved defaults.

| Option | Default | Bounds | Credits |
|---|---|---|---|
| Keep image/media URLs (`images`, `keepImages`) | On | | 0 |
| Expand X threads (`expandThread`) | Off | `maxThreadPosts` 1–100, default 20 | 1 per additional post |
| Comments & replies (`includeComments`) | Off | `maxComments` 1–1,000, default 100 | 10 per started batch of 20 |
| Read text & details in images (`analyzeImages`) | Off | `maxImages` 1–20, default 10 | 5 per analyzed image |
| Max credits per conversion (`maxCredits`) | 100 | 1–1,000 | Cap including the base price |

The worst case is bounded before you convert: for example, threads up to 20 posts add at most 19 credits, and 10 analyzed images add at most 50, always capped by `maxCredits`. Saved defaults never raise your plan's allowance, and a request's own `maxCredits` wins over the saved one. Each response's `credit_breakdown` (`base`, `thread`, `comments`, `images`) and the trace in **Dashboard → Traces** show which enrichment produced a charge and whether it came from the request, your saved default or the safe default.

> Until October 2026, signed-in X conversions expanded same-author threads automatically. They now return the single requested post unless thread expansion is enabled.

`maxCredits` defaults to 100 and accepts 1–1,000; `maxThreadPosts` defaults to 20 and accepts 1–100; `maxComments` defaults to 100 and accepts 1–1,000; `maxImages` defaults to 10 and accepts 1–20. A request is bounded at 40 provider calls and 55 seconds. Successful returned units consume credits; failed or unavailable units do not. Partial sections are reported in the response's `enrichment` coverage instead of being charged as complete.

## Plans

| Plan | Price | Credits / month | Beyond included credits |
|---|---|---|---|
| Free | $0 | 500 | Hard stop until next month |
| Pro | $9/mo, or $7/mo billed yearly | 10,000 | $1 per extra 1,000 |
| Scale | $49/mo, or $39/mo billed yearly | 100,000 | $0.60 per extra 1,000 |
| Enterprise | Custom | Custom volume | $0.40 per 1,000 |

The [pricing page](/pricing) is always current and lists each plan's extras (library size, key limits, support).

- **Free** keeps working for search and reads after credits run out; new conversions return `402 quota_exceeded` until the next month.
- **Pro and Scale** never block: usage beyond the included credits is metered and billed as overage. Credits granted by support are used after the included credits and before overage, and are never billed.
- Credits reset at the start of each calendar month (UTC).

### No account?

Anonymous use of the [URL API](/docs/url) is free up to 50 conversions per day per IP. Nothing is saved.

## Offers

| Code | Discount | Who and when |
|---|---|---|
| `LAUNCH30` | 30% off | Launch offer, until 2026-10-31 |
| `COMEBACK20` | 20% off | Returning visitors, valid for 48 hours after it's shown |

Enter the code at checkout.

## Checkout and managing your plan

Payments are handled by [Polar.sh](https://polar.sh), our merchant of record. Polar collects the payment and handles sales tax and VAT.

- **Upgrade:** from the [pricing page](/pricing) or your dashboard, or `POST /api/v1/billing/checkout` with `{ "plan": "pro" | "scale", "interval": "month" | "year" }`. The response is `{ url }`; open it to pay.
- **Manage, change or cancel:** from your dashboard, or `POST /api/v1/billing/portal`, which returns `{ url }` for the Polar customer portal (payment method, invoices, cancellation). It works once you have paid for a plan.

Both endpoints need a signed-in browser session. API keys can't start a checkout.

## Watching usage

- Your dashboard shows credits used and remaining, per-day totals and every request.
- `GET /api/v1/usage?days=30` returns `{ plan, quota, totals, daily, events }` (scope `usage:read`).
- `anymd usage` prints the same from the [CLI](/docs/cli); MCP has `usage_summary`.

## Questions

Billing questions and Enterprise quotes: [hello@digitop.ai](mailto:hello@digitop.ai). Refunds follow the [refund policy](/legal/refund).
