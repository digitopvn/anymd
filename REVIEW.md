# REVIEW.md

Code review checklist for anymd. Check the sections your change touches; security applies to every change.

## Security

### Outbound fetches (SSRF)

- [ ] Every fetch of a user-supplied URL goes through `normalizeTargetUrl` (`src/convert/index.ts`) first: http(s) only, no private/link-local/CGNAT ranges, no `localhost`/`.local`/`.internal`, no anymd's own hostnames, no embedded credentials.
- [ ] No new code path fetches user input directly (adapters, file URLs, image proxies, webhooks, OG fetchers).
- [ ] Redirects are followed by `fetch`, so the guard only vets the first hop. New privileged fetches (anything sending credentials or reaching non-public services) must not follow redirects to user-controlled targets.
- [ ] Response size limits stay enforced (HTML 5 MB, files 20 MB) and third-party calls have timeouts.

### Authorization

- [ ] Every API route has `requireScope(...)` with the scope from the public docs; nothing relies on the UI hiding a button.
- [ ] Every library, usage, trace and key query filters by the caller's `user_id`. Vectorize queries filter `user_id` too.
- [ ] MCP tools are registered only when the principal holds their scope; WebMCP tools run with the page session and the same checks.
- [ ] Key scopes are capped by the owner's current role (`capScopes`); nothing widens scopes from request input.
- [ ] Role changes require `users:write` (owner only).
- [ ] An unresolvable API key returns `401`, never falls back to anonymous.

### Sessions and writes

- [ ] Cookie-authenticated state-changing routes sit behind `sameOriginWrites`. New write routes don't bypass it.
- [ ] Billing checkout/portal require a session, not an API key.
- [ ] Page ops keep the `baseRevision` guard (`WHERE revision = ?`) and idempotency semantics.
- [ ] Webhooks verify signatures (`verifyPolarWebhook`) before any side effect and stay idempotent.

### Untrusted content

- [ ] User and converted Markdown is rendered with `renderMarkdown(md)` (untrusted), which escapes raw HTML, drops `javascript:` links and only allows http(s)/relative images. `{ trusted: true }` is only for our own bundled content.
- [ ] No `dangerouslySetInnerHTML`-style raw output of user data; interpolate with escaping (`escapeHtml`).
- [ ] Search snippets contain `<mark>` tags; render them safely (escape, then re-allow `<mark>` only).
- [ ] Page-builder props are validated by the block's zod schema, with length and count limits.

### Secrets

- [ ] No secret values in code, tests, fixtures, docs, logs, error messages or commits. Names only.
- [ ] Tokens and keys are stored as SHA-256 hashes; full API keys are returned once.
- [ ] Data sent to third parties is minimised (Jev masks emails and key-like strings; fan-out sends only the query).
- [ ] New secrets are optional in `src/env.ts` and the feature degrades gracefully without them.

## Correctness and contracts

- [ ] Conversion changes go through `runConversion`; all channels still produce identical output.
- [ ] Credit costs match `CREDIT_TABLE` and the docs; cached and failed conversions cost 0.
- [ ] Changes to the URL API, REST, MCP/WebMCP tools, CLI, scopes or credits update `src/content/docs/` in the same change.
- [ ] Errors use `{ error: { code, message } }` with a matching status; existing `code` values don't change meaning.
- [ ] Schema changes are a new file in `migrations/`, additive, and safe for the previous Worker version during rollout.

## Performance on Workers

- [ ] Non-critical work (usage, embeddings, billing ingest, cache writes) runs in `ctx.waitUntil`.
- [ ] Independent I/O runs in parallel (`Promise.all`); no N+1 D1 queries; multi-statement writes use `DB.batch`.
- [ ] Hot paths hit KV cache before expensive work; cache keys include every option that changes output.
- [ ] No unbounded loops over user data; lists have limits (search ≤ 50, library pages ≤ 100).
- [ ] Heavy dependencies aren't added casually; check bundle size and CPU time on large pages.
- [ ] External calls have timeouts and a fallback that doesn't fail the request.

## Accessibility

- [ ] Semantic landmarks and a single, logical heading order.
- [ ] All interactive elements are keyboard reachable with a visible focus state; no click-only `div`s.
- [ ] Form inputs have labels; errors are announced in text, not color alone.
- [ ] Images have meaningful `alt` (decorative ones `alt=""`).
- [ ] Color contrast meets WCAG AA.
- [ ] Motion (countdowns, rotating quotes, transitions) respects `prefers-reduced-motion`.

## Responsive

- [ ] Checked at 375, 768 and 1440 px wide: no horizontal scroll, no overlapping or clipped text, tap targets usable on mobile.
- [ ] Code blocks and tables scroll inside their container instead of widening the page.
- [ ] No console errors on any of the three widths.

## SEO and agent-readability

- [ ] Every new public page has a `.md` twin (Layout `markdownPath`, or `/<path>.md` and `Accept: text/markdown`).
- [ ] New blocks implement `toMarkdown` so pages built from them read well as Markdown.
- [ ] Unique title and description, canonical URL, OG image, JSON-LD where relevant; preview and draft URLs are `noindex`.
- [ ] Sitemap and `llms.txt` include new public pages.

## Content truth

- [ ] Prices and credits come from `src/billing/plans.ts`, not hand-typed copy.
- [ ] No invented metrics, testimonials, logos or quotes.
- [ ] Planned sources (`ROADMAP_SOURCES`) are labelled planned, never shipped.
