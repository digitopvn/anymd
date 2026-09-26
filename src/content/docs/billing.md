---
title: "Billing & credits"
description: "How anymd credits work, what each source costs, plans, limits, offers, and how checkout and the customer portal work."
updated: "2026-09-26"
---

anymd bills in **credits**, and you pay when your agents learn something new. Processing a new source uses credits by its complexity (one credit is one web page); reusing what your agents already know is free: cached reads, library search and MCP recall cost nothing.

## What things cost

| Action | Credits |
|---|---|
| Web page, GitHub, Reddit, Hacker News, X post | 1 |
| YouTube video with transcript | 3 |
| PDF, DOCX, XLSX, CSV and other documents (per file) | 3 |
| Image (vision description) | 5 |
| Library search, reads, MCP reads | 0 |
| Cached result | 0 |
| Failed conversion | 0 |

Every conversion response tells you what it cost in the `X-Anymd-Credits` header. `fresh=1` skips the cache, so it is charged like a new conversion.

## Plans

| Plan | Price | Credits / month | Beyond included credits |
|---|---|---|---|
| Free | $0 | 500 | Hard stop until next month |
| Pro | $9/mo, or $7/mo billed yearly | 10,000 | Pauses until next month, or upgrade |
| Scale | $49/mo, or $39/mo billed yearly | 100,000 | Pauses until next month, or move to Enterprise |
| Enterprise | Custom | Custom volume | $0.40 per 1,000 |

The [pricing page](/pricing) is always current and lists each plan's extras (library size, key limits, support).

- Every plan keeps working for search and reads after credits run out; new conversions return `402 quota_exceeded` until the next month.
- Upgrading takes effect as soon as the payment goes through, so you can raise the limit mid-month.
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

Payments are handled by [Creem](https://creem.io), our merchant of record. Creem collects the payment and handles sales tax and VAT.

- **Upgrade:** from the [pricing page](/pricing) or your dashboard, or `POST /api/v1/billing/checkout` with `{ "plan": "pro" | "scale", "interval": "month" | "year" }`. The response is `{ url }`; open it to pay.
- **Manage, change or cancel:** from your dashboard, or `POST /api/v1/billing/portal`, which returns `{ url }` for the Creem customer portal (payment method, invoices, cancellation). It works once you have paid for a plan.

Both endpoints need a signed-in browser session. API keys can't start a checkout.

## Watching usage

- Your dashboard shows credits used and remaining, per-day totals and every request.
- `GET /api/v1/usage?days=30` returns `{ plan, quota, totals, daily, events }` (scope `usage:read`).
- `anymd usage` prints the same from the [CLI](/docs/cli); MCP has `usage_summary`.

## Questions

Billing questions and Enterprise quotes: [hello@digitop.ai](mailto:hello@digitop.ai). Refunds follow the [refund policy](/legal/refund).
