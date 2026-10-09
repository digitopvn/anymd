import type { Env, Principal, RoleName, WaitUntil } from '../env';
import { base64url, newId, now, randomToken, safeJson, sha256 } from '../lib/util';
import { capScopes, isRole } from './roles';

// ─── Passwords (PBKDF2-SHA256; Workers caps iterations at 100k) ─────────────

const ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, iter, salt, hash] = stored.split('$');
  if (algo !== 'pbkdf2' || !salt || !hash) return false;
  const computed = await pbkdf2(password, fromB64url(salt), Number(iter));
  const expected = fromB64url(hash);
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed[i] ^ expected[i];
  return diff === 0;
}

// ─── Users ──────────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: RoleName;
  avatar_url: string | null;
  plan: string;
  polar_customer_id: string | null;
  creem_customer_id: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  /** `active` or `suspended`; suspended accounts cannot sign in or use keys and OAuth grants. */
  status: UserStatus;
  status_reason: string;
}

export type UserStatus = 'active' | 'suspended';

export async function getUser(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.trim().toLowerCase()).first<UserRow>();
}

function isAdminEmail(env: Env, email: string): boolean {
  return (env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

export async function createUser(env: Env, input: { email: string; name: string; password?: string; avatarUrl?: string }): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  const ts = now();
  // Only an allow-listed email (ADMIN_EMAILS var) becomes the site owner.
  const role: RoleName = isAdminEmail(env, email) ? 'owner' : 'user';
  const user: UserRow = {
    id: newId('usr_'),
    email,
    name: input.name.trim() || email.split('@')[0],
    password_hash: input.password ? await hashPassword(input.password) : null,
    role,
    avatar_url: input.avatarUrl ?? null,
    plan: 'free',
    polar_customer_id: null,
    creem_customer_id: null,
    created_at: ts,
    updated_at: ts,
    last_login_at: ts,
    status: 'active',
    status_reason: '',
  };
  await env.DB.prepare(
    'INSERT INTO users (id,email,name,password_hash,role,avatar_url,plan,created_at,updated_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(user.id, user.email, user.name, user.password_hash, user.role, user.avatar_url, user.plan, ts, ts, ts)
    .run();
  return user;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export const SESSION_COOKIE = 'amd_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function createSession(env: Env, userId: string, userAgent = ''): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const expiresAt = now() + SESSION_TTL_MS;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (id,user_id,created_at,expires_at,user_agent) VALUES (?,?,?,?,?)').bind(
      await sha256(token), userId, now(), expiresAt, userAgent.slice(0, 200),
    ),
    env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), userId),
  ]);
  return { token, expiresAt };
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(token)).run();
}

export async function userFromSession(env: Env, token: string): Promise<UserRow | null> {
  const row = await env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.status != 'suspended'",
  )
    .bind(await sha256(token), now())
    .first<UserRow>();
  return row ?? null;
}

// ─── API keys ───────────────────────────────────────────────────────────────

export const API_KEY_PREFIX = 'amd_';

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  role: RoleName;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

export async function createApiKey(
  env: Env,
  user: UserRow,
  input: { name: string; scopes: string[]; expiresInDays?: number | null },
): Promise<{ key: string; row: ApiKeyRow }> {
  const scopes = capScopes(user.role, input.scopes);
  // An empty list would otherwise be stored as a key that can do nothing; refuse it so callers notice.
  if (!scopes.length) throw Object.assign(new Error('None of the requested scopes are available to your role.'), { status: 422, code: 'no_scopes' });
  const secret = API_KEY_PREFIX + randomToken(24);
  const row: ApiKeyRow = {
    id: newId('key_'),
    user_id: user.id,
    name: input.name.trim().slice(0, 80) || 'API key',
    prefix: secret.slice(0, 10),
    role: user.role,
    scopes: JSON.stringify(scopes),
    created_at: now(),
    last_used_at: null,
    expires_at: input.expiresInDays ? now() + input.expiresInDays * 86400_000 : null,
    revoked_at: null,
  };
  await env.DB.prepare(
    'INSERT INTO api_keys (id,user_id,name,prefix,key_hash,role,scopes,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(row.id, row.user_id, row.name, row.prefix, await sha256(secret), row.role, row.scopes, row.created_at, row.expires_at)
    .run();
  return { key: secret, row };
}

/** Resolve an `amd_…` key into a principal, or null when unknown/revoked/expired. */
export async function principalFromApiKey(env: Env, key: string, ctx?: WaitUntil): Promise<Principal | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const row = await env.DB.prepare(
    'SELECT k.id, k.scopes, k.expires_at, k.revoked_at, u.id AS user_id, u.role AS user_role, u.status AS user_status FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?',
  )
    .bind(await sha256(key))
    .first<{ id: string; scopes: string; expires_at: number | null; revoked_at: number | null; user_id: string; user_role: string; user_status: string }>();
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < now()) || row.user_status === 'suspended') return null;
  const role = isRole(row.user_role) ? row.user_role : 'user';
  const touch = env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now(), row.id).run();
  if (ctx) ctx.waitUntil(touch);
  else await touch;
  return {
    kind: 'api_key',
    userId: row.user_id,
    role,
    // The owner's current role caps the key, so a demoted user's old keys lose power immediately.
    scopes: capScopes(role, safeJson<string[]>(row.scopes, [])),
    apiKeyId: row.id,
  };
}

export function sessionPrincipal(user: UserRow): Principal {
  const role = isRole(user.role) ? user.role : 'user';
  return { kind: 'session', userId: user.id, role, scopes: capScopes(role, null) };
}

export const ANONYMOUS: Principal = { kind: 'anonymous', userId: null, role: 'user', scopes: ['convert'] };
