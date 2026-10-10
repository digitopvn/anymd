---
title: "Self-hosting"
description: "Deploy your own copy of anymd on Cloudflare Workers with D1, KV, R2, Vectorize and Workers AI, plus secrets and CI."
updated: "2026-10-04"
---

anymd is MIT-licensed and runs as a single Cloudflare Worker. Everything the hosted service uses is in the repository at [github.com/digitopvn/anymd](https://github.com/digitopvn/anymd).

## What you need

- A Cloudflare account with Workers, D1, KV, R2, Vectorize and Workers AI available.
- Node.js and npm.
- A domain on Cloudflare, if you want a custom hostname.

## 1. Clone and install

```bash
git clone https://github.com/digitopvn/anymd.git
cd anymd
npm install
npx wrangler login
```

## 2. Create the Cloudflare resources

The repository's `wrangler.jsonc` declares two environments, `staging` and `production`. Each needs:

| Binding | Type | Used for |
|---|---|---|
| `DB` | D1 database | Users, keys, library, usage, traces, billing, pages, posts |
| `OAUTH_KV` | KV namespace | MCP OAuth state |
| `CACHE` | KV namespace | Conversion cache, anonymous counters, published-page cache |
| `MEDIA` | R2 bucket | Media, social images, CLI tarball |
| `VECTORS` | Vectorize index | Semantic search embeddings |
| `AI` | Workers AI | Embeddings, query fan-out, document conversion |
| `RL_ANON`, `RL_AUTH` | Rate limiting | Per-minute limits for anonymous and signed-in callers |
| `RL_DOMAIN` | Rate limiting | Per-minute fetch budget per target site, shared by all callers |
| `RL_MCP`, `RL_MCP_MUTATION` | Rate limiting | Per-minute MCP limits per user and credential: every request, and the stricter budget for tools that change data. Optional: without them MCP falls back to `RL_AUTH` |

Create them (production shown; repeat with `-staging` names for staging):

```bash
npx wrangler d1 create anymd-production
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create anymd
npx wrangler vectorize create anymd-chunks-production --dimensions=1024 --metric=cosine
```

### Vectorize metadata indexes

Semantic search filters vectors by owner, and deletes them by document. Create both metadata indexes **before** any document is embedded, because Vectorize only indexes metadata on vectors written after the index exists:

```bash
npx wrangler vectorize create-metadata-index anymd-chunks-production --propertyName=user_id --type=string
npx wrangler vectorize create-metadata-index anymd-chunks-production --propertyName=doc_id --type=string
```

The index dimension (1024) matches the `bge-m3` embedding model used by the library.

## 3. Point wrangler.jsonc at your resources

`wrangler.jsonc` ships with Digitop's account and resource ids. Replace, per environment:

- `account_id`
- `d1_databases[].database_id` (and `database_name` if you renamed it)
- `kv_namespaces[].id` for `OAUTH_KV` and `CACHE`
- `r2_buckets[].bucket_name` and `vectorize[].index_name` if you renamed them
- `routes` with your own hostnames
- `ratelimits[].namespace_id`: any integer unique within your account
- `vars`: `PUBLIC_URL`, `CDN_URL`, `GITHUB_REPO`, `BILLING_PROVIDER` (`creem` or `polar`), `CREEM_SERVER` (`test` or `production`), `POLAR_SERVER` (`sandbox` or `production`)

Serve the R2 bucket from a custom domain (Cloudflare dashboard → R2 → your bucket → Custom domains) and put that origin in `CDN_URL`.

The SSRF guard in `src/convert/index.ts` refuses to convert anymd's own hostnames. Add your hostnames to its blocked list so your deployment can't be asked to fetch itself.

## 4. Apply database migrations

Migrations live in `migrations/`. Apply them to the remote database:

```bash
npm run db:migrate:staging
npm run db:migrate:production
```

These scripts use the database names `anymd-staging` and `anymd-production`; adjust `package.json` if yours differ. For local development, apply them to the local database instead:

```bash
npx wrangler d1 migrations apply anymd-staging --local --env staging
```

Every migration is additive, so the previous Worker version keeps working while you roll out. `0007_admin_control_plane.sql` adds the audit, account status, credit-grant lifecycle, settings version and webhook outcome columns the admin control plane needs; apply it before deploying the Worker that uses them.

## 5. Set secrets

First, set `ADMIN_EMAILS` in `wrangler.jsonc` (a plain var, per environment). It holds the comma-separated emails that become `owner` when they sign up.

All secrets are optional. Features that need one stay off, or degrade gracefully, until it is set. Set them per environment, one by one or from your `.env` in one go:

```bash
npx wrangler secret put OPENROUTER_API_KEY --env production
npm run secrets:production   # pushes every known secret found in .env, without printing values
```

| Secret | Enables |
|---|---|
| `CREEM_API_KEY` | Creem checkout and customer portal (with `BILLING_PROVIDER=creem`) |
| `CREEM_WEBHOOK_SECRET` | Verifying Creem webhooks |
| `POLAR_ACCESS_TOKEN` | Polar checkout, customer portal and usage-based overage (with `BILLING_PROVIDER=polar`) |
| `POLAR_WEBHOOK_SECRET` | Verifying Polar webhooks |
| `GITHUB_TOKEN` | Higher GitHub API rate limit for the changelog |
| `RESEND_API_KEY` | Transactional email (welcome, password reset) |
| `RAPIDAPI_KEY`, `VIDCAP_API_KEY` | YouTube transcripts (either works; RapidAPI is tried first) and the opt-in video download (either works; VidCap is tried first, with `VIDEO_QUEUE`). `RAPIDAPI_KEY` also enables Facebook, Instagram, Threads (API4) and LinkedIn adapters and their provider-backed comments. |
| `OPENROUTER_API_KEY` | Query fan-out and Jev via OpenRouter (Workers AI is the fan-out fallback), plus article-image OCR and descriptions using `qwen/qwen3.6-35b-a3b` |
| `TYPESAFE_API_KEY` | Jev directly from TypeSafe, when OpenRouter isn't configured |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | "Continue with GitHub" sign-in |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Continue with Google" sign-in |

### Sign in with GitHub or Google

A provider's button appears only when both its client id and secret are set. Register this callback URL with the provider, using your own host:

```text
https://anymd.cc/api/auth/oauth/github/callback
https://anymd.cc/api/auth/oauth/google/callback
```

The callback defaults to `PUBLIC_URL` plus that path; set `GITHUB_CALLBACK_URL` or `GOOGLE_CALLBACK_URL` only to override it. A GitHub OAuth App accepts one callback host, so staging needs its own app: put its values in `.env` as `STAGING_GITHUB_CLIENT_ID` and `STAGING_GITHUB_CLIENT_SECRET`, and `npm run secrets:staging` pushes them. A Google client can serve both hosts once the staging callback is added to its authorized redirect URIs. Request the `user:email` (GitHub) and `openid email profile` (Google) scopes; anymd asks for them itself.

Sign-in links to an existing account only through an email address the provider marks as verified. Because sign-up with a password does not verify email, linking removes any password on that account and signs out its sessions; the owner can add a password again with "Forgot password".

The authoritative list is the `Env` interface in `src/env.ts`. For local development, put values in `.dev.vars` (git-ignored). Never commit secrets.

### Billing

`BILLING_PROVIDER` picks the one payment provider that takes checkouts: `creem` or `polar`. The other stays off even if its secrets are set, and without the chosen provider's key billing stays off while everything else works.

#### Creem

Use `CREEM_SERVER=test` for anything that isn't production; it talks to `https://test-api.creem.io` with a test-mode key. anymd finds your products by name: `anymd Pro (monthly)`, `anymd Pro (yearly)`, `anymd Scale (monthly)` and `anymd Scale (yearly)`. Discount codes are plain Creem discounts (for example `LAUNCH30`). Creem has no usage meter, so it cannot bill overage: with Creem, plans that set `overagePer1k` keep going past their credits without an extra charge. Use Polar if you want overage billed.

`scripts/creem-setup.mjs` creates the four products, the discount codes and the webhook, and is safe to re-run. It saves the webhook signing secret to `.env` without printing it:

```bash
npm run creem:setup -- --webhook https://staging.example.com/api/webhooks/creem                  # test mode, CREEM_API_KEY
npm run creem:setup -- --production --webhook https://example.com/api/webhooks/creem             # live, CREEM_PRODUCTION_API_KEY
```

`npm run secrets:production` then pushes `CREEM_PRODUCTION_API_KEY` and `CREEM_PRODUCTION_WEBHOOK_SECRET` as the production Worker's `CREEM_API_KEY` and `CREEM_WEBHOOK_SECRET`. If Creem does not return the secret, copy it from Creem → Developers → Webhooks into `.env`.

#### Polar

Use `POLAR_SERVER=sandbox` for anything that isn't production. anymd finds your Polar products by metadata, so no product ids live in config: give each recurring product `anymd_plan` = `pro` or `scale`. Polar meters usage, so it can bill overage for plans that set `overagePer1k` in `src/billing/plans.ts`.

`scripts/polar-setup.mjs` creates the credits meter, the included-credit benefits, the four products, the discount codes and the webhook in one run, and is safe to re-run:

```bash
npm run polar:setup -- --webhook https://staging.example.com/api/webhooks/polar                  # sandbox, POLAR_ACCESS_TOKEN
npm run polar:setup -- --production --webhook https://example.com/api/webhooks/polar             # production, POLAR_PRODUCTION_ACCESS_TOKEN
```

`npm run secrets:production` then pushes `POLAR_PRODUCTION_ACCESS_TOKEN` and `POLAR_PRODUCTION_WEBHOOK_SECRET` as the production Worker's `POLAR_ACCESS_TOKEN` and `POLAR_WEBHOOK_SECRET`.

## 6. Build and deploy

```bash
npm run deploy:staging
npm run deploy:production
```

Each runs `npm run build` (Tailwind CSS and client scripts) and then `wrangler deploy` for that environment.

Local development runs against the staging configuration:

```bash
npm run dev
```

If Vectorize isn't reachable from local dev, hybrid search still returns keyword results.

## 7. Continuous deployment

The upstream repository deploys on push:

| Branch | Environment | Hostname |
|---|---|---|
| `dev` | `staging` | staging.anymd.cc |
| `main` | `production` | anymd.cc, www.anymd.cc |

The workflows live in `.github/workflows/`. For your fork, add two repository secrets, `CLOUDFLARE_API_TOKEN` (with Workers, D1, KV, R2 and Vectorize edit permissions) and `CLOUDFLARE_ACCOUNT_ID`, and change the hostnames. A deploy job boils down to:

```bash
npm ci
npm run typecheck
npm run db:migrate:production
npm run deploy:production
```

Apply migrations before deploying code that depends on them.

## Operating it

- **Logs:** `npx wrangler tail --env production`. Observability is enabled in `wrangler.jsonc`, so logs also appear in the Cloudflare dashboard.
- **Rollback:** `npx wrangler rollback --env production` returns to the previous Worker version. It does not undo D1 migrations.
- **Point clients at your copy:** set `ANYMD_BASE_URL` for the [CLI](/docs/cli) and use your hostname in [MCP](/docs/mcp) configs.

## License

MIT. Copyright (c) 2026 Digitop.ai. Keep the license notice when you redistribute.
