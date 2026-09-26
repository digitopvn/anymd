---
title: Privacy Policy
description: What anymd.cc collects, why, who else sees it, how long we keep it, and the rights you have over it.
updated: 2026-09-26
---

> **Plain-English note.** This policy is written in plain English on purpose. It describes what actually happens to your data, not what could theoretically happen. If anything is unclear, email hello@digitop.ai.

anymd.cc (the "Service") is operated by [Digitop.ai](https://digitop.ai) ("we", "us"). For the personal data described here, we are the data controller. This policy covers the website, REST API, `anymd` CLI, MCP server and WebMCP tools.

## The short version

- Use anymd.cc without an account and we cache the result briefly (up to 1 hour). It does not go into any library.
- Sign in and every conversion is saved to **your** library so you can search it later. You can export it or delete it any time.
- We do not sell your data.
- We share data only with the processors listed below, and only what they need.

## What we collect

**Account data.** Your email address, your name, and a hashed version of your password. We never store your password in plain text.

**API keys.** We store a hash of each key plus its name, role and creation date. The full key is shown to you once, at creation.

**Your library.** When you are signed in, we store the Markdown output of every conversion, its metadata (title, source URL, date and similar fields) and **embeddings** of your documents. Embeddings are numeric vectors that power semantic search.

**Usage events and traces.** For each request we record the URL you converted, the result status, credits used, timing, and per-step span timings (a "trace"). These power the usage logs and traces in your dashboard and help us fix problems.

**Billing data.** Payments are handled by Polar.sh. We receive your subscription status, plan, and order identifiers. We never see or store full card numbers.

**Anonymous conversions.** If you convert without signing in, the output is cached for up to 1 hour so repeated requests are fast. It is not attached to an account or stored in a library.

**Cookies and local storage.** Covered in detail in our [Cookie Policy](https://anymd.cc/legal/cookies). In short: one essential session cookie, one consent cookie, and three local-storage keys for small interface features. No advertising trackers.

**Messages you send us.** If you email hello@digitop.ai, we keep the conversation so we can help you.

## Why we use it, and the legal basis

Under the EU and UK GDPR we need a legal basis for each use of personal data.

| Purpose | Data used | Legal basis |
| --- | --- | --- |
| Create and run your account | Account data, API key hashes | Performance of a contract |
| Convert content and save it to your library | Library, embeddings | Performance of a contract |
| Search your library | Library, embeddings, search queries | Performance of a contract |
| Show usage logs and traces, meter credits | Usage events, traces | Performance of a contract |
| Keep the Service secure, prevent abuse, debug | Usage events, traces | Legitimate interests |
| Billing, tax and accounting records | Billing data | Legal obligation and contract |
| Optional analytics (none enabled today) | Analytics data | Consent |
| Reply to support requests | Messages | Legitimate interests |

Where we rely on legitimate interests, we have weighed our interest in running a secure, reliable service against your privacy. You can object at any time (see "Your rights").

## Who else processes your data

We use a small set of processors. Each receives only what it needs for its job.

- **Cloudflare** — hosting on Workers, databases (D1), vector storage (Vectorize), file storage (R2), and AI inference via Workers AI (document and image conversion, embeddings, search query rewriting). Processes all Service data on our behalf.
- **Polar.sh** — merchant of record for payments, tax and VAT. Receives your email, billing details and purchase history.
- **FxTwitter** — receives the post identifier when you convert an X/Twitter URL.
- **YouTube oEmbed, RapidAPI transcript providers and VidCap** — receive the video URL or identifier when you convert a YouTube link.
- **Hacker News API** — receives the item identifier when you convert a Hacker News thread.
- **TypeSafe** — only if you turn on the Jev decider for search. It receives a sanitized version of your search query and the titles of the candidate results. It never receives document bodies.

When you convert an ordinary web page, we fetch it from the site that hosts it. That site will see a request from our infrastructure, not from you.

## International transfers

Cloudflare runs a global network, so your data may be processed in data centers outside your country, including outside the European Economic Area and the UK. Other processors may also operate outside the EEA. Where required, we rely on the European Commission's Standard Contractual Clauses or an equivalent safeguard, and on our processors' own transfer mechanisms.

## How long we keep it

- **Anonymous conversion cache:** up to 1 hour.
- **Account data, library, embeddings, API key hashes:** until you delete them or delete your account.
- **Usage events and traces:** while your account exists, so you can see your history in the dashboard. They are deleted with your account.
- **Billing records:** kept by Polar.sh and by us for as long as tax and accounting law requires.
- **Backups:** when you delete your account, your documents, keys and usage logs are removed from live systems and purged from backups within 30 days.

## Your rights

Depending on where you live, you have the right to:

- **Access** the personal data we hold about you.
- **Correct** inaccurate data.
- **Delete** your data ("right to be forgotten").
- **Export** your data in a portable format.
- **Object** to processing based on legitimate interests.
- **Restrict** processing in certain cases.
- **Withdraw consent** at any time, where we rely on consent.
- **Complain** to your local data-protection authority.

Much of this is self-service. From the dashboard you can export your library as Markdown or JSON, delete individual documents, revoke API keys, and delete your whole account. For anything else, email hello@digitop.ai. We reply within 30 days. More detail is on our [GDPR page](https://anymd.cc/legal/gdpr).

## Security

Passwords and API keys are stored only as hashes. The session cookie is HttpOnly. All traffic uses HTTPS. Access to production systems is limited to the people who run the Service. No system is perfectly secure, so if we ever learn of a breach affecting your data, we will notify you and the relevant authorities as the law requires.

## Children

The Service is not directed at children under 16, and we do not knowingly collect their data. If you believe a child has created an account, contact us and we will delete it.

## AI and your content

AI features (document and image conversion, embeddings, and query fan-out) run on Cloudflare Workers AI, on Cloudflare's infrastructure, to perform the conversion or search you asked for. The only other AI service involved is TypeSafe, and only when you enable the Jev decider, as described above.

## Changes to this policy

When we change this policy, we update the date at the top. For material changes, we notify signed-in users by email or in the dashboard before the changes apply.

## Contact

Digitop.ai — **hello@digitop.ai**
