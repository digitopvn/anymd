# MCP OAuth

How MCP clients connect to `/mcp` with OAuth, what the server checks, and which clients are known to work. Public setup is in `src/content/docs/mcp.md` (`/docs/mcp`); scopes and roles are in `src/content/docs/api-keys-roles.md`.

## Moving parts

- `@cloudflare/workers-oauth-provider` (options in `src/worker.ts`) serves the authorization-server metadata, `/oauth/token` (also RFC 7009 revocation), `/oauth/register` (DCR) and validates every bearer token on `/mcp`: expiry, grant existence and the RFC 8707 resource/audience binding. PKCE is `S256` only (`allowPlainPKCE` is left at its `false` default). `clientIdMetadataDocumentEnabled` lets a client whose `client_id` is an `https://` URL (CIMD, used by ChatGPT) skip registration; the fetch runs under the `global_fetch_strictly_public` compatibility flag, so it cannot reach private addresses.
- `/oauth/authorize` and the consent screen are ours (`src/routes/auth.tsx`, `src/views/auth.tsx`). The screen shows the client name, its URL client ID, and the host of the redirect URI the browser returns to; the provider only accepts redirect URIs the client registered or published.
- Scopes: `oauthConsentScopes` and `oauthPrincipalScopes` in `src/auth/roles.ts`. The default grant is `convert`, `library:read`, `library:write`. Everything in `ELEVATED_SCOPES` (admin, content, `keys:manage`, `feedback:write`, `library:delete`) needs an explicit request and approval. The grant is re-capped by the user's current role on every request, and a suspended or deleted user gets `401`.
- Tools: `src/mcp/server.ts` lists only tools the token's scopes allow; calling a hidden one returns `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` so the client can step up. Destructive tools never trust a model-supplied flag: `delete_document` needs `library:delete` on the grant.

## Tool scopes

| Tool | Scope | Kind |
|---|---|---|
| `read_url` / `convert_url` | `convert` (saving also `library:write`) | read |
| `search_library`, `get_document`, `list_documents`, `list_tags` | `library:read` | read |
| `tag_document` | `library:write` | write |
| `delete_document` | `library:delete` (elevated) | destructive |
| `usage_summary` | `usage:read` | read |

## Auth failures

Every rejected bearer on `/mcp` writes one Workers Logs line, `{"event":"oauth.auth_failed","category","reason","code","status"}` (`logAuthFailure` in `src/worker.ts`). It never contains the token or the client's headers. Find them with `npx wrangler tail --env production --search oauth.auth_failed`.

Requests to `/mcp` that carried a credential and got `401` (bad, expired or revoked OAuth token, or a bad `amd_` key) count against the `RL_ANON` limiter under `mcp-auth-fail:<client IP>` (`limitAuthFailures`). Over the limit the answer is `429 rate_limited` with `Retry-After: 60`, logged as reason `auth_failure_rate_limited`. A limiter error fails open.

## Client compatibility

| Client | Registration | Status | Evidence |
|---|---|---|---|
| ChatGPT (apps / connectors) | CIMD (`https://` client ID), DCR fallback | Protocol flow covered by tests; production metadata verified with curl. Needs a manual connect before plugin submission | `test/oauth-mcp-flow.test.ts`: discovery, CIMD, PKCE, step-up, revocation |
| Claude (web, Desktop custom connector) | DCR | Works; same flow as tests | `connect and reconnect` tests |
| Claude Code (`claude mcp add --transport http`) | DCR, or `amd_` key header | Works | same, plus API-key path tests in `test/mcp*.test.ts` |
| Cursor, VS Code | DCR, or `amd_` key header | Works | same |
| `mcp-remote` and other spec clients | DCR | Works | same |

What the end-to-end tests in `test/oauth-mcp-flow.test.ts` prove, through `worker.fetch` with real D1 (SQLite) and KV stubs:

- Discovery: protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`, authorization-server metadata with `S256` only, CIMD supported, and a `401` challenge pointing at the metadata.
- Connect, reconnect and refresh; plain PKCE, a wrong verifier, an unregistered redirect URI and a foreign `resource` are rejected.
- A CIMD client is fetched, named on the consent screen, and completes the flow.
- A read-only grant gets `403 insufficient_scope` on write tools; `delete_document` needs a `library:delete` step-up, and `confirm: true` from the model changes nothing; one account never reaches another's documents.
- Expired tokens, revoked grants, wrong-audience and forged tokens, suspended and deleted users all get `401`.
- Failure logs never include the token; repeated failures from one IP get `429`, and bad API keys share that budget.

Run them with `npx vitest run test/oauth-mcp-flow.test.ts test/oauth-scopes.test.ts`.

## Migration

`migrations/0014_library_delete_scope.sql` adds `library:delete` to every API key that held `library:write`, so keys keep deleting. OAuth grants are deliberately not migrated: deletion on an existing connection needs a reconnect. It is safe for the previous Worker, which drops scopes its role table does not list (`capScopes`).
