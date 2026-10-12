---
title: "Send feedback"
description: "Report a bug or suggest a feature from the dashboard, REST API, MCP or CLI. Every report becomes a public GitHub issue on digitopvn/anymd."
updated: "2026-10-12"
---

Product feedback from every channel goes through one service and ends up as a **public GitHub issue** on `digitopvn/anymd`, labeled `ai-handle`. Anyone on the internet can read it, so write nothing you would not post publicly.

## What happens to a report

1. You write the report (type, title, description, optional steps, expected and actual behavior, a public reference URL).
2. anymd shows you **exactly** what will be published. Emails, private URLs and IP addresses, and tokens in query strings are redacted. A report that looks like it holds a credential (API keys, tokens, private keys, `Authorization` headers) is refused until you remove it.
3. You confirm that the report becomes public. Nothing is published before that.
4. anymd creates the issue and gives you its link. If GitHub is slow or unavailable the report is kept and retried; it is never called published until the issue exists.

User text is published inside quoted blocks with HTML removed, `@mentions` and cross-links to other GitHub threads defused, so it cannot hide instructions or imitate the page structure.

The report is stored with your account so you can follow its status (`created`, `pending`, `needs_review`, `failed`). Reports that look like spam, or come from very new accounts, wait as `needs_review` instead of being published. A held report is reviewed by the maintainers directly in storage; there is no self-service release.

## Limits

Per account: 1 report a minute, 3 a day and 10 a week. The service as a whole accepts 60 an hour. Sending the same text again under a new key returns `409 duplicate_feedback` that points at your own record, and text already reported by someone else points you to the existing issue. Repeating a request with the same key returns the stored report. Each report needs a stable **idempotency key** (8–128 characters), so a retry never creates a second issue.

## Dashboard

Open **Feedback** in the dashboard, fill in the form and choose **Preview**. Check the preview, tick the public-publication box and choose **Publish**. Only the text you reviewed can be published. **My feedback** lists your reports.

## REST

Needs the `feedback:write` scope (all signed-in roles except `viewer` hold it; API keys and OAuth clients must be granted it explicitly).

```bash
curl -X POST https://anymd.cc/api/v1/feedback \
  -H "Authorization: Bearer amd_…" \
  -H "Idempotency-Key: my-report-2026-10-12" \
  -H "Content-Type: application/json" \
  -d '{"type":"bug","title":"Search is empty for short words","description":"Searching a two letter word returns nothing.","confirm_public":true}'
```

| Method | Path | What it does |
|---|---|---|
| POST | `/feedback/preview` | The exact issue that would be published; stores nothing |
| POST | `/feedback` | Publish. `201` when created, `202` when pending or in review |
| GET | `/feedback` | Your reports, newest first |
| GET | `/feedback/:id` | One of your reports |

`confirm_public` must be `true`. Errors: `422 secret_detected`, `409 idempotency_conflict`, `409 duplicate_feedback`, `429 feedback_rate_limited` (with `Retry-After`), `503 feedback_unavailable`.

## MCP

`submit_feedback` and `list_my_feedback` appear for callers with `feedback:write`. `submit_feedback` has a permanent public side effect: an agent must only call it when its user asked for feedback to be sent and approved the text.

## CLI

```bash
anymd feedback submit --type bug --title "Search is empty" --message "Two letter words return nothing."
anymd feedback list
anymd feedback view <id>
```

On a terminal the CLI shows the preview and asks `[y/N]`. Without a terminal it refuses unless you pass `--confirm-public`; pass it only when the owner of the report approved publishing it.

## Your data

Deleting your account removes your stored reports from anymd, but **a GitHub issue that was already published stays public** on GitHub. Ask us at hello@digitop.ai to remove one.
