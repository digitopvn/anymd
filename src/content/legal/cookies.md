---
title: Cookie Policy
description: The exact cookies and browser storage keys anymd.cc uses, what each one does, and how to control them.
updated: 2026-09-26
---

Short policy, because we use very little. anymd.cc sets **two cookies** and **three local-storage keys**. No advertising cookies. No cross-site tracking. No third-party analytics scripts are enabled today.

## What cookies and local storage are

A **cookie** is a small piece of text a website asks your browser to store and send back on later requests. **Local storage** is similar browser storage that stays on your device and is read only by the site's own scripts. It is not sent to our servers automatically.

Privacy law (such as the EU ePrivacy Directive and the GDPR) treats both the same way: things that are strictly necessary for a service you asked for can be used without consent, and everything else needs your permission.

## Cookies we set

| Name | Type | Purpose | Duration |
| --- | --- | --- | --- |
| `amd_session` | Essential, first-party, HttpOnly | Keeps you signed in. It holds a session identifier so the site knows which account is making a request. | Until you sign out or the session expires |
| `amd_consent` | Essential, first-party | Remembers your cookie choice so we do not ask on every page. | Until you change your choice or clear cookies |

### `amd_session`

This cookie is set only when you sign in. It is marked **HttpOnly**, which means scripts running in the page, including any injected by a malicious extension, cannot read it. It is sent only over HTTPS. Without it, you cannot use the dashboard, your library, or any signed-in feature. Because it is strictly necessary for a service you requested, it does not require consent.

If you use anymd.cc only through the API, CLI or MCP server with an API key, this cookie is not involved at all.

### `amd_consent`

This cookie stores the choice you make in the consent banner. It exists so your "no" stays a "no". It contains your choice, not any identifier that tracks you.

## Local-storage keys we use

| Key | Purpose |
| --- | --- |
| `amd_offer_seen` | Remembers that you have already seen the return-visitor offer, so we do not show it again. |
| `amd_visits` | A simple visit counter used to decide when to show the return-visitor offer. |
| `amd_theme` | Remembers your light or dark theme preference. |

These keys live only in your browser. They are read by the site's own scripts and are not sent to our servers or to any third party. They do not identify you. The visit counter is just a number on your device. We do not combine it with your account or your IP address.

`amd_theme` is a preference you set directly, so it is treated as functional storage you requested. `amd_offer_seen` and `amd_visits` support a small interface feature. They are kept on your device only, and clearing them simply means you might see the offer again.

## Optional analytics

Our consent banner lets you allow or decline optional analytics. **Currently no analytics tools are enabled**, so accepting does not turn on any tracking today. If we add an analytics tool in the future, we will:

1. Load it only after you give consent.
2. List it on this page, with its cookie names, purpose and duration.
3. Update the date at the top of this policy.

Declining will always leave the site fully usable.

## Third-party cookies

anymd.cc does not embed advertising networks, social-media widgets or tracking pixels. When you check out, you are taken to Creem, our payment provider. Creem may set its own cookies on its own domain for payment security and checkout. Those are governed by Creem's cookie and privacy policies, not this one.

## How to control cookies and storage

- **Change your consent choice** at any time by deleting the `amd_consent` cookie for anymd.cc. The consent banner will appear again on your next visit so you can choose again.
- **Sign out** to end your session. The `amd_session` cookie is then no longer valid.
- **Clear site data** in your browser settings to remove all cookies and local-storage keys for anymd.cc. You will be signed out and the banner will appear again.
- **Block cookies** in your browser if you prefer. The public converter still works without them, but you will not be able to sign in.

Browser help pages explain how to manage cookies in Chrome, Firefox, Safari and Edge.

## Changes

If we add, remove or change a cookie or storage key, we update this page and the date at the top.

## Contact

Questions about cookies: **hello@digitop.ai**. For how we handle personal data more broadly, see our [Privacy Policy](https://anymd.cc/legal/privacy).
