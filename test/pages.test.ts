/** Renders every public HTML page through the real Hono app with in-memory bindings, so JSX/runtime errors fail here instead of in production. */
import { describe, expect, it } from 'vitest';
import { app } from '../src/worker';
import type { Env } from '../src/env';

const kv = () => {
  const m = new Map<string, string>();
  return {
    get: async (k: string, t?: string) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)!) : m.get(k)) : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
};
const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: {} }), raw: async () => [] };
const env = {
  ENVIRONMENT: 'staging',
  PUBLIC_URL: 'https://staging.anymd.cc',
  CDN_URL: 'https://cdn.anymd.cc',
  GITHUB_REPO: 'digitopvn/anymd',
  BILLING_PROVIDER: 'creem',
  CREEM_SERVER: 'test',
  POLAR_SERVER: 'sandbox',
  DB: { prepare: () => stmt, batch: async () => [] },
  CACHE: kv(),
  OAUTH_KV: kv(),
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  RL_ANON: { limit: async () => ({ success: true }) },
  RL_AUTH: { limit: async () => ({ success: true }) },
} as unknown as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

const PAGES = ['/', '/pricing', '/docs', '/docs/api', '/docs/mcp', '/docs/cli', '/blog', '/ecosystem', '/legal/terms', '/legal/privacy', '/legal/refund', '/legal/cookies', '/legal/gdpr', '/login', '/signup'];

describe('public pages render', () => {
  for (const path of PAGES) {
    it(path, async () => {
      const res = await app.fetch(new Request(`https://staging.anymd.cc${path}`), env, ctx);
      const body = await res.text();
      expect(res.status, body.slice(0, 300)).toBe(200);
      expect(body.includes('</html>')).toBe(true);
      expect(body.includes('og/share.jpg')).toBe(true);
    });
  }
});
