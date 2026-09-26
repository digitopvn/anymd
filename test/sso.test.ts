import { describe, expect, it } from 'vitest';
import { beginSso, enabledSsoProviders, pickGithubEmail, resolveSsoUser, SsoError, ssoCallbackUrl } from '../src/auth/sso';
import { base64url } from '../src/lib/util';
import type { Env } from '../src/env';

const baseEnv = { PUBLIC_URL: 'https://staging.anymd.cc', ADMIN_EMAILS: '' } as unknown as Env;

describe('sso configuration', () => {
  it('enables a provider only when both id and secret are set', () => {
    expect(enabledSsoProviders(baseEnv)).toEqual([]);
    expect(enabledSsoProviders({ ...baseEnv, GITHUB_CLIENT_ID: 'id' } as Env)).toEqual([]);
    expect(enabledSsoProviders({ ...baseEnv, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: ' ', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's' } as Env)).toEqual(['google']);
  });

  it('derives the callback from PUBLIC_URL unless overridden', () => {
    expect(ssoCallbackUrl(baseEnv, 'github')).toBe('https://staging.anymd.cc/api/auth/oauth/github/callback');
    expect(ssoCallbackUrl({ ...baseEnv, GOOGLE_CALLBACK_URL: 'https://anymd.cc/api/auth/oauth/google/callback' } as Env, 'google')).toBe('https://anymd.cc/api/auth/oauth/google/callback');
  });

  it('builds a PKCE S256 authorization URL', async () => {
    const env = { ...baseEnv, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' } as Env;
    const { url, state, data } = await beginSso(env, 'google', '/dashboard/library');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('client');
    expect(u.searchParams.get('state')).toBe(state);
    expect(u.searchParams.get('redirect_uri')).toBe('https://staging.anymd.cc/api/auth/oauth/google/callback');
    expect(u.searchParams.has('client_secret')).toBe(false);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.verifier));
    expect(u.searchParams.get('code_challenge')).toBe(base64url(new Uint8Array(digest)));
    expect(data).toMatchObject({ provider: 'google', next: '/dashboard/library' });
  });

  it('refuses to start an unconfigured provider', async () => {
    await expect(beginSso(baseEnv, 'github', '/dashboard')).rejects.toBeInstanceOf(SsoError);
  });

  it('picks the primary verified GitHub email', () => {
    expect(pickGithubEmail([{ email: 'a@x.io', primary: true, verified: false }, { email: 'b@x.io', primary: false, verified: true }])).toBe('b@x.io');
    expect(pickGithubEmail([{ email: 'b@x.io', primary: false, verified: true }, { email: 'c@x.io', primary: true, verified: true }])).toBe('c@x.io');
    expect(pickGithubEmail([{ email: 'a@x.io', primary: true, verified: false }])).toBeNull();
  });
});

/** Just enough of D1 for the users / sessions / oauth_accounts statements used by resolveSsoUser. */
function fakeDb() {
  const users: Record<string, Record<string, unknown>> = {};
  const links: Record<string, string> = {};
  const sessions: Record<string, string> = {};
  const exec = (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT user_id FROM oauth_accounts')) {
      const id = links[`${args[0]}:${args[1]}`];
      return id ? { user_id: id } : null;
    }
    if (sql.startsWith('SELECT * FROM users WHERE id')) return users[args[0] as string] ?? null;
    if (sql.startsWith('SELECT * FROM users WHERE email')) return Object.values(users).find((u) => u.email === args[0]) ?? null;
    if (sql.startsWith('INSERT INTO users')) {
      const [id, email, name, password_hash, role, avatar_url, plan] = args;
      users[id as string] = { id, email, name, password_hash, role, avatar_url, plan };
    } else if (sql.startsWith('UPDATE users SET password_hash = NULL')) {
      const u = users[args[2] as string];
      u.password_hash = null;
      u.avatar_url ??= args[0];
    } else if (sql.startsWith('DELETE FROM sessions')) {
      for (const [k, v] of Object.entries(sessions)) if (v === args[0]) delete sessions[k];
    } else if (sql.startsWith('INSERT OR REPLACE INTO oauth_accounts')) {
      links[`${args[0]}:${args[1]}`] = args[2] as string;
    } else throw new Error(`unexpected SQL: ${sql}`);
    return null;
  };
  const prepare = (sql: string) => {
    const stmt = (args: unknown[]) => ({ first: async () => exec(sql, args), run: async () => exec(sql, args), sql, args });
    return { ...stmt([]), bind: (...args: unknown[]) => stmt(args) };
  };
  const DB = { prepare, batch: async (list: { sql: string; args: unknown[] }[]) => list.map((s) => exec(s.sql, s.args)) };
  return { DB, users, links, sessions };
}

describe('resolveSsoUser', () => {
  it('creates a user, then signs the same identity into it again', async () => {
    const db = fakeDb();
    const env = { ...baseEnv, DB: db.DB } as unknown as Env;
    const profile = { id: '42', email: 'New@Example.com', name: 'New Person', avatarUrl: 'https://img/a.png' };
    const first = await resolveSsoUser(env, 'github', profile);
    expect(first.created).toBe(true);
    expect(first.user.email).toBe('new@example.com');
    expect(first.user.password_hash).toBeNull();
    const again = await resolveSsoUser(env, 'github', { ...profile, email: null });
    expect(again).toMatchObject({ created: false, user: { id: first.user.id } });
  });

  it('links by verified email, dropping an unverified password and its sessions', async () => {
    const db = fakeDb();
    db.users.usr_1 = { id: 'usr_1', email: 'me@example.com', name: 'Me', password_hash: 'pbkdf2$x', avatar_url: null };
    db.sessions.s1 = 'usr_1';
    const env = { ...baseEnv, DB: db.DB } as unknown as Env;
    const { user, created } = await resolveSsoUser(env, 'google', { id: 'g-1', email: 'me@example.com', name: 'Me', avatarUrl: 'https://img/b.png' });
    expect(created).toBe(false);
    expect(user.id).toBe('usr_1');
    expect(db.users.usr_1).toMatchObject({ password_hash: null, avatar_url: 'https://img/b.png' });
    expect(db.sessions).toEqual({});
    expect(db.links['google:g-1']).toBe('usr_1');
  });

  it('rejects a new identity without a verified email', async () => {
    const env = { ...baseEnv, DB: fakeDb().DB } as unknown as Env;
    await expect(resolveSsoUser(env, 'github', { id: '7', email: null, name: 'x', avatarUrl: null })).rejects.toMatchObject({ code: 'no_email' });
  });
});
