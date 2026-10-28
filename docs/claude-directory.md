# Claude Directory listings

How anymd is listed in the Claude Directory, what was checked before submission, and what a maintainer does in the developer portal. Tracking issue: [#52](https://github.com/digitopvn/anymd/issues/52).

Two listings, submitted by the same Claude organization and paired so users don't get the anymd tools registered twice:

| Listing | Source | Portal type |
|---|---|---|
| **anymd** connector | Remote MCP server `https://anymd.cc/mcp` | Connector |
| **AnyMD Research** plugin | `plugins/anymd-research/` in this repository (marketplace manifest at `.claude-plugin/marketplace.json`) | Plugin bundle |

Public user docs: [`/docs/claude`](../src/content/docs/claude.md). Reviewer criteria: [connector checklist](https://claude.com/docs/connectors/building/review-criteria), [plugin checklist](https://claude.com/docs/plugins/pre-submission-checklist), [directory policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy).

## What a directory user gets

A Claude user who connects anymd signs in with OAuth 2.1 (Dynamic Client Registration, PKCE S256). A client that asks for no scopes gets `OAUTH_DEFAULT_SCOPES` (`src/auth/roles.ts`): `convert`, `library:read`, `library:write`. With a customer (`user` role) account that exposes exactly these tools, pinned by `test/mcp-directory-readiness.test.ts`:

| Tool | Hints | What it does |
|---|---|---|
| `read_url` / `convert_url` | open world, not read-only | Read a public URL as Markdown; saves to the library unless `save: false` |
| `search_library` | read-only | Search the caller's own library |
| `get_document` | read-only | One library document |
| `list_documents` | read-only | Recent library documents, filter by domain or tags |
| `list_tags` | read-only | Tags in the caller's library |
| `tag_document` | idempotent write | Add, remove or set tags |
| `delete_document` | destructive | Permanently delete a document |
| `search_social` | open world | Public posts on X, Facebook, Instagram, Threads, LinkedIn (credits per page) |
| `get_video_download` | read-only | Status of a YouTube download started by `read_url` |

Staff tooling stays out of a customer's connection: admin control-plane tools need admin scopes, `get_admin_access_status` is visible only to owner and admin roles, page-builder and CMS tools need content scopes, and the server instructions name only the tool groups the caller can see (`instructionsFor` in `src/mcp/server.ts`). Every tool declares a `title` and all four hints (`test/mcp-admin-authorization.test.ts`), and every name is at most 64 characters.

`convert_url` is kept as an alias of `read_url` for clients built before the rename. Both carry the same annotations and the description says they are the same tool.

## Listing content

| Field | Value |
|---|---|
| Name | anymd (connector), AnyMD Research (plugin) |
| Tagline | The web context layer for AI agents: read any public page as clean Markdown and keep a private, searchable library. |
| Description | anymd reads public web pages, GitHub, YouTube, Reddit, Hacker News, X, PDFs, Office files and images into structured Markdown, so Claude can cite real sources. Sources you choose to save go into a private library that Claude searches before reading the web again. |
| Server URL | `https://anymd.cc/mcp` (Streamable HTTP; stateless 2026-07-28 plus 2025-era clients) |
| Auth | OAuth 2.1, DCR at `/oauth/register`, metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp` |
| Docs | `https://anymd.cc/docs/claude`, `https://anymd.cc/docs/mcp` |
| Privacy | `https://anymd.cc/legal/privacy` |
| Terms | `https://anymd.cc/legal/terms` |
| Support | hello@digitop.ai, GitHub issues (`https://anymd.cc/docs/support` once #54 ships) |
| Icon | `public/icon-512.png` (copied to `plugins/anymd-research/.claude-plugin/icon.png`) |
| Allowed link URIs | None needed; the server does not call `ui/open-link` |

Example prompts (also in the plugin README and `/docs/claude`):

1. "Research how HTTP/3 differs from HTTP/2 using two or three authoritative sources, with citations."
2. "Read https://www.rfc-editor.org/rfc/rfc9114 and summarize how a connection is set up. Save it to my library with the tag http3."
3. "What did I save about HTTP/3? Answer only from my library and link the documents."
4. "Find recent public posts on X about Cloudflare Workers and summarize the main complaints, with links."

## Test account for reviewers

Reviewers need a fully populated, least-privilege account. Create it on production; never put its credentials in this repository, only in the portal's test-credentials field.

1. Sign up a dedicated account (role `user`, never editor/admin/owner) with an address the team controls.
2. Give it enough credits for review: an owner runs `grant_credits` (MCP) or the admin UI with a recurring grant and an `idempotencyKey`.
3. Populate the library by reading and saving 10 to 20 varied sources (web article, GitHub README, YouTube video, Reddit thread, PDF) and tagging a few (`http3`, `research`), so `search_library`, `list_tags` and `get_document` return real data.
4. Connect it once from claude.ai as a custom connector to confirm sign-in works, then disconnect.
5. Put the email and password (or a magic-link mailbox the reviewer can use) in the portal. Rotate the password after review.

## Validation evidence

Re-run these before each submission and after any MCP change:

| Check | Command | Expected |
|---|---|---|
| Directory tool set, hints, instructions | `npx vitest run test/mcp-directory-readiness.test.ts` | 5 tests pass |
| Full suite | `npm run typecheck && npm test` | pass |
| Plugin schema | `claude plugin validate ./plugins/anymd-research` | `Validation passed`, no directory findings |
| Marketplace manifest | `claude plugin validate .` | `Validation passed` |
| Plugin loads | `claude plugin marketplace add ./ && claude plugin install anymd-research@anymd && claude mcp list` | `plugin:anymd-research:anymd: https://anymd.cc/mcp (HTTP) - Needs authentication`; uninstall afterwards |
| OAuth discovery | `curl https://anymd.cc/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` | resource `https://anymd.cc/mcp`, `registration_endpoint`, `S256` |
| Unauthenticated MCP | `curl -i -X POST https://anymd.cc/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'` | `401` with `WWW-Authenticate: Bearer … resource_metadata=…, scope="convert library:read library:write"` |
| DCR with Claude's callback | `POST /oauth/register` with `redirect_uris: ["https://claude.ai/api/mcp/auth_callback"]`, `token_endpoint_auth_method: "none"` | a `client_id` echoing the redirect URI |
| MCP Inspector | `npx @modelcontextprotocol/inspector` → Streamable HTTP, `https://anymd.cc/mcp`, OAuth | every tool lists and runs with valid arguments |
| End to end in Claude | Connect as a custom connector, run the example prompts | cited answer; saved source found again; deleted on request |

Results on 2026-10-28 (production, before this change was deployed): plugin and marketplace validation passed with no findings; the plugin installed and registered the server; OAuth discovery, the 401 challenge and DCR with Claude's callback URL behaved as expected; and an authenticated Claude Code session ran read → cite → save → tag → `search_library` (the saved RFC ranked first) → delete. That run found long pages returning about 127,000 characters in one result, fixed in [#57](https://github.com/digitopvn/anymd/issues/57).

## Submitting

Someone with directory submit rights in the owning Claude organization does this at [claude.ai/directory/manage](https://claude.ai/directory/manage):

1. **Connector:** Submit new → Connector. Fill in the listing content above, the test account, and confirm the Inspector and custom-connector tests on the **Test & launch** step.
2. **Plugin:** Submit new → Plugin bundle. Repository `digitopvn/anymd`, plugin path `plugins/anymd-research`, branch `main` (the directory scans each new commit there, so ship plugin changes through `main`). Select **Validate**, fix anything marked **Blocking**, then submit.
3. Pair the plugin with the connector in the portal so the anymd server is registered once.
4. Record each submission ID, URL and review status below. Don't mark anything approved until the portal says so.

| Listing | Submission ID / URL | Status | Updated |
|---|---|---|---|
| anymd connector | not submitted yet | | |
| AnyMD Research plugin | not submitted yet | | |

## After launch

- **Installs and search-to-install conversion:** the developer portal's listing analytics.
- **Active usage:** owner MCP `list_system_usage` with `channel: "mcp"` (or `GET /api/v1/admin/system/usage`), per day and source.
- **Per-tool errors:** `list_system_traces` and `list_failed_jobs` for MCP traffic; tool failures carry a stable `error.code`.
- **Failed auth:** Cloudflare analytics for `401` / `403` on `/mcp` and `/oauth/token`.
- **Connected Claude clients:** `list_user_credentials` shows each OAuth grant with its client name.

Changing a public tool (name, scope, annotations, inputs) changes what the directory reviewed: update `test/mcp-directory-readiness.test.ts`, `/docs/claude`, the plugin README and skill, and bump `version` in `plugins/anymd-research/.claude-plugin/plugin.json`.
