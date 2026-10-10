# Operations

How to reach, deploy, observe and recover the running anymd.cc service. Setup for a fresh account is in `src/content/docs/self-host.md` (public at `/docs/self-host`); this file covers the Digitop deployment.

## Environments

| Environment | Branch | Hostnames | Worker | Billing |
|---|---|---|---|---|
| `staging` | `dev` | staging.anymd.cc | `anymd-staging` | Creem test mode |
| `production` | `main` | anymd.cc, www.anymd.cc | `anymd` | Polar live |

Bindings, resource names and vars per environment: `wrangler.jsonc`. `BILLING_PROVIDER` picks the live payment provider (`polar` on production, `creem` in test mode on staging; the other provider's code and secrets stay in place but inactive). `CREEM_SERVER` and `POLAR_SERVER` select each provider's API host (see `apiBase` in `src/billing/creem.ts` and `src/billing/polar.ts`).

## Deploy

CI in `.github/workflows/` deploys on push: `dev` → staging, `main` → production. It needs the GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

`wrangler.jsonc` sets no `account_id`. When a local Wrangler login can see more than one Cloudflare account, every remote command (`deploy`, `d1`, `r2`, `secret`) fails with "More than one account available but unable to select one in non-interactive mode". Find the Digitop account ID with `npx wrangler whoami` and set it for the shell before running remote commands:

```bash
export CLOUDFLARE_ACCOUNT_ID=<digitop-account-id>
```

On PowerShell: `$env:CLOUDFLARE_ACCOUNT_ID = '<digitop-account-id>'`.

Manual deploy uses the `package.json` scripts:

```bash
npm run db:migrate:staging && npm run deploy:staging
npm run db:migrate:production && npm run deploy:production
```

Order matters: apply migrations first, then deploy code that depends on them. Migrations must be additive so the previous Worker version keeps working during rollout and after a rollback.

Before any remote migration, create a recoverable D1 backup or Time Travel bookmark and record the currently deployed Worker version. For example, inspect the target explicitly with `npx wrangler d1 time-travel info anymd-production --env production` (use the staging database and environment for staging). The enrichment schema migration is additive (`migrations/0005_conversion_enrichment.sql`); never edit an applied migration or run a remote migration without that recovery point. Full D1 exports are not a fallback for this database's FTS5 virtual tables.

Promote to production only after the change is verified on staging, including the responsive check at 375 / 768 / 1440 px listed in `REVIEW.md`.

## CLI artifact release

The CLI is distributed from the R2-backed CDN URL `https://cdn.anymd.cc/cli/anymd-cli-latest.tgz`; it is not published to the npm registry, and CI does not upload it, so a merged CLI change reaches users only after this manual release. The `wrangler r2` commands below need the account selection described under Deploy. After the CLI version and flags are verified, run `npm pack ./cli` and identify the generated tarball. Before replacing the mutable `latest` object, back it up with a remote GET:

```bash
npx wrangler r2 object get anymd/cli/anymd-cli-latest.tgz --file ./backups/anymd-cli-latest-<timestamp>.tgz --remote
```

Upload both the immutable versioned object and the `latest` alias with gzip content type:

```bash
npx wrangler r2 object put anymd/cli/anymd-cli-<version>.tgz --file ./<packed-tarball>.tgz --remote --content-type application/gzip
npx wrangler r2 object put anymd/cli/anymd-cli-latest.tgz --file ./<packed-tarball>.tgz --remote --content-type application/gzip
```

Verify the versioned artifact by downloading it with `wrangler r2 object get --remote` and comparing its SHA-256 hash with the local tarball (`Get-FileHash -Algorithm SHA256` on PowerShell or `sha256sum` on POSIX). Verify the CDN URL and the CLI help output after the upload. This procedure documents the release route; it does not mean a new artifact has been published.

## Secrets

Secret names and their features are declared in the `Env` interface in `src/env.ts`, with a purpose table in the self-host doc. Values live only in Cloudflare (`wrangler secret put <NAME> --env <env>`) and in the local, git-ignored `.env` / `.dev.vars`.

- Never read a secret value to write docs, tickets or logs. Refer to it by name.
- List what is set without values: `npx wrangler secret list --env production`.
- Rotate by `wrangler secret put` with the new value; the next request picks it up.

Staging uses Creem **test-mode** credentials (`CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`) and Polar **sandbox** credentials. Never put live payment credentials on staging.

Social adapters use the optional `RAPIDAPI_KEY`; article-image OCR and descriptions use the optional `OPENROUTER_API_KEY`. Provider subscriptions and model availability are external prerequisites, so a configured secret alone is not evidence that an adapter is operational.

The adapter source files own the fixed provider hosts and paths; callers never supply them:

| Capability | Provider host | Secret |
|---|---|---|
| X thread expansion, X social search (`/search.php`) | `twitter-api45.p.rapidapi.com` | `RAPIDAPI_KEY` |
| Facebook posts/comments, social search (`/search/posts`) | `facebook-scraper3.p.rapidapi.com` | `RAPIDAPI_KEY` |
| Instagram posts/media/comments, social search (`/v1/search/posts`) | `instagram-pro-and-cheap-api.p.rapidapi.com` | `RAPIDAPI_KEY` |
| Threads posts/comments | `threads-api4.p.rapidapi.com` | `RAPIDAPI_KEY` |
| Threads social search (`/api/v1/search/recent`, `/api/v1/search/top`) | `threads-scraper-api2.p.rapidapi.com` | `RAPIDAPI_KEY` |
| LinkedIn posts/comments, social search (`POST /search-posts`) | `fresh-linkedin-profile-data.p.rapidapi.com` | `RAPIDAPI_KEY` |
| Article-image analysis | OpenRouter `https://openrouter.ai/api/v1/chat/completions` with `qwen/qwen3.6-35b-a3b` | `OPENROUTER_API_KEY` |

## Creem (staging)

- Products are found by name (`anymd Pro (monthly)` …, see `parseProductName` in `src/billing/creem.ts`). The mapping is cached in KV key `creem:products` for 10 minutes; delete that key to pick up a product change immediately. `npm run creem:setup` creates the products, discount codes and webhook.
- Discount codes (`LAUNCH30`, `COMEBACK20`) must exist in Creem with the same names as in `src/billing/plans.ts`.
- Creem has no usage meter, so overage past the included credits is not billed on staging. Test overage billing against the Polar sandbox instead.
- The webhook endpoint is `POST /api/webhooks/creem` (`https://staging.anymd.cc/api/webhooks/creem` in test mode, `https://anymd.cc/api/webhooks/creem` live), signed with `CREEM_WEBHOOK_SECRET` in the `creem-signature` header. Checkouts carry `metadata.referenceId` = user id; `checkout.completed` stores the Creem customer id for the portal and `subscription.*` events set the plan. Delivery is idempotent via `webhook_events`.

## Polar (production)

- Products are discovered by metadata `anymd_plan` = `pro` | `scale` on recurring products. The mapping is cached in KV key `polar:products` for 10 minutes; delete that key to pick up a product change immediately.
- Discount codes (`LAUNCH30`, `COMEBACK20`) must exist in Polar with the same names as in `src/billing/plans.ts`.
- Overage is metered through Polar usage events named `anymd_credits`, at the `overagePer1k` prices in `src/billing/plans.ts`. Those prices must match the metered prices on the Polar products.
- The webhook endpoint is `POST /api/webhooks/polar` (`https://staging.anymd.cc/api/webhooks/polar` for the sandbox org, `https://anymd.cc/api/webhooks/polar` for production). It must be registered in each Polar org (sandbox for staging, production for production) with the matching `POLAR_WEBHOOK_SECRET`. Delivery is idempotent via the `webhook_events` table, so Polar retries are safe.

## Logs and traces

- Live logs: `npx wrangler tail --env production` (add `--status error` or `--search <text>` to filter, `--format pretty` for humans).
- Workers observability is enabled in `wrangler.jsonc`; historical logs are in the Cloudflare dashboard.
- Per-request traces: every conversion returns `X-Anymd-Trace`. The span timeline is stored in the `traces` table and visible to the user in the dashboard or via `GET /api/v1/traces/:id`.
- Usage: `usage_events` holds every metered request with status, credits and error code.

## Rollback

- **Code:** `npx wrangler rollback --env production` returns to the previous version; `npx wrangler rollback <version-id> --env production` targets a specific one (`npx wrangler versions list --env production`). Rollback does not touch D1, KV, R2 or Vectorize.
- **Data:** D1 Time Travel can restore a database to a point in the last 30 days: `npx wrangler d1 time-travel restore anymd-production --timestamp=<RFC3339 or unix seconds>`. This overwrites current data; take a bookmark with `time-travel info` first.
- **Pages:** republish an earlier revision with `POST /api/v1/admin/pages/:id/publish {"revision": n}`.
- **After rolling back past the admin control plane (migration `0007`):** the schema stays (migrations are additive), but the older Worker ignores what it added. Until you redeploy:
  - Revoked credit grants count again (the old code does not read `credit_grants.revoked_at`). Re-check with `SELECT id, user_id, credits FROM credit_grants WHERE revoked_at IS NOT NULL AND (expires_at IS NULL OR expires_at > <now ms>)`, and if any matter, set their `expires_at` to now; that holds under both versions.
  - Credit grants are billed the old way: every active grant raises the allowance by its full credits each month (one-time pools, `credit_grants.recurring = 0`, renew), and all spent units are sent to the Polar meter, including those a grant covers. A one-time grant made late in a month lasts into the next one, so for a long rollback consider setting the `expires_at` of such grants to the first of the next month.
  - Suspended accounts can sign in and use their API keys and OAuth tokens again (the old code does not read `users.status`). Revoke their sessions and keys directly: `DELETE FROM sessions WHERE user_id = ?`, `UPDATE api_keys SET revoked_at = <now ms> WHERE user_id = ? AND revoked_at IS NULL`, and remove their OAuth grants and tokens (KV keys `grant:<userId>:*` and `token:<userId>:*` in `OAUTH_KV`).
  - Settings saved by the old admin screen do not bump `settings_state.version`, so after redeploying, an agent holding an old `expectedVersion` could overwrite them. Run `UPDATE settings_state SET version = version + 1 WHERE id = 1` right after the redeploy.
  - Audit rows written meanwhile have only the legacy columns (`actor`, `action`, `target`, `meta`); `actor_user_id`, `auth_kind` and `via` are empty for that window.

## Caches

KV `CACHE` keys (all expire on their own):

| Prefix | Content |
|---|---|
| `conv:` | Conversion results, one hour. Users can bypass with `fresh=1`. |
| `anon:` | Anonymous daily counters per hashed IP |
| `page:` | Published page cache, purged on publish and unpublish |
| `creem:products`, `polar:products` | Product mapping per provider |
| `stats:` | Public counters |

## Contacts

Owner: Digitop.ai, hello@digitop.ai. Source: github.com/digitopvn/anymd.
