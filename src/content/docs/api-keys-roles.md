---
title: "API keys & roles"
description: "Create scoped anymd API keys, pick presets, and understand how roles cap what every key and OAuth grant can do."
updated: "2026-09-26"
---

Every call to anymd runs as a **principal** with a set of **scopes**. Scopes come from your **role**, and each API key or OAuth grant can only narrow them, never widen them.

## API keys

- Format: `amd_` followed by a random string. Send it as `Authorization: Bearer amd_…` or `X-API-Key: amd_…`.
- The full key is shown **once**, at creation. anymd stores only a hash; if you lose a key, revoke it and make a new one.
- Keys can expire (`expires_in_days`) and can be revoked at any time. Unknown, revoked or expired keys get `401 invalid_api_key`.
- Create and revoke them in **Dashboard → API keys**, or through the API:

```bash
curl https://anymd.cc/api/v1/keys \
  -H "Authorization: Bearer $ANYMD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"research-agent","preset":"library","expires_in_days":30}'
```

Body: `{ name, preset?, scopes?, expires_in_days? }`. Use a preset, or pass an explicit `scopes` array.

## Presets

| Preset | Label | Scopes |
|---|---|---|
| `convert-only` | Convert only | `convert` |
| `library` | Convert + library (agents) | `convert`, `library:read`, `library:write` |
| `read-only` | Read-only | `library:read`, `usage:read` |
| `content-editor` | Content editor (AI CMS) | `content:read`, `content:write`, `content:publish`, `pages:read`, `pages:write`, `pages:publish` |
| `full` | Everything my role allows | all scopes, capped by your role |

Rule of thumb: give each integration its own key with the smallest preset that works. A CI job that only converts gets `convert-only`; an assistant that remembers what it reads gets `library`.

## Scopes

| Scope | Allows |
|---|---|
| `convert` | Convert URLs and files |
| `library:read` | List, read and search your library |
| `library:write` | Save conversions, tag and delete documents |
| `usage:read` | Usage, credits and traces |
| `keys:manage` | Create, list and revoke your API keys |
| `content:read` · `content:write` · `content:publish` | Blog posts: read drafts, edit, publish |
| `pages:read` · `pages:write` · `pages:publish` | Landing pages: read, edit, publish |
| `settings:write` | Site settings |
| `users:read` · `users:write` | See users; change roles and plans |

A request missing a scope gets `403 forbidden` with the scopes it needed in `required`. The endpoint-to-scope map is in the [REST API](/docs/api) reference; MCP tools are hidden entirely when you lack their scope.

## Roles

Roles are templates. Your account has exactly one.

| Role | For | Scopes |
|---|---|---|
| `user` | Customers (default) | `convert`, `library:read`, `library:write`, `usage:read`, `keys:manage` |
| `viewer` | Read drafts and analytics | `convert`, `library:read`, `usage:read`, `content:read`, `pages:read` |
| `author` | Draft posts and pages; an editor publishes | `user` scopes + `content:read`, `content:write`, `pages:read`, `pages:write` |
| `editor` | Write and publish | `author` scopes + `content:publish`, `pages:publish` |
| `admin` | Run content, pages and settings | `editor` scopes + `settings:write`, `users:read` |
| `owner` | Full control | every scope, including `users:write` |

Only an owner can change another user's role (`users:write`). `GET /api/v1/admin/roles` returns the live role templates and presets.

## How capping works

Effective scopes = the key's (or grant's) scopes ∩ the owner's **current** role.

- A key created with `full` by an `editor` gets editor scopes, not owner scopes.
- If a user is demoted, their existing keys lose the extra power on the very next request. No need to rotate.
- A key with no explicit scopes gets everything the role allows.

Check what a key can actually do right now:

```bash
curl https://anymd.cc/api/v1/me -H "Authorization: Bearer $ANYMD_API_KEY"
# { "id": "…", "email": "…", "name": "…", "role": "user", "plan": "free", "scopes": ["convert", …] }
```

## OAuth

MCP clients can skip keys and sign in with OAuth 2.1 (Dynamic Client Registration + PKCE). The grant is capped by your role the same way. Setup: [MCP server](/docs/mcp).

## Good hygiene

- One key per integration, named after it. Revoke it when the integration goes away.
- Set `expires_in_days` for anything temporary.
- Keep keys in environment variables or a secret manager, never in source control or client-side code.
- Browser sessions can't be used cross-site: cookie-authenticated writes must come from anymd.cc itself.
