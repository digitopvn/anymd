# MCP OAuth: ChatGPT linking, scopes and revocation (#55)

Status: implemented, in review · Branch: `claude/affectionate-goodall-k7gwhl` · Base: `dev`

## Outcome
ChatGPT (and other MCP hosts) connect and reconnect to `https://anymd.cc/mcp` through OAuth 2.1 + PKCE S256, by CIMD or DCR, with tokens bound to the `/mcp` resource. Scopes isolate read from write; a user can grant a read-only connection; deletion is gated by a server-side scope, never a model-provided flag. Expired, revoked, wrong-audience, cross-tenant, suspended and deleted-account tokens fail closed with the right status. Auth failures are rate limited and logged without secrets.

## Production audit (2026-10-28, curl against anymd.cc)
- PRM `/.well-known/oauth-protected-resource/mcp`: resource `https://anymd.cc/mcp`, AS `https://anymd.cc`, baseline scopes. OK.
- AS metadata: S256 only, `authorization_response_iss_parameter_supported: true`, DCR endpoint, `client_id_metadata_document_supported: false` (gap: ChatGPT prefers CIMD).
- `POST /mcp` without token: 401 + `WWW-Authenticate` with `resource_metadata` and baseline scope. OK.

## Gaps and changes
1. Enable CIMD (`clientIdMetadataDocumentEnabled`); `global_fetch_strictly_public` already set.
2. Per-tool `securitySchemes` in `tools/list`; scope denials carry `_meta["mcp/www_authenticate"]` (ChatGPT tool-level step-up) besides the HTTP 403 challenge.
3. Consent: opt-in "read-only" connection that drops every write scope.
4. Auth failures (invalid API key, invalid/expired/revoked OAuth token, suspended/deleted account): structured log without credentials, per-IP failure budget (429).
5. Account deletion revokes every OAuth grant page, not only the first.
6. Tests: full OAuth flow through the real provider (DCR + PKCE + consent + token + /mcp), expired/revoked token, wrong audience, missing scope, cross-tenant, suspended and deleted account, read-only grant.
7. Docs: MCP doc page (CIMD, read-only consent, errors), compatibility matrix with evidence.

## Acceptance
- `npm run typecheck`, `npm test` green; new tests cover every DoD case.
- Local `wrangler dev` run of the real flow; production discovery re-checked after deploy is out of scope (deploys need explicit permission).

## Found while testing
- Suspended accounts could refresh tokens: now refused in `tokenExchangeCallback`.
- Authorize errors after the redirect URI is verified rendered a local 400 page: now redirected to the client (RFC 6749 4.1.2.1, RFC 9207).
- An invalid `amd_` key on `/mcp` had no `WWW-Authenticate` challenge: now carries `resource_metadata`.

## Evidence
- `test/oauth-flow.test.ts`, `test/oauth-chatgpt.test.ts`; full suite green.
- `reports/local-e2e-output.txt` (workerd via `wrangler dev`, 19/20; CIMD egress blocked in sandbox, covered by vitest).

## Adopted from the parallel branch (`claude/affectionate-goodall-r6dh04`)
- Elevated `library:delete` scope for `delete_document` and `DELETE /api/v1/library/:id`; migration 0014 gives it to API keys that held `library:write`. OAuth grants step up.
- Consent screen shows the redirect host; a failing CIMD lookup renders an error page instead of a 500.
