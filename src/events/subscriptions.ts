/**
 * MCP Events webhook subscriptions (`events/list`, `events/subscribe`, `events/unsubscribe`), served
 * only to the modern protocol era and only to API-key and OAuth credentials. A subscription is
 * keyed by (credential, callback url, event name, canonical arguments), lives at most a day without
 * a refresh, starts delivering only after the endpoint echoed a verification challenge, and grants
 * nothing: an event tells the agent something changed; acting on it goes through normal tool
 * authorization (no credits are spent and no feedback is submitted because of a subscription).
 */
import type { Env, Principal, WaitUntil } from '../env';
import { now } from '../lib/util';
import { EVENTS_RPC, RPC } from '../mcp/protocol';
import { assertPublicCallback, CallbackUrlError, parseCallbackUrl } from './callback-url';
import { EVENT_BY_NAME, EVENTS, eventDescriptor } from './catalog';
import { actorHash, decryptSecret, encryptSecret, parseWebhookSecret, subscriptionId } from './crypto';
import { SECRET_GRACE_MS, sendTerminated, type SubscriptionRow, verifyEndpoint } from './delivery';
import { eventsEnabled, principalKey } from './outbox';

export const DEFAULT_TTL_MS = 60 * 60_000;
export const MAX_TTL_MS = 24 * 60 * 60_000;
export const MIN_TTL_MS = 60_000;
export const MAX_SUBSCRIPTIONS_PER_USER = 20;

export class EventsRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

/** Events need a credential to bind subscriptions to; browser sessions never reach MCP. */
export function eventsAvailable(env: Env, p: Principal): boolean {
  return eventsEnabled(env) && principalKey(p) !== null;
}

function requireKey(p: Principal): string {
  const key = principalKey(p);
  if (!key || !p.userId) throw new EventsRpcError(EVENTS_RPC.FORBIDDEN, 'Forbidden', { reason: 'Events need an API key or OAuth credential' });
  return key;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new EventsRpcError(RPC.INVALID_PARAMS, `${what} must be an object`);
  return v as Record<string, unknown>;
}

function eventFor(name: unknown, p: Principal) {
  const def = typeof name === 'string' ? EVENT_BY_NAME.get(name as never) : undefined;
  if (!def) throw new EventsRpcError(EVENTS_RPC.NOT_FOUND, `Unknown event: ${String(name)}`, { kind: 'event' });
  if (!p.scopes.includes(def.scope)) throw new EventsRpcError(EVENTS_RPC.FORBIDDEN, `${def.name} needs the ${def.scope} scope`, { reason: 'missing_scope', required: [def.scope] });
  return def;
}

function callbackUrl(env: Env, raw: unknown): URL {
  try {
    return parseCallbackUrl(env, raw);
  } catch (err) {
    throw new EventsRpcError(RPC.INVALID_PARAMS, err instanceof Error ? err.message : 'Invalid delivery.url');
  }
}

function argumentsFor(def: { args: { safeParse(v: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } } }, raw: unknown) {
  const args = obj(raw, 'arguments');
  const parsed = def.args.safeParse(args);
  if (!parsed.success) {
    throw new EventsRpcError(RPC.INVALID_PARAMS, 'Invalid arguments', { issues: parsed.error?.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) });
  }
  return args;
}

export function listEvents(p: Principal) {
  return { events: EVENTS.filter((e) => p.scopes.includes(e.scope)).map(eventDescriptor) };
}

function grantTtl(raw: unknown): number {
  if (raw === undefined) return DEFAULT_TTL_MS;
  if (raw === null) return MAX_TTL_MS;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) throw new EventsRpcError(RPC.INVALID_PARAMS, 'ttlMs must be a positive number or null');
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.trunc(raw)));
}

const iso = (ts: number | null) => (ts ? new Date(ts).toISOString() : null);

export async function subscribe(env: Env, p: Principal, params: Record<string, unknown> | undefined) {
  const key = requireKey(p);
  const userId = p.userId!;
  const def = eventFor(params?.name, p);
  const args = argumentsFor(def, params?.arguments);
  const delivery = obj(params?.delivery, 'delivery');
  if (delivery.mode !== undefined && delivery.mode !== 'webhook') throw new EventsRpcError(EVENTS_RPC.UNSUPPORTED, 'Only webhook delivery is supported', { feature: 'deliveryMode', value: delivery.mode });
  const url = callbackUrl(env, delivery.url);
  const secret = delivery.secret;
  if (!parseWebhookSecret(secret)) throw new EventsRpcError(RPC.INVALID_PARAMS, 'delivery.secret must be whsec_ followed by base64 of 24 to 64 random bytes');
  const ttl = grantTtl(params?.ttlMs);
  const cursor = params?.cursor ?? null;
  if (cursor !== null && typeof cursor !== 'string') throw new EventsRpcError(RPC.INVALID_PARAMS, 'cursor must be a string or null');

  const id = await subscriptionId(key, url.href, def.name, args);
  const ts = now();
  const existing = await env.DB.prepare('SELECT * FROM event_subscriptions WHERE id = ? AND user_id = ?').bind(id, userId).first<SubscriptionRow>();
  if (!existing || existing.expires_at <= ts) {
    const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM event_subscriptions WHERE user_id = ? AND expires_at > ? AND id != ?').bind(userId, ts, id).first<{ n: number }>();
    if ((live?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw new EventsRpcError(EVENTS_RPC.RESOURCE_EXHAUSTED, `At most ${MAX_SUBSCRIPTIONS_PER_USER} live subscriptions per account`, { limit: 'subscriptions', max: MAX_SUBSCRIPTIONS_PER_USER });
    }
  }
  try {
    await assertPublicCallback(env, url.href);
  } catch (err) {
    if (err instanceof CallbackUrlError && err.reason === 'unresolvable') throw new EventsRpcError(EVENTS_RPC.CALLBACK_ENDPOINT_ERROR, 'The callback endpoint could not be reached', { reason: 'connection_refused' });
    throw new EventsRpcError(RPC.INVALID_PARAMS, err instanceof Error ? err.message : 'Invalid delivery.url');
  }

  // Verification is per (credential, url): one handshake covers every event and argument set.
  const verified =
    existing?.verified_at ??
    (await env.DB.prepare('SELECT verified_at FROM event_subscriptions WHERE principal = ? AND url = ? AND user_id = ? AND verified_at IS NOT NULL LIMIT 1').bind(key, url.href, userId).first<number>('verified_at'));
  let verifiedAt = verified ?? null;
  if (!verifiedAt) {
    const limiter = env.RL_MCP_MUTATION ?? env.RL_AUTH;
    if (!(await limiter.limit({ key: `events:verify:${url.hostname}` })).success) {
      throw new EventsRpcError(EVENTS_RPC.RESOURCE_EXHAUSTED, 'Too many verification attempts for this host. Retry later.', { limit: 'verification' });
    }
    const failure = await verifyEndpoint(env, { subscriptionId: id, url: url.href, secrets: [secret as string] });
    if (failure) throw new EventsRpcError(EVENTS_RPC.CALLBACK_ENDPOINT_ERROR, 'The callback endpoint failed verification', { reason: failure });
    verifiedAt = now();
  }

  const secretEnc = await encryptSecret(env, secret as string);
  let prevEnc = existing?.prev_secret_enc ?? null;
  let prevUntil = existing?.prev_secret_until ?? null;
  if (existing && (await decryptSecret(env, existing.secret_enc)) !== secret) {
    prevEnc = existing.secret_enc;
    prevUntil = ts + SECRET_GRACE_MS;
  }
  const expiresAt = ts + ttl;
  await env.DB.prepare(
    `INSERT INTO event_subscriptions (id,user_id,principal,principal_hash,name,arguments_json,url,secret_enc,prev_secret_enc,prev_secret_until,scope,active,verified_at,expires_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET secret_enc = excluded.secret_enc, prev_secret_enc = excluded.prev_secret_enc, prev_secret_until = excluded.prev_secret_until,
       active = 1, verified_at = excluded.verified_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at,
       created_at = CASE WHEN event_subscriptions.expires_at <= excluded.updated_at THEN excluded.created_at ELSE event_subscriptions.created_at END`,
  )
    .bind(id, userId, key, await actorHash(key), def.name, JSON.stringify(args), url.href, secretEnc, prevEnc, prevUntil, def.scope, verifiedAt, expiresAt, ts, ts)
    .run();

  const result: Record<string, unknown> = { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: cursor !== null };
  if (existing) {
    result.deliveryStatus = {
      active: existing.active === 1 && existing.expires_at > ts,
      lastDeliveryAt: iso(existing.last_delivery_at),
      lastError: existing.last_error,
      ...(existing.failed_since ? { failedSince: iso(existing.failed_since) } : {}),
    };
  }
  return result;
}

export async function unsubscribe(env: Env, p: Principal, params: Record<string, unknown> | undefined) {
  const key = requireKey(p);
  const name = params?.name;
  if (typeof name !== 'string' || !EVENT_BY_NAME.has(name as never)) throw new EventsRpcError(EVENTS_RPC.NOT_FOUND, `Unknown event: ${String(name)}`, { kind: 'event' });
  const url = callbackUrl(env, obj(params?.delivery, 'delivery').url);
  const id = await subscriptionId(key, url.href, name, obj(params?.arguments, 'arguments'));
  const res = await env.DB.prepare('DELETE FROM event_subscriptions WHERE id = ? AND user_id = ? AND principal = ?').bind(id, p.userId, key).run();
  if (!res.meta.changes) throw new EventsRpcError(EVENTS_RPC.NOT_FOUND, 'No matching subscription', { kind: 'subscription' });
  return {};
}

/** JSON-RPC handling of the three methods. Null when `method` is not an events method. */
export async function handleEventsMethod(env: Env, p: Principal, method: string, params: Record<string, unknown> | undefined): Promise<Record<string, unknown> | null> {
  switch (method) {
    case 'events/list':
      requireKey(p);
      return listEvents(p);
    case 'events/subscribe':
      return subscribe(env, p, params);
    case 'events/unsubscribe':
      return unsubscribe(env, p, params);
  }
  return null;
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export interface SubscriptionView {
  id: string;
  name: string;
  url: string;
  credential: string;
  arguments: string;
  active: boolean;
  expiresAt: number;
  lastDeliveryAt: number | null;
  lastError: string | null;
  pending: number;
  dead: number;
}

/** The owner's live subscriptions with delivery health, for the dashboard. Secrets never leave the database. */
export async function listSubscriptionsForOwner(env: Env, userId: string): Promise<SubscriptionView[]> {
  if (!eventsEnabled(env)) return [];
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.name, s.url, s.principal, s.arguments_json, s.active, s.expires_at, s.last_delivery_at, s.last_error,
       (SELECT COUNT(*) FROM event_deliveries d WHERE d.subscription_id = s.id AND d.status = 'pending') AS pending,
       (SELECT COUNT(*) FROM event_deliveries d WHERE d.subscription_id = s.id AND d.status = 'dead') AS dead
     FROM event_subscriptions s WHERE s.user_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC LIMIT 100`,
  )
    .bind(userId, now())
    .all<{ id: string; name: string; url: string; principal: string; arguments_json: string; active: number; expires_at: number; last_delivery_at: number | null; last_error: string | null; pending: number; dead: number }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    credential: r.principal.startsWith('api_key:') ? 'API key' : 'Connected app',
    arguments: r.arguments_json === '{}' ? '' : r.arguments_json,
    active: r.active === 1,
    expiresAt: r.expires_at,
    lastDeliveryAt: r.last_delivery_at,
    lastError: r.last_error,
    pending: Number(r.pending),
    dead: Number(r.dead),
  }));
}

/** The owner deletes a subscription; the endpoint gets a signed `terminated` envelope. */
export async function deleteSubscriptionForOwner(env: Env, userId: string, id: string, ctx?: WaitUntil): Promise<boolean> {
  const sub = await env.DB.prepare('SELECT * FROM event_subscriptions WHERE id = ? AND user_id = ?').bind(id, userId).first<SubscriptionRow>();
  if (!sub) return false;
  await env.DB.prepare('DELETE FROM event_subscriptions WHERE id = ? AND user_id = ?').bind(id, userId).run();
  // A slow endpoint must not hold up the owner's page; the notice is best-effort either way.
  const notice = sendTerminated(env, sub, 'deleted_by_owner');
  if (ctx) ctx.waitUntil(notice);
  else await notice;
  return true;
}
