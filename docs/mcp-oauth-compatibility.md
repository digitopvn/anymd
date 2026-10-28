# MCP OAuth compatibility

How MCP hosts connect to `https://anymd.cc/mcp`, which parts of the protocol each relies on, and the
evidence behind each claim. Behaviour lives in `src/worker.ts` (provider options, `/mcp` entry),
`src/routes/auth.tsx` (consent), `src/mcp/server.ts` (tool listing and scope denials) and
`src/auth/auth-failures.ts`.

## What anymd offers

| Piece | Value |
|---|---|
| Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource/mcp`, resource `<PUBLIC_URL>/mcp`, baseline scopes `convert library:read library:write` |
| Authorization server metadata (RFC 8414) | `/.well-known/oauth-authorization-server`; S256 only; `authorization_response_iss_parameter_supported: true`; `client_id_metadata_document_supported: true` |
| Client identification | CIMD (an HTTPS `client_id` pointing at a metadata document) or DCR at `/oauth/register`; public clients use `token_endpoint_auth_method: none` |
| Audience | RFC 8707 `resource` must name `/mcp`; a foreign resource is refused (`invalid_target`), and a token bound elsewhere gets 401 at `/mcp` |
| Revocation | RFC 7009 at `/oauth/token`; dashboard "Revoke"; account deletion revokes every grant |
| Reconnect | A new consent for the same client replaces the earlier grant, so its tokens stop working |
| Scopes per tool | `securitySchemes: [{ type: "oauth2", scopes: [...] }]` on every tool in `tools/list` |
| Step-up | Single call: HTTP 403 `WWW-Authenticate: Bearer error="insufficient_scope"`. Inside a batch: the tool result carries `_meta["mcp/www_authenticate"]` |
| Read-only connection | Consent checkbox; the grant keeps only `convert` and `*:read`, so save, tag and delete tools are not listed and are refused server side |
| Destructive tools | `delete_document` needs `library:delete`, an elevated scope that is never in the default grant: the user approves it by name on the consent screen (step-up from a 403). The tool carries `destructiveHint: true`; no model-supplied argument can stand in for the scope |
| Account state | Suspended or deleted accounts get 401 at `/mcp` and cannot refresh (`invalid_grant`); a refused refresh drops the grant |
| Auth failures | An `auth_failure` log line (never the credential); 120 failures/min per IP for API keys, per IP and connection for OAuth tokens; then 429 with `Retry-After: 60` and the same Bearer challenge |

## Client matrix

"Protocol verified" means the requirements the host documents were exercised against anymd's real
OAuth provider (vitest through the Worker entry, and a local `wrangler dev` run). "Live" means a
connection from the host's production client to a deployed anymd; that needs a deploy and is tracked
on the issue.

| Host | Client identification | Redirect | Protocol verified | Live |
|---|---|---|---|---|
| ChatGPT (Apps / connectors) | CIMD `https://chatgpt.com/oauth/client.json` (preferred), DCR fallback | `https://chatgpt.com/connector_platform_oauth_redirect` (needs `iss` support, which anymd advertises) | Yes: CIMD with ChatGPT's real metadata document, DCR, PKCE, `iss`, `securitySchemes`, `_meta` step-up | Pending deploy |
| Claude (claude.ai, Desktop custom connectors) | DCR | Claude's callback | Yes: DCR + PKCE + resource + refresh | Pending deploy |
| Claude Code (`claude mcp add --transport http`) | DCR | Loopback | Yes (same flow as above) | Pending deploy |
| Cursor | DCR | `cursor://` callback | Yes (same flow as above) | Pending deploy |
| `mcp-remote` and other MCP SDK clients | DCR | Loopback | Yes (same flow as above) | Pending deploy |
| Any client with an API key | `Authorization: Bearer amd_…` | n/a | Yes: invalid keys get 401 with an OAuth discovery challenge on `/mcp` | n/a |

ChatGPT's metadata document declares `token_endpoint_auth_method: private_key_jwt` but lists `none`
among `token_endpoint_auth_methods_supported`; anymd treats CIMD clients as public (`none`) and
binds them with PKCE, which the token exchange test confirms.

## Evidence

- `test/oauth-flow.test.ts`: discovery, connect, reconnect, refresh, expiry, RFC 7009 and dashboard
  revocation, foreign audience at authorize, token and `/mcp`, PKCE (wrong verifier, `plain`
  refused with an error page whose return link carries the error to the client), redirect URI matching, missing scope, cross-tenant read and
  delete, the `library:delete` step-up (an argument cannot replace it), suspended and deleted
  accounts, forged and malformed tokens.
- `test/oauth-chatgpt.test.ts`: `securitySchemes`, `_meta["mcp/www_authenticate"]`, read-only
  consent and server-side refusal of delete, CIMD with ChatGPT's metadata document, auth-failure
  budget and log redaction, grant revocation across every page on account deletion.
- A local `wrangler dev` run of the whole flow in workerd, recorded when this matrix was first
  written (a dated run, not kept in sync with later changes):
  `plans/261028-1412-mcp-oauth-chatgpt-hardening/reports/local-e2e-output.txt`, script alongside.
  The CIMD check could not fetch `chatgpt.com` from the sandbox (HTTP 403 on egress), so CIMD is
  covered by the vitest fixture instead.

## Known limits

- CIMD documents are fetched only on Cloudflare (`global_fetch_strictly_public`); local Node tests
  stub the fetch.
- OAuth grants made before `library:delete` existed cannot delete until the user reconnects and
  approves it; API keys that held `library:write` were given `library:delete` by migration 0014.
- Re-run the "Live" column after each deploy that touches OAuth: connect from ChatGPT developer
  mode, reconnect, revoke from the dashboard, and confirm the next call asks to reconnect.
