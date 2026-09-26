---
title: GDPR and Your Data Rights
description: How anymd.cc supports your rights under the GDPR, including access, erasure and portability, plus our subprocessors and DPA.
updated: 2026-09-26
---

anymd.cc is run by [Digitop.ai](https://digitop.ai). We are based outside the European Union, but we serve users in the EU, the EEA and the UK, so we apply the General Data Protection Regulation (GDPR) and the UK GDPR to their personal data. This page explains your rights and how to use them. For the full picture of what we collect and why, read our [Privacy Policy](https://anymd.cc/legal/privacy).

## Our role

- **Controller.** For your account data, your library, usage logs and billing status, Digitop.ai is the data controller. We decide why and how that data is processed.
- **Processor.** If you are a business and you use anymd.cc to convert content that contains personal data about other people (for example, your customers or employees), you are the controller for that content and we process it on your behalf. In that case a Data Processing Agreement (DPA) should be in place. See below.

## Your rights

You have the following rights over your personal data. Most of them you can exercise yourself in the dashboard, in seconds.

### Right of access

You can ask what personal data we hold about you and receive a copy. Your dashboard already shows your profile, your library, your API keys (by name and role), your usage logs and your traces. For anything not visible there, email us.

### Right to rectification

If data about you is wrong or incomplete, you can have it corrected. Email us with what needs to change and we will update it.

### Right to erasure

You can ask us to delete your personal data.

- **Delete a document** from your library at any time.
- **Revoke an API key** at any time.
- **Delete your account** from [Dashboard → Account](/dashboard/account). This removes your documents, embeddings, API keys and usage logs from live systems immediately, and from backups within **30 days**.

We may keep a limited set of records where the law requires it, such as invoices for tax purposes. Billing records held by Polar.sh as merchant of record are subject to Polar's own retention obligations.

### Right to data portability

You can take your data with you. From [Dashboard → Account](/dashboard/account), export your library as **Markdown** or **JSON**. Markdown is about as portable as data gets: it opens in any text editor, Obsidian, a Git repository or another AI tool. JSON keeps the structured metadata.

### Right to object

Where we process your data based on legitimate interests (for example, security monitoring and debugging using usage logs and traces), you can object. We will stop unless we have compelling grounds that override your interests, or we need the data to handle a legal claim.

### Right to restriction

You can ask us to pause processing of your data while a dispute about its accuracy or lawfulness is resolved.

### Right to withdraw consent

Where we rely on consent, such as optional analytics or the optional Jev search decider, you can withdraw it at any time. Withdrawing does not affect processing that happened before.

### Automated decision-making

We do not make decisions that produce legal or similarly significant effects about you based solely on automated processing. Search ranking, query rewriting and the Jev decider only order results in your own library.

### Right to complain

You can lodge a complaint with the data-protection authority in the EU or EEA country where you live or work, or with the UK Information Commissioner's Office. We would appreciate the chance to fix the problem first, but you do not need our permission to complain.

## How to make a request

Email **hello@digitop.ai** from the address linked to your account, and tell us which right you want to exercise. If you write from a different address, we may ask you to confirm your identity before we act, so that we never hand your data to someone else.

- We respond **within 30 days**. If a request is unusually complex, we may extend this by up to two more months and will tell you why within the first 30 days.
- Requests are free. We may charge a reasonable fee or decline only if a request is clearly unfounded or excessive, as the GDPR allows.

## Subprocessors

We use the following subprocessors. Each receives only the data it needs.

| Subprocessor | Purpose | Data involved |
| --- | --- | --- |
| Cloudflare | Hosting (Workers), database (D1), vector index (Vectorize), storage (R2), AI inference (Workers AI) | All Service data |
| Polar.sh | Merchant of record: payments, tax, VAT, invoicing | Email, billing details, purchase history |
| FxTwitter | Fetching X/Twitter posts you convert | Post identifiers |
| YouTube oEmbed, RapidAPI transcript providers and VidCap | Fetching video metadata and transcripts you convert | Video URLs or identifiers |
| Hacker News API | Fetching threads you convert | Item identifiers |
| TypeSafe | Jev search decider, only when you enable it | A sanitized search query and titles of candidate results. No document bodies. |

We will update this list before adding a subprocessor that handles account or library data.

## International transfers

Some subprocessors operate outside the EEA and the UK, and Cloudflare processes data across its global network. Where required, transfers rely on the European Commission's Standard Contractual Clauses (and the UK addendum) or another lawful transfer mechanism.

## Data Processing Agreement

If your organization needs a DPA covering content you process through anymd.cc, email **hello@digitop.ai** with your company name and the account email. We will send our DPA for signature.

## EU representative

We have **not appointed** an EU representative under Article 27 of the GDPR. For all data-protection matters, including requests from supervisory authorities, contact us directly at **hello@digitop.ai**.

## Security measures

Passwords and API keys are stored only as hashes. Sessions use an HttpOnly cookie. All traffic is encrypted in transit with HTTPS. Anonymous conversions are cached for at most one hour and never enter a library. API keys can be scoped with role templates so each integration gets only the access it needs.

## Contact

Digitop.ai — **hello@digitop.ai**. Response within 30 days.
