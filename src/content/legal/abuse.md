---
title: Site Owners & Abuse
description: How anymd fetches pages, how to opt your site out, and how to report abuse or request a takedown.
updated: 2026-09-26
---

> **Short version.** anymd identifies itself, follows robots.txt, limits how often it hits any one site, and honours opt-out requests for whole domains. To block us, add `User-agent: anymd` / `Disallow: /` to your robots.txt or email **hello@digitop.ai**.

anymd.cc converts a page into Markdown only when a user asks for that specific URL. It is not a crawler. It does not follow links, discover pages or index sites on its own.

## How anymd fetches pages

When anymd fetches a page from your site, it sends this user agent:

```
Mozilla/5.0 (compatible; anymd/1.0; +https://anymd.cc)
```

On a few sites that serve server-rendered HTML only to bots, it may retry once with ` bot` appended. It never presents itself as a regular browser.

Before fetching a page, anymd reads your `robots.txt` and applies it:

- The product token is **`anymd`**. If your robots.txt has a group for `anymd`, that group applies. Otherwise the `*` group applies.
- `Allow` and `Disallow` follow [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309): the most specific rule wins, and `*` and `$` wildcards work.
- If robots.txt is missing (a 4xx response), everything is allowed. If it cannot be read because of a server or network error, anymd does not fetch the page.
- robots.txt is cached for up to 24 hours, so changes can take a day to apply. An opt-out by email applies immediately.

anymd also caps how often it fetches from any single site, shared across all users, so it cannot be used to flood your server. Conversions are cached for up to one hour, so most repeated requests for the same page never reach you.

It only fetches publicly reachable pages. It does not log in, bypass paywalls, solve CAPTCHAs or fetch private or internal network addresses.

### Sources read through APIs

Some sources are read through public APIs or third-party services instead of fetching the page itself: X posts (through FxTwitter), YouTube metadata and transcripts, and Hacker News (through its official API). robots.txt on those sites does not govern those API calls. The domain opt-out below does.

## Opt your site out

Pick either option:

1. **robots.txt.** Add this to `https://your-site/robots.txt` to block anymd from the whole site:

   ```
   User-agent: anymd
   Disallow: /
   ```

   Use a narrower `Disallow` path to block only part of the site.

2. **Domain opt-out.** Email **hello@digitop.ai** from an address at the domain, or show control of the domain another way (for example, a DNS TXT record we ask you to add). We add the domain to our block list. It covers every subdomain and every channel (website, API, CLI and MCP), and it also stops cached results from being served.

We aim to confirm opt-out requests within **2 business days**.

## Report abuse or request a takedown

Email **hello@digitop.ai** with the subject "Abuse report" or "Takedown request" and include:

- the URLs involved, on your site and, if relevant, on anymd.cc;
- what happened, with dates and times (UTC) and, for traffic issues, the source IPs and user agent you saw;
- for a copyright or other rights claim: your contact details, the work you own or represent, and a statement that you believe in good faith the use is not authorized.

What we do:

1. We acknowledge the report and review it.
2. For traffic from anymd, we check our logs and tighten limits or block the domain.
3. For a user breaking our [Terms of Service](https://anymd.cc/legal/terms), we can suspend their API keys or account.
4. For a valid legal notice, we can delete stored copies of the content from our systems, including users' libraries.

We do not host public copies of converted pages. Output goes to the user who asked for it and, if they are signed in, to their private library.

## Contact

Site owners, abuse reports and takedown requests: **hello@digitop.ai**. anymd.cc is operated by [Digitop.ai](https://digitop.ai).
