---
title: Terms of Service
description: The rules for using anymd.cc, its API, CLI and MCP server, written in plain English.
updated: 2026-09-26
---

> **Plain-English note.** We wrote these terms to be read, not skimmed by a lawyer at 2 a.m. They are still a binding agreement. If something is unclear, email hello@digitop.ai and ask.

These Terms of Service ("Terms") govern your use of anymd.cc, including the website, the REST API, the `anymd` CLI, the MCP server at `https://anymd.cc/mcp`, WebMCP tools, and any related services (together, the "Service"). The Service is operated by [Digitop.ai](https://digitop.ai) ("we", "us", "our").

By using the Service, you agree to these Terms. If you use it on behalf of an organization, you confirm you can bind it.

## What the Service does

anymd.cc converts publicly reachable content (web pages, posts, videos, documents and images) into Markdown, JSON or cleaned HTML. Signed-in users also get a searchable personal library of their conversions.

The engine is open source under the MIT license at [github.com/digitopvn/anymd](https://github.com/digitopvn/anymd). MIT governs the code. These Terms govern the hosted Service.

## Accounts

- Give accurate information and keep it up to date.
- You are responsible for activity under your account and API keys. Keep them secret, and revoke a leaked key right away.
- You must be at least 16 years old, or the minimum age of digital consent in your country if higher.
- One person or organization may not create multiple free accounts to avoid plan limits.

## Your responsibility for content you convert

You decide which URLs you send to the Service, so you are responsible for them.

- You must have the right to access, copy and transform the content you convert, through ownership, a license, the source's terms, or a legal exception such as fair use.
- Converting a page into Markdown does not give you any rights in that page. Copyright, trademarks and other rights stay with their owners.
- You are responsible for how you use the output, including anything you feed into AI models or publish elsewhere.

We do not review the content you convert and we do not endorse it.

## How we fetch content, and site owners' choices

anymd fetches a page only when you ask for that URL. It identifies itself with the `anymd` user agent and never presents itself as a regular browser.

- **robots.txt.** Before fetching a page itself, the Service checks the site's robots.txt for the `anymd` token (or `*`) and does not fetch pages it disallows.
- **Opt-outs.** Site owners can ask us to block their domain. Blocked domains cannot be converted through any channel, including from cache.
- **Per-site limits.** We cap how often the Service fetches from any single site, shared across all users.

A conversion refused for any of these reasons does not use credits. You must not try to get around them, for example by rewriting URLs, using mirrors or proxies of a blocked site, or spreading requests across accounts. Site owners can read how this works, opt out, or report abuse on our [Site Owners & Abuse page](https://anymd.cc/legal/abuse).

## Acceptable use

You agree not to use the Service to:

- **Bypass access controls.** No circumventing paywalls, logins, CAPTCHAs, robots.txt, site opt-outs, per-site limits or other technical measures, and no converting content that a site's terms prohibit you from accessing in the way you are accessing it.
- **Scrape for spam or abuse.** No harvesting email addresses or personal data for unsolicited messages, no building spam or content-farm pipelines, and no mass-republishing other people's work without permission.
- **Break the law.** No infringing intellectual property, violating privacy or data-protection law, or processing content that is illegal to possess.
- **Attack anyone.** No using the Service to probe, overload, or attack third-party sites, and no pointing it at internal or private network addresses.
- **Attack us.** No attempting to break, reverse-engineer around, or overload the hosted Service, get around rate limits or credit metering, or access other users' data.
- **Resell blindly.** No reselling or white-labelling raw access to the hosted Service without our written agreement. Building your own product on top of the API is fine.

If you are unsure whether a use case is allowed, ask first.

## Rate limits and credits

The Service is metered in credits, with a monthly allowance per plan, listed on the [pricing page](https://anymd.cc/pricing). We also apply rate limits to keep the Service fast and fair, and may tune them over time.

If you exceed your allowance or the rate limits, requests may be slowed, rejected, or billed as overage where your plan includes it. We may block abusive traffic even if it stays within your credits.

## Payments

Paid plans are sold through Polar.sh, which acts as merchant of record and handles tax and VAT. By purchasing, you also agree to Polar's checkout terms. Subscriptions renew automatically until cancelled. You can cancel at any time and keep access until the end of the paid period. Refunds follow our [Refund Policy](https://anymd.cc/legal/refund).

## Third-party sources and services

Some conversions rely on third-party services such as FxTwitter, YouTube oEmbed, RapidAPI transcript providers, VidCap, the Hacker News API and Cloudflare Workers AI. They can change or disappear without notice, and the matching conversions may degrade or stop working when they do.

## Our intellectual property

The anymd.cc name, logo, website and hosted Service belong to Digitop.ai. The open-source engine is licensed to you under MIT. If you send us feedback, we may use it freely.

## Your data

We handle personal data as described in our [Privacy Policy](https://anymd.cc/legal/privacy). You can export and delete your library and your account from the dashboard.

## Suspension and termination

You can stop using the Service and delete your account at any time.

We may suspend or terminate your access if you break these Terms, create legal or security risk, or the law requires it. Where reasonable, we will warn you first so you can fix the problem or export your data. If we shut down the Service entirely, we will give at least 30 days' notice.

## The Service is provided as-is

Websites change, sources break, and some pages simply do not convert well. The Service is provided **"as is" and "as available"**, without warranties of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose, accuracy, and non-infringement. We do not guarantee that the Service will be uninterrupted or error-free, or that output will be complete or accurate. Check the output before relying on it for anything important.

## Limitation of liability

To the maximum extent permitted by law:

- We are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, data or goodwill.
- Our total liability for all claims relating to the Service is limited to the greater of **(a) the amount you paid us in the 12 months before the claim** and **(b) USD 50**.

Some jurisdictions do not allow certain limitations. Where that is the case, these limits apply only as far as the law allows. Nothing in these Terms limits liability that cannot be limited by law.

## Indemnity

If someone brings a claim against us because of content you converted or the way you used the Service in breach of these Terms, you agree to cover our reasonable costs and losses from that claim.

## Governing law and disputes

These Terms are governed by the laws of the Socialist Republic of Vietnam. Before going to court, please contact us at hello@digitop.ai so we can try to resolve the issue informally. If we cannot, disputes will be handled by the competent courts of Vietnam, unless mandatory consumer-protection law in your country gives you the right to bring a claim where you live.

## Changes to these Terms

We may update these Terms as the Service evolves. The "updated" date at the top shows the latest version. For material changes, we will notify signed-in users by email or in the dashboard at least 14 days before the changes take effect. If you keep using the Service after that, you accept the new Terms. If you do not agree, stop using the Service and, if you want, delete your account.

## General

If any part of these Terms is unenforceable, the rest stays in force. Not enforcing a right is not a waiver. These Terms, with the Privacy, Refund and Cookie policies, are the whole agreement between us about the Service.

## Contact

Questions about these Terms: **hello@digitop.ai**.
