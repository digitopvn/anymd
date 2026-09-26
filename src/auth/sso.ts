/**
 * GitHub and Google sign-in (OAuth 2.0 authorization code + PKCE).
 * A provider is enabled only when both its client id and secret are set.
 */
import type { Env } from '../env';
import { base64url, now, randomToken } from '../lib/util';
import { createUser, getUser, getUserByEmail, type UserRow } from './identity';

export type SsoProvider = 'github' | 'google';
export const SSO_PROVIDERS: readonly SsoProvider[] = ['github', 'google'];
export const SSO_LABEL: Record<SsoProvider, string> = { github: 'GitHub', google: 'Google' };
export const SSO_STATE_COOKIE = 'amd_sso';
export const SSO_STATE_TTL = 600;

/** The profile we keep from a provider. `email` is only set when the provider says it is verified. */
export interface SsoProfile {
  id: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
}

export interface SsoState {
  provider: SsoProvider;
  verifier: string;
  next: string;
}

/** Error codes shown on /login; the page maps them to fixed copy so nothing from the URL is echoed. */
export type SsoErrorCode = 'unavailable' | 'denied' | 'expired' | 'no_email' | 'failed';
export const SSO_ERRORS: Record<SsoErrorCode, string> = {
  unavailable: 'That sign-in option is not available right now. Use email and password instead.',
  denied: 'Sign-in was cancelled.',
  expired: 'That sign-in attempt expired. Please try again.',
  no_email: 'Your account has no verified email address. Verify one with the provider, or sign up with email.',
  failed: 'We could not complete sign-in with that provider. Please try again.',
};

export class SsoError extends Error {
  constructor(public code: SsoErrorCode, message?: string) {
    super(message ?? code);
  }
}

const ENDPOINTS: Record<SsoProvider, { authorize: string; token: string; scope: string }> = {
  github: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'read:user user:email' },
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email profile' },
};

export function isSsoProvider(value: string): value is SsoProvider {
  return (SSO_PROVIDERS as readonly string[]).includes(value);
}

function credentials(env: Env, provider: SsoProvider): { clientId: string; clientSecret: string } | null {
  const clientId = (provider === 'github' ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID)?.trim();
  const clientSecret = (provider === 'github' ? env.GITHUB_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET)?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function enabledSsoProviders(env: Env): SsoProvider[] {
  return SSO_PROVIDERS.filter((p) => credentials(env, p));
}

/** The redirect URI registered with the provider: the explicit override, else derived from PUBLIC_URL. */
export function ssoCallbackUrl(env: Env, provider: SsoProvider): string {
  const override = (provider === 'github' ? env.GITHUB_CALLBACK_URL : env.GOOGLE_CALLBACK_URL)?.trim();
  return override || `${env.PUBLIC_URL.replace(/\/+$/, '')}/api/auth/oauth/${provider}/callback`;
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Builds the provider URL and the state to remember until the callback. */
export async function beginSso(env: Env, provider: SsoProvider, next: string): Promise<{ url: string; state: string; data: SsoState }> {
  const creds = credentials(env, provider);
  if (!creds) throw new SsoError('unavailable');
  const state = randomToken(24);
  const verifier = randomToken(48);
  const url = new URL(ENDPOINTS[provider].authorize);
  url.search = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: ssoCallbackUrl(env, provider),
    response_type: 'code',
    scope: ENDPOINTS[provider].scope,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    ...(provider === 'google' ? { prompt: 'select_account' } : { allow_signup: 'true' }),
  }).toString();
  return { url: url.toString(), state, data: { provider, verifier, next } };
}

async function exchangeCode(env: Env, provider: SsoProvider, code: string, verifier: string): Promise<string> {
  const creds = credentials(env, provider);
  if (!creds) throw new SsoError('unavailable');
  const res = await fetch(ENDPOINTS[provider].token, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: ssoCallbackUrl(env, provider),
      grant_type: 'authorization_code',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new SsoError('failed', `${provider} token exchange: ${body.error ?? res.status}`);
  return body.access_token;
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** Primary verified address first, then any verified one. */
export function pickGithubEmail(emails: GithubEmail[]): string | null {
  const verified = emails.filter((e) => e.verified && e.email);
  return (verified.find((e) => e.primary) ?? verified[0])?.email ?? null;
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'anymd.cc' } });
  if (!res.ok) throw new SsoError('failed', `${new URL(url).host} ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchProfile(provider: SsoProvider, token: string): Promise<SsoProfile> {
  if (provider === 'github') {
    const [user, emails] = await Promise.all([
      getJson<{ id: number; login: string; name: string | null; avatar_url: string | null }>('https://api.github.com/user', token),
      getJson<GithubEmail[]>('https://api.github.com/user/emails', token),
    ]);
    return { id: String(user.id), email: pickGithubEmail(emails), name: user.name || user.login, avatarUrl: user.avatar_url };
  }
  const info = await getJson<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>('https://openidconnect.googleapis.com/v1/userinfo', token);
  return { id: info.sub, email: info.email && info.email_verified ? info.email : null, name: info.name ?? '', avatarUrl: info.picture ?? null };
}

/**
 * Finds or creates the local user for a provider identity.
 * Order: an existing link, then an account with the same verified email (linked now), then a new account.
 */
export async function resolveSsoUser(env: Env, provider: SsoProvider, profile: SsoProfile): Promise<{ user: UserRow; created: boolean }> {
  const linked = await env.DB.prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?').bind(provider, profile.id).first<{ user_id: string }>();
  if (linked) {
    const user = await getUser(env, linked.user_id);
    if (user) return { user, created: false };
  }
  if (!profile.email) throw new SsoError('no_email');
  const email = profile.email.trim().toLowerCase();
  let user = await getUserByEmail(env, email);
  const created = !user;
  if (!user) user = await createUser(env, { email, name: profile.name.slice(0, 80), avatarUrl: profile.avatarUrl ?? undefined });
  else {
    // Sign-up does not verify email, so a password on this account may have been set by someone
    // who registered the address first. The provider has now proven ownership: drop that password
    // and its sessions. The owner can add a password again through "Forgot password".
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = NULL, avatar_url = COALESCE(avatar_url, ?), updated_at = ? WHERE id = ?').bind(profile.avatarUrl, now(), user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ]);
  }
  await env.DB.prepare('INSERT OR REPLACE INTO oauth_accounts (provider, provider_user_id, user_id, email, created_at) VALUES (?,?,?,?,?)')
    .bind(provider, profile.id, user.id, email, now())
    .run();
  return { user, created };
}

/** Code → token → profile → local user. */
export async function completeSso(env: Env, provider: SsoProvider, code: string, verifier: string) {
  const token = await exchangeCode(env, provider, code, verifier);
  return resolveSsoUser(env, provider, await fetchProfile(provider, token));
}
