# Operations

How to reach, deploy, observe and recover the running anymd.cc service. Setup for a fresh account is in `src/content/docs/self-host.md` (public at `/docs/self-host`); this file covers the Digitop deployment.

## Environments

| Environment | Branch | Hostnames | Worker | Billing |
|---|---|---|---|---|
| `staging` | `dev` | staging.anymd.cc | `anymd-staging` | Creem test mode |
| `production` | `main` | anymd.cc, www.anymd.cc | `anymd` | Creem live |

Bindings, resource names and vars per environment: `wrangler.jsonc`. `BILLING_PROVIDER` picks the live payment provider (`polar` on production, `creem` in test mode on staging; the other provider's code and secrets stay in place but inactive). `CREEM_SERVER` and `POLAR_SERVER` select each provider's API host (see `apiBase` in `src/billing/creem.ts` and `src/billing/polar.ts`).

## Deploy

CI in `.github/workflows/` deploys on push: `dev` → staging, `main` → production. It needs the GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Manual deploy uses the `package.json` scripts:

```bash
npm run db:migrate:staging && npm run deploy:staging
npm run db:migrate:production && npm run deploy:production
```

Order matters: apply migrations first, then deploy code that depends on them. Migrations must be additive so the previous Worker version keeps working during rollout and after a rollback.

Promote to production only after the change is verified on staging, including the responsive check at 375 / 768 / 1440 px listed in `REVIEW.md`.

## Secrets

Secret names and their features are declared in the `Env` interface in `src/env.ts`, with a purpose table in the self-host doc. Values live only in Cloudflare (`wrangler secret put <NAME> --env <env>`) and in the local, git-ignored `.env` / `.dev.vars`.

- Never read a secret value to write docs, tickets or logs. Refer to it by name.
- List what is set without values: `npx wrangler secret list --env production`.
- Rotate by `wrangler secret put` with the new value; the next request picks it up.

Staging uses Creem **test-mode** credentials (`CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`) and Polar **sandbox** credentials. Never put live payment credentials on staging.

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
