import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppBindings, Principal, Scope } from '../env';
import { ANONYMOUS, API_KEY_PREFIX, principalFromApiKey, sessionPrincipal, SESSION_COOKIE, userFromSession, type UserRow } from './identity';

export type AppContext = Context<AppBindings>;

function bearer(c: AppContext): string | null {
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return c.req.header('x-api-key')?.trim() || null;
}

/**
 * Resolve the caller once per request: API key (Bearer / X-API-Key) → session cookie → anonymous.
 * A request that presents a key which does not resolve is rejected rather than treated as anonymous.
 */
export const resolvePrincipal: MiddlewareHandler<AppBindings> = async (c, next) => {
  let principal: Principal = ANONYMOUS;
  let user: UserRow | null = null;
  const key = bearer(c);
  if (key && key.startsWith(API_KEY_PREFIX)) {
    const p = await principalFromApiKey(c.env, key, c.executionCtx);
    if (!p) return c.json({ error: { code: 'invalid_api_key', message: 'API key is invalid, revoked or expired.' } }, 401);
    principal = p;
  } else {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      user = await userFromSession(c.env, token);
      if (user) principal = sessionPrincipal(user);
    }
  }
  // Correlates audit rows with the edge request (Cloudflare's ray id when present).
  c.set('principal', { ...principal, requestId: c.req.header('cf-ray') ?? crypto.randomUUID() });
  c.set('user', user);
  await next();
};

/** Record which adapter and route acts, e.g. `api:PATCH /api/v1/admin/users/:id`; audit rows carry it. */
export function markVia(c: AppContext, adapter: 'api' | 'web'): void {
  c.set('principal', { ...c.get('principal'), via: `${adapter}:${c.req.method} ${c.req.routePath}` });
}

export function apiError(c: AppContext, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error: { code, message, ...extra } }, status as 400);
}

/** API guard: requires a signed-in principal holding every listed scope. */
export function requireScope(...scopes: Scope[]): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const p = c.get('principal');
    // Anonymous callers hold only the scopes granted to everyone (URL conversion at the anonymous limit).
    const anonymousOk = !p.userId && scopes.every((s) => p.scopes.includes(s));
    if (!p.userId && !anonymousOk) return apiError(c, 401, 'unauthorized', 'Sign in or send an API key: Authorization: Bearer amd_…');
    const missing = scopes.filter((s) => !p.scopes.includes(s));
    if (missing.length) return apiError(c, 403, 'forbidden', `Missing scope: ${missing.join(', ')}`, { required: scopes });
    markVia(c, 'api');
    await next();
  };
}

/**
 * Cookie-authenticated writes must come from our own origin. API-key and OAuth requests carry no
 * ambient credentials, so they are exempt.
 */
export const sameOriginWrites: MiddlewareHandler<AppBindings> = async (c, next) => {
  const p = c.get('principal');
  if (p.kind === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    const self = new URL(c.req.url).origin;
    if (origin && origin !== self) return apiError(c, 403, 'bad_origin', 'Cross-origin request blocked');
  }
  await next();
};

/** Page guard: redirect anonymous visitors to the login page. */
export const requireUserPage: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get('user')) {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  await next();
};

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.scopes.includes(scope);
}
