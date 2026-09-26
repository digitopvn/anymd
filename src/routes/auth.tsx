/** Email/password and GitHub/Google sign-in, password reset, and the OAuth 2.1 consent screen for MCP clients. */
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createSession, createUser, destroySession, getUserByEmail, hashPassword, SESSION_COOKIE, SESSION_TTL_MS, verifyPassword } from '../auth/identity';
import { capScopes } from '../auth/roles';
import { beginSso, completeSso, enabledSsoProviders, isSsoProvider, SSO_ERRORS, SSO_STATE_COOKIE, SSO_STATE_TTL, SsoError, type SsoErrorCode, type SsoState } from '../auth/sso';
import type { AppBindings } from '../env';
import { resetEmail, sendEmail, welcomeEmail } from '../lib/email';
import { randomToken, sha256 } from '../lib/util';
import { ConsentPage, ForgotPage, LoginPage, ResetPage, SignupPage } from '../views/auth';
import { formData, renderMessage, renderPage, safeNext } from './shared';
import type { AppContext } from '../auth/middleware';

export const authRoutes = new Hono<AppBindings>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TTL = 3600;

async function startSession(c: AppContext, userId: string) {
  const { token } = await createSession(c.env, userId, c.req.header('user-agent') ?? '');
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Per-IP throttle for credential endpoints. */
async function throttled(c: AppContext, bucket: string): Promise<boolean> {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const { success } = await c.env.RL_ANON.limit({ key: `${bucket}:${ip}` });
  return !success;
}

const noindex = { noindex: true, markdownPath: null, variant: 'bare' as const };

authRoutes.get('/login', (c) => {
  if (c.get('user')) return c.redirect(safeNext(c.req.query('next')));
  const notice = c.req.query('reset') ? 'Password updated. Log in with your new password.' : undefined;
  const code = c.req.query('sso_error');
  const error = code && code in SSO_ERRORS ? SSO_ERRORS[code as SsoErrorCode] : undefined;
  return renderPage(c, { title: 'Log in', path: '/login', ...noindex }, <LoginPage next={safeNext(c.req.query('next'))} notice={notice} error={error} providers={enabledSsoProviders(c.env)} />);
});

authRoutes.post('/login', async (c) => {
  const f = await formData(c);
  const next = safeNext(f.next);
  const email = (f.email ?? '').trim().toLowerCase();
  if (await throttled(c, 'login')) return renderPage(c, { title: 'Log in', path: '/login', ...noindex }, <LoginPage next={next} email={email} error="Too many attempts. Wait a minute and try again." providers={enabledSsoProviders(c.env)} />, 429);
  const user = email ? await getUserByEmail(c.env, email) : null;
  const providers = enabledSsoProviders(c.env);
  if (user && !user.password_hash) {
    const via = providers.length ? 'GitHub or Google' : 'a sign-in provider';
    return renderPage(c, { title: 'Log in', path: '/login', ...noindex }, <LoginPage next={next} email={email} providers={providers} error={`This account signs in with ${via}. Use a button above, or reset your password to add one.`} />, 401);
  }
  if (!user || !(await verifyPassword(f.password ?? '', user.password_hash))) {
    return renderPage(c, { title: 'Log in', path: '/login', ...noindex }, <LoginPage next={next} email={email} providers={providers} error="Email or password is incorrect." />, 401);
  }
  await startSession(c, user.id);
  return c.redirect(next);
});

authRoutes.get('/signup', (c) => {
  if (c.get('user')) return c.redirect('/dashboard');
  return renderPage(c, { title: 'Create your account', path: '/signup', noindex: true, markdownPath: null, variant: 'bare' }, <SignupPage next={safeNext(c.req.query('next'))} plan={c.req.query('plan')} interval={c.req.query('interval')} providers={enabledSsoProviders(c.env)} />);
});

authRoutes.post('/signup', async (c) => {
  const f = await formData(c);
  const next = safeNext(f.next);
  const email = (f.email ?? '').trim().toLowerCase();
  const name = (f.name ?? '').trim().slice(0, 80);
  const plan = f.plan === 'pro' || f.plan === 'scale' ? f.plan : '';
  const interval = f.interval === 'year' ? 'year' : 'month';
  const fail = (error: string, status = 400) =>
    renderPage(c, { title: 'Create your account', path: '/signup', ...noindex }, <SignupPage next={next} email={email} name={name} plan={plan} interval={interval} error={error} providers={enabledSsoProviders(c.env)} />, status);
  if (await throttled(c, 'signup')) return fail('Too many attempts. Wait a minute and try again.', 429);
  if (!EMAIL_RE.test(email)) return fail('Enter a valid email address.');
  if ((f.password ?? '').length < 8) return fail('Password must be at least 8 characters.');
  if (!f.terms) return fail('Please accept the Terms and Privacy Policy.');
  if (await getUserByEmail(c.env, email)) return fail('An account with this email already exists. Log in instead.', 409);
  const user = await createUser(c.env, { email, name, password: f.password });
  await startSession(c, user.id);
  const mail = welcomeEmail(c.env, user.name);
  c.executionCtx.waitUntil(sendEmail(c.env, user.email, mail.subject, mail.html, mail.text).catch(() => false));
  return c.redirect(plan ? `/dashboard/billing?plan=${plan}&interval=${interval}` : next);
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(c.env, token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/');
});

authRoutes.get('/forgot', (c) => renderPage(c, { title: 'Reset password', path: '/forgot', ...noindex }, <ForgotPage />));

authRoutes.post('/forgot', async (c) => {
  const f = await formData(c);
  const email = (f.email ?? '').trim().toLowerCase();
  if (await throttled(c, 'forgot')) return renderPage(c, { title: 'Reset password', path: '/forgot', ...noindex }, <ForgotPage error="Too many attempts. Wait a minute and try again." />, 429);
  const user = EMAIL_RE.test(email) ? await getUserByEmail(c.env, email) : null;
  if (user) {
    const token = randomToken(32);
    await c.env.CACHE.put(`reset:${await sha256(token)}`, user.id, { expirationTtl: RESET_TTL });
    const mail = resetEmail(c.env, token);
    c.executionCtx.waitUntil(sendEmail(c.env, user.email, mail.subject, mail.html, mail.text).catch(() => false));
  }
  // Same answer either way, so the form does not reveal which emails have accounts.
  return renderPage(c, { title: 'Reset password', path: '/forgot', ...noindex }, <ForgotPage notice="If that email has an account, a reset link is on its way. Check your inbox." />);
});

authRoutes.get('/reset', (c) => {
  const token = c.req.query('token') ?? '';
  if (!token) return c.redirect('/forgot');
  return renderPage(c, { title: 'Choose a new password', path: '/reset', ...noindex }, <ResetPage token={token} />);
});

authRoutes.post('/reset', async (c) => {
  const f = await formData(c);
  const token = f.token ?? '';
  const key = `reset:${await sha256(token)}`;
  const userId = token ? await c.env.CACHE.get(key) : null;
  if (!userId) return renderPage(c, { title: 'Choose a new password', path: '/reset', ...noindex }, <ResetPage token="" error="This link is invalid or has expired. Request a new one." />, 400);
  if ((f.password ?? '').length < 8) return renderPage(c, { title: 'Choose a new password', path: '/reset', ...noindex }, <ResetPage token={token} error="Password must be at least 8 characters." />, 400);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(f.password), Date.now(), userId),
    // A password change signs out every other session.
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
  ]);
  await c.env.CACHE.delete(key);
  return c.redirect('/login?reset=1');
});

// ─── GitHub / Google sign-in ────────────────────────────────────────────────

const ssoFail = (c: AppContext, code: SsoErrorCode, next = '/dashboard') =>
  c.redirect(`/login?sso_error=${code}${next !== '/dashboard' ? `&next=${encodeURIComponent(next)}` : ''}`);

authRoutes.get('/api/auth/oauth/:provider', async (c) => {
  const provider = c.req.param('provider');
  const next = safeNext(c.req.query('next'));
  if (!isSsoProvider(provider) || !enabledSsoProviders(c.env).includes(provider)) return ssoFail(c, 'unavailable', next);
  if (await throttled(c, 'sso')) return ssoFail(c, 'failed', next);
  const { url, state, data } = await beginSso(c.env, provider, next);
  await c.env.CACHE.put(`sso:${state}`, JSON.stringify(data), { expirationTtl: SSO_STATE_TTL });
  // Binds the round trip to this browser, so a callback URL cannot be replayed into someone else's session.
  setCookie(c, SSO_STATE_COOKIE, state, {
    path: '/api/auth/oauth',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: SSO_STATE_TTL,
  });
  return c.redirect(url);
});

authRoutes.get('/api/auth/oauth/:provider/callback', async (c) => {
  const provider = c.req.param('provider');
  const state = c.req.query('state') ?? '';
  const cookieState = getCookie(c, SSO_STATE_COOKIE);
  deleteCookie(c, SSO_STATE_COOKIE, { path: '/api/auth/oauth' });
  const raw = state ? await c.env.CACHE.get(`sso:${state}`) : null;
  if (raw) await c.env.CACHE.delete(`sso:${state}`);
  const saved = raw ? (JSON.parse(raw) as SsoState) : null;
  if (!saved || !isSsoProvider(provider) || saved.provider !== provider || cookieState !== state) return ssoFail(c, 'expired');
  if (c.req.query('error')) return ssoFail(c, 'denied', saved.next);
  const code = c.req.query('code');
  if (!code) return ssoFail(c, 'failed', saved.next);
  try {
    const { user, created } = await completeSso(c.env, provider, code, saved.verifier);
    await startSession(c, user.id);
    if (created) {
      const mail = welcomeEmail(c.env, user.name);
      c.executionCtx.waitUntil(sendEmail(c.env, user.email, mail.subject, mail.html, mail.text).catch(() => false));
    }
    return c.redirect(saved.next);
  } catch (e) {
    console.error('sso', provider, e instanceof Error ? e.message : e);
    return ssoFail(c, e instanceof SsoError ? e.code : 'failed', saved.next);
  }
});

// ─── OAuth 2.1 consent (MCP clients) ────────────────────────────────────────

authRoutes.get('/oauth/authorize', async (c) => {
  const user = c.get('user');
  if (!user) {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  let authRequest;
  try {
    authRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (e) {
    return renderMessage(c, 400, 'Invalid authorization request', e instanceof Error ? e.message : 'The client sent an invalid request.');
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return renderMessage(c, 400, 'Unknown client', 'This MCP client is not registered. Reconnect it from your agent.');
  const scopes = capScopes(user.role, authRequest.scope.length ? authRequest.scope : null);
  const { handle, headers } = await c.env.OAUTH_PROVIDER.beginConsent(authRequest);
  headers.forEach((v, k) => c.header(k, v, { append: true }));
  return renderPage(
    c,
    { title: 'Authorize MCP client', path: '/oauth/authorize', ...noindex },
    <ConsentPage clientName={client.clientName || 'An MCP client'} clientUri={client.clientUri} scopes={scopes} state={handle} userEmail={user.email} role={user.role} />,
  );
});

authRoutes.post('/oauth/authorize', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  const f = await formData(c);
  try {
    if (f.decision !== 'allow') {
      const denied = await c.env.OAUTH_PROVIDER.denyConsent(c.req.raw, f.state ?? '');
      denied.headers.forEach((v, k) => c.header(k, v, { append: true }));
      return c.redirect(denied.redirectTo);
    }
    const approved = await c.env.OAUTH_PROVIDER.approveConsent(c.req.raw, f.state ?? '');
    const scopes = capScopes(user.role, approved.request.scope.length ? approved.request.scope : null);
    const client = await c.env.OAUTH_PROVIDER.lookupClient(approved.request.clientId);
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: { ...approved.request, scope: scopes },
      userId: user.id,
      metadata: { clientName: client?.clientName ?? 'MCP client', grantedAt: Date.now() },
      scope: scopes,
      props: { userId: user.id, scopes },
    });
    approved.headers.forEach((v, k) => c.header(k, v, { append: true }));
    return c.redirect(redirectTo);
  } catch (e) {
    return renderMessage(c, 400, 'Authorization expired', e instanceof Error ? e.message : 'Start the connection again from your MCP client.');
  }
});
