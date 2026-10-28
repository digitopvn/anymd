# ChatGPT plugin (OpenAI plugin directory)

anymd is listed in ChatGPT as a plugin that wraps the existing remote MCP server `https://anymd.cc/mcp`. No new server or tool surface exists for it: the package only describes the server, its OAuth connection, listing copy, onboarding skills and the review test pack. The user-facing setup is in `src/content/docs/mcp.md` (ChatGPT section) and `src/content/docs/support.md`.

## Package layout

```
plugins/chatgpt/
  plugin.json                       listing, onboarding skill, review test pack, release notes
  mcp.json                          streamable-http server https://anymd.cc/mcp, OAuth with DCR
  assets/logo.png, assets/icon.png  square PNGs (512 and 256 px), copied from public/
  skills/get-started/SKILL.md       onboarding skill (onboardingSkill)
  skills/research-with-sources/     recall-first research workflow
  review/samples/*.md               synthetic documents for the reviewer library (not uploaded)
```

`npm run plugin:chatgpt -- <mode>` (source: `scripts/chatgpt-plugin.mjs`):

| Mode | What it does |
|---|---|
| `validate` (default) | Offline check against the directory rules: required fields and lengths (display name and short description ≤ 30, long description ≤ 4000, 1–3 default prompts ≤ 128), https listing URLs, square PNG assets 48 px–5 MiB, skill frontmatter, exactly 5 positive and 3 negative test cases, OAuth with DCR (or CIMD) on a streamable-http server, no `test_credentials`, `reviewer_instructions`, client secrets or non-empty headers, no credential-shaped strings in any shipped text, and no files or symlinks outside the allowlist. `test/chatgpt-plugin-package.test.ts` runs the same check in `npm test`. |
| `check-urls` | Fetches the four listing URLs (expects 200) and posts `tools/list` to the MCP URL (expects 401 with `resource_metadata`). |
| `pack [out.zip]` | Validates, then zips exactly `plugin.json`, `mcp.json`, `assets/` and `skills/` (symlinks stored, never followed) to `dist/anymd-chatgpt-plugin-<version>.zip`. Needs the `zip` command. |
| `seed --ref <commit> [--base URL]` | Reads each `review/samples/*.md` as raw text from GitHub at that pushed commit into the account behind `ANYMD_REVIEWER_KEY` with `save: true`, and tags it `review-sample`. |

`mcp.json` puts `auth` under `extensions["com.openai"]`, as OpenAI's plugin docs show. The generic agent-plugins `mcp.schema.json` does not list `extensions`; the OpenAI portal is the validator that counts.

## Server requirements and where they live

| Requirement | Implementation | Evidence |
|---|---|---|
| OAuth discovery, DCR, PKCE S256, RFC 9207 `iss` on success and denial, RFC 8707 resource check | `@cloudflare/workers-oauth-provider` configured in `src/worker.ts` | `test/chatgpt-connector.test.ts` |
| ChatGPT redirect URI `https://chatgpt.com/connector_platform_oauth_redirect` | Accepted by DCR like any https redirect | same test |
| Least privilege by default | No-scope clients get `convert library:read library:write`; admin tools need named scopes | same test, `test/oauth-scopes.test.ts` |
| Disconnect revokes access | Dashboard → API keys → Connected apps, or token revocation | `test/chatgpt-connector.test.ts` (both paths: the token then gets 401) |
| Response minimization | `read_url`, `search_library` and `search_social` results drop `trace_id`, `duration_ms` and `took_ms` (`withoutDiagnostics` in `src/mcp/server.ts`) | same test |
| Save only on request | `read_url` saves by default for every client (public contract); the shipped skills tell ChatGPT to pass `save: false` unless the user asks, and P1's prompt says so explicitly | `plugins/chatgpt/skills/*/SKILL.md` |
| No upsell in tool output | Quota errors say "Plans are described at …/pricing" | `src/convert/service.ts`, `src/convert/social-search.ts`, `src/routes/api.ts` |
| Tool annotations | `src/mcp/tool-types.ts` presets per tool | `test/chatgpt-connector.test.ts` (destructive set on a default connection) |
| Domain verification | `GET /.well-known/openai-apps-challenge` returns `OPENAI_APPS_CHALLENGE` as text, 404 while unset (`src/routes/public.tsx`) | same test |

## Submission (owner only)

These steps need the Digitop OpenAI organization with verified identity and the production Cloudflare account. An agent cannot do them.

1. `npm run plugin:chatgpt -- check-urls` passes against production (the support page ships with the Worker deploy).
2. In the OpenAI plugin portal, start a submission for the organization. Copy the domain verification token and set it: `npx wrangler secret put OPENAI_APPS_CHALLENGE --env production`. Confirm `curl https://anymd.cc/.well-known/openai-apps-challenge` prints the token, then verify in the portal.
3. Provision the reviewer account (below) and record the demo video: connect anymd in ChatGPT with the reviewer account, then run positive cases 1–3. Upload it unlisted and add its https URL as `review.demo_recording_url` in `plugin.json`, then run `validate` again.
4. `npm run plugin:chatgpt -- pack` and upload the zip.
5. Enter the reviewer credentials in the portal's credential fields only. They never go in the package, the repository or an issue.
6. Submit. Track review status in the portal.

## Reviewer account

The reviewer must reach a working library without MFA, customer data or a paid plan.

1. Create a dedicated account on anymd.cc with an email the team controls (for example a `+chatgpt-review` alias) and a password. Email and password sign-in has no MFA. Do not use Google or GitHub sign-in, which can prompt for MFA.
2. Keep it on the free plan (500 credits a month); the test pack spends a few credits per run.
3. Create an API key for it with the **Convert + library (agents)** preset and seed the library:
   ```bash
   ANYMD_REVIEWER_KEY=amd_… npm run plugin:chatgpt -- seed --ref <pushed commit or tag>
   ```
   The library then holds exactly the three synthetic samples, stored as text and titled by file name: `lighthouse-launch-plan.md`, `release-checklist.md` and `vector-search-primer.md`. Check them in the dashboard, then revoke the API key: ChatGPT uses OAuth.
4. Before each submission, delete anything else from the library (the "save" test case adds stephango.com/saw) and disconnect stale ChatGPT grants under Connected apps.

## Test pack

The pack in `plugin.json` is what reviewers run. Record observed results here for each submission.

| Case | Expectation | Observed |
|---|---|---|
| P1 read without saving | `read_url` with `save=false`, summary with source, nothing saved | Local E2E (2026-10-28): `read_url` over a ChatGPT-registered OAuth token returns Markdown first, `saved: false`, no trace id or timing. Live ChatGPT: pending owner run. |
| P2 recall by meaning | `search_library` finds the vector search sample | Local E2E: `search_library` answers on the default scopes. Live: pending seeded account. |
| P3 open and list action items | `get_document` lists the 3 action items | Pending seeded account. |
| P4 save on request and tag | `read_url save=true`, then `tag_document` | Pending owner run. |
| P5 answer from library | "30 minutes" from the release checklist | Pending seeded account. |
| N1 metadata address | Refused by the URL guard (`blocked_host`) before any fetch | Local: `normalizeTargetUrl` refuses it with `blocked_host` (`test/chatgpt-connector.test.ts`). Live: pending. |
| N2 another user's library | No tool takes another user; results come from the caller's library only | Library queries are scoped by `user_id`; live: pending. |
| N3 bulk delete | No bulk delete tool; the assistant asks which document to delete | Local: on a default connection no destructive tool other than `delete_document` is listed, and it requires one `id` (it may also need an elevated scope, see #55) (`test/chatgpt-connector.test.ts`). Live: pending. |

Production checks on 2026-10-28: `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` serve metadata with S256, a registration endpoint and `iss` support; `/mcp` without a token answers 401 with `resource_metadata`; website, privacy and terms URLs answer 200. `/docs/support` and `/.well-known/openai-apps-challenge` answer 404 until the Worker carrying them is deployed and the secret is set.

## Client support

| Client | Connection | Status |
|---|---|---|
| ChatGPT (plugin directory) | OAuth with DCR, PKCE | Package ready; submission pending owner |
| ChatGPT developer mode (custom app) | Same URL and OAuth | Works with the same server |
| Claude, Cursor, other MCP clients | OAuth or API key | See `src/content/docs/mcp.md` |

## Release, rollback and maintenance

- **Release a new package version.** Change `plugin.json` (bump `version`, update `publication.release_notes`), run `validate`, `check-urls` and the test pack, then `pack` and submit an update in the portal. Tool or schema changes on `/mcp` reach ChatGPT users without a package release, so treat any MCP tool rename, removal or behavior change as a listing change: re-run the test pack before deploying it.
- **Rollback.** A bad server change is rolled back with the Worker (`npx wrangler rollback --env production`, see `docs/operations.md`). A bad listing is fixed by submitting the previous package version from git history. To stop new connections at once, unpublish the listing in the portal; existing grants can be revoked per user from Connected apps or in bulk by deleting `grant:` and `token:` keys in `OAUTH_KV`.
- **Maintenance.** OpenAI re-scans listed apps. Keep the listing URLs answering 200 (`check-urls`), the reviewer account usable without MFA and its library limited to the samples, and the challenge secret in place for as long as the listing exists. Re-read OpenAI's submission guidelines before each update; the rules on annotations, response minimization and commerce are enforced at review.
