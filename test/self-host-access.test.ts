/** SIGNUP_DISABLED / ANONYMOUS_CONVERT_DISABLED and the deployment's own hostnames in the SSRF guard. */
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../src/worker';
import { anonymousPrincipal, canSignUp } from '../src/auth/identity';
import { normalizeTargetUrl, selfHostnames } from '../src/convert/index';
import type { Env } from '../src/env';
import { createTestEnv, type TestEnv } from './helpers/sqlite-env';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
let t: TestEnv | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

function signup(env: Env, email: string) {
  const body = new URLSearchParams({ email, name: 'Me', password: 'long-enough-password', terms: 'on' });
  return app.fetch(
    new Request('https://anymd.test/signup', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    env,
    ctx,
  );
}

describe('SIGNUP_DISABLED', () => {
  it('keeps sign-up open by default', () => {
    expect(canSignUp({ ADMIN_EMAILS: '' } as Env, 'a@example.com')).toBe(true);
  });

  it('lets only ADMIN_EMAILS create accounts', async () => {
    t = createTestEnv({ SIGNUP_DISABLED: 'true', ADMIN_EMAILS: 'Owner@Example.com' });
    const refused = await signup(t.env, 'stranger@example.com');
    expect(refused.status).toBe(403);
    expect((await refused.text()).includes('Sign-up is closed')).toBe(true);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });

    const owner = await signup(t.env, 'owner@example.com');
    expect(owner.status).toBe(302);
    expect(t.db.prepare('SELECT role FROM users WHERE email = ?').get('owner@example.com')).toEqual({ role: 'owner' });
  });
});

describe('ANONYMOUS_CONVERT_DISABLED', () => {
  it('keeps anonymous conversion by default', () => {
    expect(anonymousPrincipal({} as Env).scopes).toEqual(['convert']);
    expect(anonymousPrincipal({ ANONYMOUS_CONVERT_DISABLED: '0' } as Env).scopes).toEqual(['convert']);
  });

  it('refuses conversions without credentials on every channel', async () => {
    t = createTestEnv({ ANONYMOUS_CONVERT_DISABLED: '1' });
    const byPath = await app.fetch(new Request('https://anymd.test/example.com'), t.env, ctx);
    expect(byPath.status).toBe(401);
    const byApi = await app.fetch(
      new Request('https://anymd.test/api/v1/convert', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }), headers: { 'content-type': 'application/json' } }),
      t.env,
      ctx,
    );
    expect(byApi.status).toBe(401);
  });
});

describe('selfHostnames', () => {
  it('blocks the deployment hosts from PUBLIC_URL and CDN_URL', () => {
    const hosts = selfHostnames({ PUBLIC_URL: 'https://md.example.dev', CDN_URL: 'https://cdn.example.dev/' });
    expect(hosts).toEqual(['md.example.dev', 'cdn.example.dev']);
    expect(() => normalizeTargetUrl('https://md.example.dev/x', hosts)).toThrow();
    expect(() => normalizeTargetUrl('cdn.example.dev/a.png', hosts)).toThrow();
    expect(normalizeTargetUrl('https://example.dev/x', hosts).href).toBe('https://example.dev/x');
  });

  it('ignores missing or malformed vars', () => {
    expect(selfHostnames({ PUBLIC_URL: 'not a url' })).toEqual([]);
  });
});
