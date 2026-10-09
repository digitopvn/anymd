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

/** OAuth-authenticated MCP calls. The provider has already validated the token. */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: OAuthGrantProps; auth?: { clientId?: string; scope?: string[] } }): Promise<Response> {
    const userId = ctx.props?.userId;
    const user = userId ? await getUser(env, userId) : null;
    if (!user || user.status === 'suspended') return mcpUnauthorized(env);
    const role = isRole(user.role) ? user.role : 'user';
    // Re-cap on every call so a demotion takes effect on existing tokens immediately; grants from
    // before least-privilege consent never carry admin scopes; a downscoped token keeps only its own scopes.
    const principal: Principal = {
      kind: 'oauth',
      userId: user.id,
      role,
      scopes: oauthPrincipalScopes(role, ctx.props?.scopes ?? [], ctx.props?.v, ctx.auth?.scope ?? []),
      clientId: ctx.auth?.clientId ?? ctx.props?.clientId,
      requestId: request.headers.get('cf-ray') ?? crypto.randomUUID(),
    };
    return handleMcp(request, env, ctx, principal);
  },
};

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
    if (url.pathname === '/mcp') {
      const auth = request.headers.get('authorization') ?? '';
      const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : request.headers.get('x-api-key') ?? '';
      if (bearer.startsWith(API_KEY_PREFIX) || request.method === 'OPTIONS') return app.fetch(request, env, ctx);
    }
    return oauthProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
