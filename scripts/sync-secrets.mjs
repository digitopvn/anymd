// Pushes Worker secrets from .env to Cloudflare without printing their values.
//
//   node --env-file=.env scripts/sync-secrets.mjs staging
//   node --env-file=.env scripts/sync-secrets.mjs production
//
// Only names listed below are sent; empty values are skipped. Polar secrets are read from
// POLAR_ACCESS_TOKEN / POLAR_WEBHOOK_SECRET for staging (sandbox) and from
// POLAR_PRODUCTION_ACCESS_TOKEN / POLAR_PRODUCTION_WEBHOOK_SECRET for production.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const target = process.argv[2];
if (target !== 'staging' && target !== 'production') {
  console.error('Usage: node --env-file=.env scripts/sync-secrets.mjs <staging|production>');
  process.exit(1);
}

const shared = ['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'RESEND_API_KEY', 'RAPIDAPI_KEY', 'VIDCAP_API_KEY', 'GITHUB_TOKEN'];
const secrets = Object.fromEntries(shared.map((k) => [k, process.env[k]]));
const polarPrefix = target === 'production' ? 'POLAR_PRODUCTION_' : 'POLAR_';
secrets.POLAR_ACCESS_TOKEN = process.env[`${polarPrefix}ACCESS_TOKEN`];
secrets.POLAR_WEBHOOK_SECRET = process.env[`${polarPrefix}WEBHOOK_SECRET`];

const payload = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v && v.trim()));
if (!Object.keys(payload).length) {
  console.error('No secrets found in the environment.');
  process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), 'anymd-secrets-'));
const file = path.join(dir, 'secrets.json');
try {
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  const res = spawnSync('npx', ['wrangler', 'secret', 'bulk', file, '--env', target], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`wrangler secret bulk failed (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
  console.log(`${target}: set ${Object.keys(payload).join(', ')}`);
  const skipped = Object.keys(secrets).filter((k) => !(k in payload));
  if (skipped.length) console.log(`${target}: skipped (not in .env) ${skipped.join(', ')}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
