/**
 * Worker entry. Static files in public/ are served by the ASSETS binding before this runs.
 *
 * Request flow:
 *   /mcp with an `amd_` API key → Hono app (key auth) → MCP server
 *   everything else             → OAuthProvider, which serves the OAuth endpoints, validates OAuth
 *                                 bearer tokens on /mcp (then calls mcpApiHandler with props), and
 *                                 hands all other requests to the Hono app.
 */
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { API_KEY_PREFIX, getUser } from './auth/identity';
import { resolvePrincipal } from './auth/middleware';
import { ALL_SCOPES, isRole, OAUTH_DEFAULT_SCOPES, oauthPrincipalScopes } from './auth/roles';
import { type CreemEvent, creemEnabled, handleCreemEvent, verifyCreemWebhook } from './billing/creem';
import { handlePolarEvent, polarEnabled, verifyPolarWebhook } from './billing/polar';
import { handleVideoQueue, type VideoJobMessage } from './convert/youtube-video';
import type { AppBindings, Env, Principal } from './env';
import { resourceMetadataUrl } from './mcp/protocol';
import { handleMcp } from './mcp/server';
import { adminRoutes } from './routes/admin';
import { api, handleApiError } from './routes/api';
import { authRoutes } from './routes/auth';
import { convertRoutes } from './routes/convert';
import { dashboardRoutes } from './routes/dashboard';
import { publicRoutes } from './routes/public';
import { renderMessage } from './routes/shared';
import { processPendingFeedback } from './services/feedback';
import { processEvents, pruneEvents } from './events/delivery';
import { sweepExpiredSessions } from './convert/social-search-session';
import { recordAudit } from './services/admin/audit';

export const app = new Hono<AppBindings>();

// www → apex, one canonical host.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4);
    return c.redirect(url.toString(), 301);
  }
  await next();
});

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (c.env.ENVIRONMENT !== 'production') c.header('X-Robots-Tag', 'noindex, nofollow');
});

// Creem webhooks carry their own signature; no session or key involved.
app.post('/api/webhooks/creem', async (c) => {
  if (!creemEnabled(c.env)) return c.json({ error: { code: 'billing_provider_disabled', message: 'Creem is not the billing provider here' } }, 404);
  const body = await c.req.text();
  if (!(await verifyCreemWebhook(c.env, c.req.header('creem-signature'), body))) return c.json({ error: { code: 'invalid_signature', message: 'Signature verification failed' } }, 401);
  let event: CreemEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: { code: 'invalid_json', message: 'Body must be JSON' } }, 400);
  }
  if (!event?.id || !event.eventType) return c.json({ error: { code: 'invalid_event', message: 'Missing id or eventType' } }, 400);
  try {
    const outcome = await handleCreemEvent(c.env, event);
    c.executionCtx.waitUntil(recordWebhookOutcome(c.env, event.id, outcome));
    return c.json({ ok: true, outcome });
  } catch (e) {
    console.error('creem webhook', event.eventType, e);
    // Forget the event id so Creem's retry (triggered by the 500) is processed instead of skipped.
    await c.env.DB.prepare('DELETE FROM webhook_events WHERE id = ?').bind(event.id).run().catch(() => undefined);
    c.executionCtx.waitUntil(recordWebhookFailure(c.env, 'creem', event.id, event.eventType, e));
    return c.json({ error: { code: 'internal', message: 'Webhook handling failed' } }, 500);
  }
});

// Polar webhooks carry their own signature; no session or key involved.
app.post('/api/webhooks/polar', async (c) => {
  if (!polarEnabled(c.env)) return c.json({ error: { code: 'billing_provider_disabled', message: 'Polar is not the billing provider here' } }, 404);
  const body = await c.req.text();
  if (!(await verifyPolarWebhook(c.env, c.req.raw.headers, body))) return c.json({ error: { code: 'invalid_signature', message: 'Signature verification failed' } }, 401);
  let event: { type: string; data: unknown };
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: { code: 'invalid_json', message: 'Body must be JSON' } }, 400);
  }
  const webhookId = c.req.header('webhook-id')!;
  try {
    const outcome = await handlePolarEvent(c.env, webhookId, event);
    c.executionCtx.waitUntil(recordWebhookOutcome(c.env, webhookId, outcome));
    return c.json({ ok: true, outcome });
  } catch (e) {
    console.error('polar webhook', event.type, e);
    // Forget the event id so Polar's retry (triggered by the 500) is processed instead of skipped.
    await c.env.DB.prepare('DELETE FROM webhook_events WHERE id = ?').bind(webhookId).run().catch(() => undefined);
    c.executionCtx.waitUntil(recordWebhookFailure(c.env, 'polar', webhookId, event.type, e));
    return c.json({ error: { code: 'internal', message: 'Webhook handling failed' } }, 500);
  }
});

/** Outcome of a processed webhook, for billing diagnostics. A duplicate keeps the first outcome. */
async function recordWebhookOutcome(env: Env, id: string, outcome: string): Promise<void> {
  if (outcome === 'duplicate') return;
  await env.DB.prepare('UPDATE webhook_events SET outcome = ? WHERE id = ?').bind(outcome, id).run().catch((err) => console.error('webhook outcome', err));
}

/** Failed deliveries are deleted for retry, so the failure is kept in the audit log instead. */
async function recordWebhookFailure(env: Env, provider: 'creem' | 'polar', id: string, type: string, err: unknown): Promise<void> {
  const error = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300);
  await recordAudit(env, { system: provider, via: `webhook:${provider}` }, { action: 'billing.webhook_failed', targetType: 'webhook', target: id, meta: { provider, event_type: type, error } }).catch((e) =>
    console.error('webhook failure audit', e),
  );
}

app.use('*', resolvePrincipal);

// MCP over API key. OAuth-token calls to /mcp never reach here (the provider handles them).
app.all('/mcp', (c) => {
  const p = c.get('principal');
  if (c.req.method !== 'OPTIONS' && p.kind !== 'api_key') return mcpUnauthorized(c.env);
  return handleMcp(c.req.raw, c.env, c.executionCtx, p);
});

app.route('/api/v1', api);
app.route('/', authRoutes);
app.route('/dashboard', dashboardRoutes);
app.route('/admin', adminRoutes);
app.route('/', publicRoutes);
app.route('/', convertRoutes);

app.onError((err, c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) return handleApiError(c, err);
  console.error('unhandled', err);
  return renderMessage(c, 500, 'Something broke', 'We logged the error and will look into it. Try again in a moment.');
});
app.notFound((c) => renderMessage(c, 404, 'Page not found', 'That page does not exist.'));

function mcpUnauthorized(env: Env): Response {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'Connect with OAuth, or send Authorization: Bearer amd_… (an anymd API key).' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'WWW-Authenticate',
      // Clients pick the scopes in the challenge first: point them at the least-privilege baseline;
      // elevated scopes are requested later through step-up (403 insufficient_scope).
      'WWW-Authenticate': `Bearer realm="anymd", resource_metadata="${resourceMetadataUrl(env)}", scope="${OAUTH_DEFAULT_SCOPES.join(' ')}"`,
    },
  });
}

/** Props stored with an OAuth grant at consent. `v` marks grants issued with least-privilege consent. */
export interface OAuthGrantProps {
  userId?: string;
  scopes?: string[];
  clientId?: string;
  v?: number;
}

/** The grant id inside an OAuth access token (`userId:grantId:secret`); the provider already validated it. */
function grantIdOf(request: Request, userId: string): string | undefined {
  const auth = request.headers.get('authorization') ?? '';
  const parts = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim().split(':') : [];
  return parts.length === 3 && parts[0] === userId && parts[1] ? parts[1] : undefined;
}

/** OAuth-authenticated MCP calls. The provider has already validated the token. */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: OAuthGrantProps; auth?: { clientId?: string; scope?: string[] } }): Promise<Response> {
    const userId = ctx.props?.userId;
    const user = userId ? await getUser(env, userId) : null;
    if (!user || user.status === 'suspended') {
      // A deleted or suspended account: the token itself is valid, so the provider did not log it.
      logAuthFailure('protected-resource', user ? 'user_suspended' : 'user_missing', 401);
      return mcpUnauthorized(env);
    }
    const role = isRole(user.role) ? user.role : 'user';
    // Re-cap on every call so a demotion takes effect on existing tokens immediately; grants from
    // before least-privilege consent never carry admin scopes; a downscoped token keeps only its own scopes.
    const principal: Principal = {
      kind: 'oauth',
      userId: user.id,
      role,
      scopes: oauthPrincipalScopes(role, ctx.props?.scopes ?? [], ctx.props?.v, ctx.auth?.scope),
      clientId: ctx.auth?.clientId ?? ctx.props?.clientId,
      grantId: grantIdOf(request, user.id),
      requestId: request.headers.get('cf-ray') ?? crypto.randomUUID(),
    };
    return handleMcp(request, env, ctx, principal);
  },
};

/**
 * One structured line per rejected OAuth request (expired, revoked or unknown token, wrong audience,
 * bad PKCE, invalid grant...), for Workers Logs. Only the provider's stable reason codes: never the
 * token, the request, or the error's free-form detail.
 */
function logAuthFailure(category: string, reason: string, status: number, code = 'invalid_token'): void {
  console.warn(JSON.stringify({ event: 'oauth.auth_failed', category, reason, code, status }));
}

/**
 * Failed bearer attempts on /mcp are rate limited per client IP (the anonymous bucket), so a client
 * replaying a dead token, or guessing, is told to back off with 429 instead of an endless stream of 401s.
 */
async function limitAuthFailures(request: Request, env: Env, response: Response): Promise<Response> {
  if (response.status !== 401 || !(request.headers.get('authorization') || request.headers.get('x-api-key'))) return response;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  try {
    const { success } = await env.RL_ANON.limit({ key: `mcp-auth-fail:${ip}` });
    if (success) return response;
  } catch (err) {
    console.error('auth failure limiter unavailable', err instanceof Error ? err.message : String(err));
    return response;
  }
  logAuthFailure('protected-resource', 'auth_failure_rate_limited', 429, 'rate_limited');
  return new Response(JSON.stringify({ error: 'rate_limited', error_description: 'Too many failed authentication attempts. Reconnect anymd, then retry in a minute.' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After' },
  });
}

let provider: OAuthProvider<Env> | null = null;
let providerFor = '';

function oauthProvider(env: Env): OAuthProvider<Env> {
  if (!provider || providerFor !== env.PUBLIC_URL) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApiHandler as never,
      defaultHandler: { fetch: (req, e, ctx) => app.fetch(req, e as Env, ctx) },
      authorizeEndpoint: '/oauth/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: [...ALL_SCOPES],
      // Clients that identify themselves by an HTTPS metadata URL (MCP 2025-11-25 CIMD) need no
      // registration; fetches stay on the public internet (global_fetch_strictly_public).
      clientIdMetadataDocumentEnabled: true,
      onError: ({ code, status, internal }) => logAuthFailure(internal.category, internal.reason, status, code),
      accessTokenTTL: 3600,
      refreshTokenTTL: 60 * 60 * 24 * 30,
      // The authorization server must list every scope so consent can approve elevated ones, but the
      // resource advertises only the baseline: spec-following clients fall back to the resource's
      // scopes_supported when choosing what to request, and must not ask for the admin plane by default.
      resourceMetadata: { resource: `${env.PUBLIC_URL}/mcp`, scopes_supported: [...OAUTH_DEFAULT_SCOPES] },
    });
    providerFor = env.PUBLIC_URL;
  }
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return oauthProvider(env).fetch(request, env, ctx);
    const auth = request.headers.get('authorization') ?? '';
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : request.headers.get('x-api-key') ?? '';
    const response = bearer.startsWith(API_KEY_PREFIX) || request.method === 'OPTIONS' ? await app.fetch(request, env, ctx) : await oauthProvider(env).fetch(request, env, ctx);
    return limitAuthFailures(request, env, response);
  },
  /** Background YouTube video downloads (see `src/convert/youtube-video.ts`). */
  async queue(batch: MessageBatch<VideoJobMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleVideoQueue(batch, env, ctx);
  },
  /**
   * Every minute: MCP Events delivery and retries (see `src/events/delivery.ts`). Every tenth minute:
   * settles feedback waiting on GitHub (rate limits, lost responses; see `src/services/feedback.ts`),
   * sweeps expired social search sessions and prunes old event records.
   */
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const log = (what: string) => (err: unknown) => console.error(what, err instanceof Error ? err.message : String(err));
    // Awaited rather than left to waitUntil: delivery runs for most of the minute, within the
    // scheduled handler's own wall-time limit instead of the shorter limit after it returns.
    const tasks = [processEvents(env).then(() => undefined, log('events delivery failed'))];
    if (new Date(controller.scheduledTime).getUTCMinutes() % 10 === 0) {
      tasks.push(
        processPendingFeedback(env).then(() => undefined, log('feedback retry failed')),
        sweepExpiredSessions(env, Date.now()).then(() => undefined, log('social search session sweep failed')),
        pruneEvents(env).then(() => undefined, log('events prune failed')),
      );
    }
    await Promise.all(tasks);
  },
} satisfies ExportedHandler<Env, VideoJobMessage>;
