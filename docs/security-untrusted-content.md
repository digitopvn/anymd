# Security: untrusted content and outbound fetches

anymd fetches pages that strangers write and hands the result to AI agents that hold tools and credentials. This file records the threat model, the controls that answer each threat, what is left over, and the tests that prove the controls. Reviewers check the matching items in `REVIEW.md`.

## Threat model

What anymd holds: account data, API keys (stored as SHA-256 hashes), each user's private library (Markdown, tags, embeddings), usage and trace rows, and the Worker's own secrets. What it exposes: the URL API, REST, MCP and WebMCP tools, all of which return third-party text.

| Threat | Where it enters | Impact if it worked |
| --- | --- | --- |
| Prompt injection | Page HTML and Markdown, titles and metadata, YouTube transcripts, social posts, library snippets | An agent treats page text as orders: calls `delete_document`, creates keys, leaks data, visits links |
| Marker spoofing | Page text that imitates our own boundary markers | Injected text appears to sit outside the untrusted block |
| Malicious links | `javascript:`, `vbscript:`, `data:`, `file:` links and images in converted Markdown | Script or local-file access in a client that renders the Markdown |
| False provenance | A redirect or a canonical tag that claims another source | Citations point at a site the content did not come from |
| SSRF | A requested URL, a redirect hop, robots.txt, video download URLs, image URLs | Requests to private networks, cloud metadata or anymd itself |
| Resource exhaustion | Huge or slow responses, redirect loops | Worker memory or CPU limits, stuck requests |
| Credential exfiltration | Secret query parameters in requested URLs; upstream error text | Tokens kept in usage rows or reflected to callers |
| Cross-principal leaks | Library, usage and trace queries; the conversion cache | One account reads another's data |

## Controls

### Outbound fetches

- `normalizeTargetUrl` (`src/convert/index.ts`): http(s) only, no userinfo, URLs up to 8192 characters, trailing dots stripped before the host checks, blocked names and suffixes (`localhost`, `.local`, `.internal`, `.home.arpa`, `.lan`, `.corp`, `.intranet`, anymd's own hosts). IP literals in any form the URL parser accepts (dotted, hex, octal, integer, IPv6, IPv4-mapped and NAT64) are classified by `isPublicAddress` (`src/lib/ip.ts`) against the IANA special-purpose ranges.
- `fetchPublic` (`src/convert/safe-fetch.ts`): `redirect: 'manual'`; every hop is checked for scheme and passed through `normalizeTargetUrl` again; at most 5 redirects; one `AbortSignal.timeout` covers all hops and the body read. Used by the web adapter, robots.txt and YouTube video downloads.
- On a redirect the web adapter re-checks the opt-out list and, when the site changes, the target site's rate limit and robots.txt (`vetRedirect` in `src/convert/web.ts`).
- `readBounded` (`src/convert/provider-fetch.ts`) streams the body and stops at the limit whatever `Content-Length` says: HTML, text and JSON 5 MB, documents 20 MB, robots.txt 500 KiB. Over the limit the request fails with `too_large` (413) or `upstream_too_large`.
- A robots.txt that cannot be fetched, including one that redirects to a private address, is treated as `unreachable` and the page is not read (fail closed).
- Image enrichment already follows redirects by hand through `normalizeTargetUrl` (`src/convert/image-enrichment.ts`).
- Platform: `wrangler.jsonc` sets `global_fetch_strictly_public`, so Workers `fetch` refuses private addresses after DNS resolution. This covers DNS rebinding, which a hostname check cannot see.

### Errors

Upstream failures produce bounded messages that name the host and status code only: no `statusText`, response body or raw content type (`mediaType` in `src/convert/web.ts`, `fetchFailure` in `src/convert/safe-fetch.ts`).

### Untrusted output

- `fenceUntrusted` (`src/lib/untrusted-content.ts`) wraps third-party text in `<<<anymd-untrusted id=…>>>` markers with a random 64-bit id per call, after a notice that the block is data, not instructions. Marker look-alikes inside the content are defaced with a zero-width space, so a page cannot close the block early.
- MCP tools that return third-party content set `untrustedOutput: true` (`src/mcp/server.ts`): `read_url`, `convert_url`, `search_library`, `get_document`, `list_documents`, `search_social`, `get_video_download`. Their text output is fenced and `_meta` carries `cc.anymd/untrusted_content: true`. `structuredContent` stays unfenced JSON for clients that parse it. The server instructions tell agents what the markers mean.
- WebMCP (`client/lib/webmcp.ts`) fences the same outputs.
- `neutralizeUnsafeLinks` (`src/convert/unsafe-links.ts`) replaces links and images whose scheme is not http, https or mailto with `#unsafe-link-removed`, ignoring whitespace and control characters inside the scheme. It runs on every conversion before caching, saving and rendering, on the page body and separately on comment and image-analysis Markdown that is appended after it (`neutralizeEnrichmentLinks`).
- `yamlString` and the title heading strip line breaks (including U+2028, U+2029 and U+0085) and control characters, so a page title cannot add frontmatter keys or headings.
- HTML rendering of library content keeps using `renderMarkdown` (untrusted mode).

### Provenance

JSON conversions carry `provenance`: `requested_url`, `source_url` (the last vetted hop, not a page's own claim), `fetched_at`, `extractor` and `content_trust: "untrusted"` (`convertPayload` in `src/services.ts`).

### Secrets, logs and identity

- `redactUrlSecrets` (`src/lib/util.ts`) replaces the values of secret-looking query parameters (`token`, `key`, `sig`, `secret`, `pass`, `auth`, `session`, `jwt`, `code`, `state`, …) with `REDACTED` and drops userinfo before a target is written to `usage_events` or `traces`.
- Library, usage and trace queries filter by the caller's `user_id`; MCP tools are registered per principal scope.
- The conversion cache is shared between accounts but holds only public content fetched without credentials. Its key separates anonymous and account reads, and it never stores document ids or library data.

## Retention and redaction

| Data | Where | Kept |
| --- | --- | --- |
| Conversion cache | KV `conv:*` | 1 hour |
| robots.txt verdicts | KV | 24 hours; failures 10 minutes |
| Library documents | D1, R2, Vectorize | Until the user deletes them; account deletion cascades |
| Usage and trace rows | D1 | Redacted target (max 500 characters), status and timings; no page content |
| Upstream error text | Not stored | Messages are rebuilt from host and status code |

## Residual risks

- Prompt injection cannot be prevented by the server. Fencing and the notice make the boundary explicit; whether an agent honours it depends on the client and model. Write tools keep their scope checks, so injected text can only use what the caller's credential allows.
- Markdown images pointing at an attacker's server are kept, because they are normal page content. A client that renders them on its own fetches the URL; anymd cannot stop that.
- DNS rebinding between our hostname check and the connection is covered only by `global_fetch_strictly_public`. A self-hosted deployment that removes that flag loses this protection.
- The list of anymd's own hostnames is fixed to anymd.cc. Self-hosted deployments should add their own domain.
- Secret redaction matches parameter names. A secret in an unusual parameter name or in the path is stored as sent.

## Evidence

`test/untrusted-content-security.test.ts` runs against `test/fixtures/prompt-injection-page.html` and covers:

- `normalizeTargetUrl` rejects trailing-dot hosts, hex, octal and integer IPv4, IPv4-mapped and NAT64 IPv6, unique-local, benchmarking and multicast ranges.
- `fetchPublic` blocks redirects to private hosts and other schemes, stops after 5 hops, follows public redirects and times out.
- The web adapter caps HTML and text without `Content-Length`, hides upstream status text and long content types, re-checks opt-out and robots.txt on redirects, fails closed on a robots.txt that redirects to a private address, and caps robots.txt at 500 KiB.
- Unsafe links are neutralized in the page body, comments and image analyses, page titles cannot inject frontmatter, URL secrets are redacted, and fence ids are unique.
- End to end over MCP: a hostile page read with `read_url` is fenced and flagged, causes no extra fetches, writes only the caller's own save, deletes nothing and creates no keys; `get_document` on another account's document is denied; `usage_summary` stays unfenced.

Run it with `npx vitest run test/untrusted-content-security.test.ts`.
