/**
 * MCP Events delivery: fan committed outbox events out to matching subscriptions, then POST each
 * delivery to its callback with Standard Webhooks signatures. At-least-once: a delivery is retried
 * with bounded exponential backoff until the endpoint answers 2xx, then dead-lettered; receivers
 * deduplicate on `webhook-id` (the event id). Runs right after a change (waitUntil) and on the
 * per-minute scheduler, which also retries and prunes.
 *
 * Before every delivery the subscribing credential is re-checked; a revoked key or grant, a lost
 * scope or a suspended account ends the subscription with a signed `terminated` envelope.
 */
import { capScopes, expandScopes, isRole, scopesForRole } from '../auth/roles';
import type { Env, Scope } from '../env';
import { normalizeTag } from '../library/store';
import { now, safeJson } from '../lib/util';
import { EVENTS_RPC } from '../mcp/protocol';
import { assertPublicCallback, CallbackUrlError } from './callback-url';
import { decryptSecret, randomNonce, safeEqual, signWebhook } from './crypto';
import { onEventsWritten } from './outbox';

export type DeliveryError = 'connection_refused' | 'timeout' | 'tls_error' | 'http_4xx' | 'http_5xx' | 'challenge_failed';

/** Delay before attempt n+1 after n failed attempts; five attempts within about 15 minutes. */
export const RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 480_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const MAX_BODY_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;
/** A claimed delivery is not picked up again for this long, so overlapping runs do not double-send. */
const CLAIM_MS = 60_000;
const FANOUT_BATCH = 100;
const DELIVERY_BATCH = 50;
/** Undelivered backlog per owner; events beyond it are not queued (the endpoint is too far behind). */
export const MAX_PENDING_PER_USER = 500;
/** Old callback secret keeps signing (alongside the new one) this long after a rotation. */
export const SECRET_GRACE_MS = 60 * 60_000;

const DAY = 24 * 60 * 60_000;

export interface SubscriptionRow {
  id: string;
  user_id: string;
  principal: string;
  principal_hash: string;
  name: string;
  arguments_json: string;
  url: string;
  secret_enc: string;
  prev_secret_enc: string | null;
  prev_secret_until: number | null;
  scope: string;
  active: number;
  verified_at: number | null;
  expires_at: number;
  last_delivery_at: number | null;
  last_error: string | null;
  failed_since: number | null;
  created_at: number;
  updated_at: number;
}

interface OutboxRow {
  id: string;
  user_id: string;
  name: string;
  resource_id: string;
  data_json: string;
  actor_hash: string | null;
  correlation_id: string | null;
  created_at: number;
}

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: DeliveryError;
  /** False for 410/413 and oversized bodies: the event is given up at once. */
  retryable: boolean;
  /** Up to 4 KiB of a 2xx body, only for the verification handshake. Never stored or returned. */
  text?: string;
}

/** The signing secrets of a subscription: current, plus the previous one during the rotation grace window. */
export async function signingSecrets(env: Env, sub: Pick<SubscriptionRow, 'secret_enc' | 'prev_secret_enc' | 'prev_secret_until'>): Promise<string[]> {
  const out: string[] = [];
  const current = await decryptSecret(env, sub.secret_enc);
  if (current) out.push(current);
  if (sub.prev_secret_enc && (sub.prev_secret_until ?? 0) > now()) {
    const prev = await decryptSecret(env, sub.prev_secret_enc);
    if (prev) out.push(prev);
  }
  return out;
}

function classify(err: unknown): DeliveryError {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  if (name === 'TimeoutError' || name === 'AbortError' || message.includes('timed out')) return 'timeout';
  if (message.includes('tls') || message.includes('ssl') || message.includes('certificate')) return 'tls_error';
  return 'connection_refused';
}

async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(size, limit));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - at);
    all.set(part, at);
    at += part.length;
    if (at >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/**
 * One signed POST. The callback host is re-resolved and must still be public (DNS rebinding);
 * redirects are never followed and count as a failed attempt.
 */
export async function postWebhook(env: Env, target: { subscriptionId: string; url: string; secrets: string[] }, webhookId: string, body: string, wantText = false): Promise<PostResult> {
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return { ok: false, error: 'http_4xx', retryable: false };
  if (!target.secrets.length) return { ok: false, error: 'connection_refused', retryable: false };
  try {
    await assertPublicCallback(env, target.url);
  } catch (err) {
    // Refused before connecting: a host that now resolves privately, or does not resolve.
    return { ok: false, error: 'connection_refused', retryable: !(err instanceof CallbackUrlError && err.reason !== 'unresolvable') };
  }
  const timestamp = Math.floor(Date.now() / 1000);
  let res: Response;
  try {
    res = await fetch(target.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': await signWebhook(target.secrets, webhookId, timestamp, body),
        'X-MCP-Subscription-Id': target.subscriptionId,
        'User-Agent': 'anymd-mcp-events/1',
      },
      body,
    });
  } catch (err) {
    return { ok: false, error: classify(err), retryable: true };
  }
  if (res.status >= 200 && res.status < 300) {
    const text = wantText ? await readCapped(res, 4096).catch(() => '') : undefined;
    if (!wantText) await res.body?.cancel().catch(() => undefined);
    return { ok: true, status: res.status, retryable: false, text };
  }
  await res.body?.cancel().catch(() => undefined);
  return { ok: false, status: res.status, error: res.status >= 500 ? 'http_5xx' : 'http_4xx', retryable: res.status !== 410 && res.status !== 413 };
}

/**
 * Verification handshake: POST a `verification` envelope with a fresh nonce; the endpoint proves it
 * wants deliveries by echoing `{"challenge": nonce}` in a 2xx body. Null on success.
 */
export async function verifyEndpoint(env: Env, target: { subscriptionId: string; url: string; secrets: string[] }): Promise<DeliveryError | null> {
  const challenge = randomNonce();
  const res = await postWebhook(env, target, `msg_verification_${randomNonce(12)}`, JSON.stringify({ type: 'verification', challenge }), true);
  if (!res.ok) return res.error ?? 'connection_refused';
  const echoed = safeJson<{ challenge?: unknown }>(res.text, {}).challenge;
  return typeof echoed === 'string' && safeEqual(echoed, challenge) ? null : 'challenge_failed';
}

/** Best-effort signed `terminated` envelope; the subscription is gone either way. */
export async function sendTerminated(env: Env, sub: SubscriptionRow, reason: string): Promise<void> {
  const secrets = await signingSecrets(env, sub);
  const body = JSON.stringify({ type: 'terminated', error: { code: EVENTS_RPC.FORBIDDEN, message: 'Forbidden', data: { reason } } });
  await postWebhook(env, { subscriptionId: sub.id, url: sub.url, secrets }, `msg_terminated_${randomNonce(12)}`, body).catch(() => undefined);
}

/**
 * Is the subscribing credential still allowed to receive this event? Null when yes, otherwise the
 * reason it is not: the account is gone or suspended, the role lost the scope, the API key was
 * revoked, expired or narrowed, or the OAuth grant was revoked.
 */
export async function revocationReason(env: Env, sub: Pick<SubscriptionRow, 'user_id' | 'principal' | 'scope'>): Promise<string | null> {
  const user = await env.DB.prepare('SELECT role, status FROM users WHERE id = ?').bind(sub.user_id).first<{ role: string; status: string }>();
  if (!user || user.status === 'suspended') return 'account_unavailable';
  const role = isRole(user.role) ? user.role : 'user';
  const scope = sub.scope as Scope;
  if (!scopesForRole(role).includes(scope)) return 'scope_revoked';
  const [kind, id] = [sub.principal.slice(0, sub.principal.indexOf(':')), sub.principal.slice(sub.principal.indexOf(':') + 1)];
  if (kind === 'api_key') {
    const key = await env.DB.prepare('SELECT scopes, expires_at, revoked_at FROM api_keys WHERE id = ? AND user_id = ?').bind(id, sub.user_id).first<{ scopes: string; expires_at: number | null; revoked_at: number | null }>();
    if (!key || key.revoked_at || (key.expires_at && key.expires_at < now())) return 'credential_revoked';
    return capScopes(role, safeJson<string[]>(key.scopes, [])).includes(scope) ? null : 'scope_revoked';
  }
  if (kind === 'oauth') {
    const grant = await env.OAUTH_KV.get<{ scope?: string[] }>(`grant:${sub.user_id}:${id}`, 'json');
    if (!grant) return 'credential_revoked';
    if (grant.scope?.length && !expandScopes(grant.scope).includes(scope)) return 'scope_revoked';
    return null;
  }
  return 'credential_revoked';
}

/** End a subscription because its credential lost access: notify the endpoint, then delete it. */
export async function terminateSubscription(env: Env, sub: SubscriptionRow, reason: string): Promise<void> {
  await env.DB.prepare('DELETE FROM event_subscriptions WHERE id = ?').bind(sub.id).run();
  await sendTerminated(env, sub, reason);
}

function matches(sub: SubscriptionRow, event: OutboxRow, doc: { tags: string; domain: string } | null | undefined): boolean {
  const args = safeJson<Record<string, unknown>>(sub.arguments_json, {});
  const data = safeJson<Record<string, unknown>>(event.data_json, {});
  const only = (key: string, value: unknown) => !Array.isArray(args[key]) || (args[key] as unknown[]).includes(value);
  if (!only('document_ids', data.document_id) || !only('job_ids', data.job_id) || !only('feedback_ids', data.feedback_id)) return false;
  if (event.name.startsWith('anymd.library.') && args.exclude_self !== false && event.actor_hash && event.actor_hash === sub.principal_hash) return false;
  if (Array.isArray(args.tags) && args.tags.length) {
    const have = new Set((doc?.tags ?? '').split(' ').filter(Boolean));
    if (!(args.tags as string[]).map((t) => normalizeTag(String(t))).filter(Boolean).every((t) => have.has(t))) return false;
  }
  if (typeof args.domain === 'string' && args.domain) {
    const want = args.domain.toLowerCase().replace(/^www\./, '');
    const have = (doc?.domain ?? '').toLowerCase().replace(/^www\./, '');
    if (have !== want && !have.endsWith(`.${want}`)) return false;
  }
  return true;
}

/** Turn undispatched outbox events into one pending delivery per matching subscription. */
async function fanOut(env: Env, userId?: string): Promise<number> {
  const ts = now();
  const { results: events } = await (userId
    ? env.DB.prepare('SELECT * FROM event_outbox WHERE dispatched_at IS NULL AND user_id = ? ORDER BY created_at LIMIT ?').bind(userId, FANOUT_BATCH)
    : env.DB.prepare('SELECT * FROM event_outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT ?').bind(FANOUT_BATCH)
  ).all<OutboxRow>();
  let queued = 0;
  for (const event of events) {
    const { results: subs } = await env.DB.prepare('SELECT * FROM event_subscriptions WHERE user_id = ? AND name = ? AND expires_at > ? AND created_at <= ?')
      .bind(event.user_id, event.name, ts, event.created_at)
      .all<SubscriptionRow>();
    const needsDoc = subs.some((s) => /"(tags|domain)"/.test(s.arguments_json));
    const doc = needsDoc ? await env.DB.prepare('SELECT tags, domain FROM documents WHERE id = ? AND user_id = ?').bind(event.resource_id, event.user_id).first<{ tags: string; domain: string }>() : undefined;
    const targets = subs.filter((s) => matches(s, event, doc));
    const backlog = targets.length ? ((await env.DB.prepare("SELECT COUNT(*) AS n FROM event_deliveries WHERE user_id = ? AND status = 'pending'").bind(event.user_id).first<{ n: number }>())?.n ?? 0) : 0;
    const room = Math.max(0, MAX_PENDING_PER_USER - backlog);
    const statements = targets.slice(0, room).map((s) =>
      env.DB.prepare("INSERT OR IGNORE INTO event_deliveries (subscription_id, event_id, user_id, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)").bind(s.id, event.id, event.user_id, ts, ts, ts),
    );
    if (targets.length > room) console.warn('events backlog full', { user: event.user_id, dropped: targets.length - room });
    statements.push(env.DB.prepare('UPDATE event_outbox SET dispatched_at = ? WHERE id = ?').bind(ts, event.id));
    await env.DB.batch(statements);
    queued += Math.min(targets.length, room);
  }
  return queued;
}

interface DueDelivery {
  id: number;
  attempts: number;
  subscription_id: string;
  event_id: string;
  name: string;
  data_json: string;
  correlation_id: string | null;
  event_created_at: number;
}

/** POST due deliveries. Returns how many were attempted. */
async function deliverDue(env: Env, userId?: string): Promise<number> {
  const ts = now();
  const base = `SELECT d.id, d.attempts, d.subscription_id, d.event_id, o.name, o.data_json, o.correlation_id, o.created_at AS event_created_at
    FROM event_deliveries d JOIN event_subscriptions s ON s.id = d.subscription_id JOIN event_outbox o ON o.id = d.event_id
    WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND s.active = 1 AND s.expires_at > ?`;
  const { results: due } = await (userId
    ? env.DB.prepare(`${base} AND d.user_id = ? ORDER BY d.next_attempt_at LIMIT ?`).bind(ts, ts, userId, DELIVERY_BATCH)
    : env.DB.prepare(`${base} ORDER BY d.next_attempt_at LIMIT ?`).bind(ts, ts, DELIVERY_BATCH)
  ).all<DueDelivery>();
  const subs = new Map<string, SubscriptionRow | null>();
  let attempted = 0;
  for (const d of due) {
    // Claim: only the run that bumps the attempt count sends it.
    const claimed = await env.DB.prepare("UPDATE event_deliveries SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND attempts = ?")
      .bind(ts + CLAIM_MS, ts, d.id, d.attempts)
      .run();
    if (!claimed.meta.changes) continue;
    if (!subs.has(d.subscription_id)) {
      const sub = await env.DB.prepare('SELECT * FROM event_subscriptions WHERE id = ?').bind(d.subscription_id).first<SubscriptionRow>();
      const reason = sub ? await revocationReason(env, sub) : 'not_found';
      if (sub && reason) await terminateSubscription(env, sub, reason);
      subs.set(d.subscription_id, sub && !reason ? sub : null);
    }
    const sub = subs.get(d.subscription_id);
    if (!sub) continue;
    attempted++;
    const data = { ...safeJson<Record<string, unknown>>(d.data_json, {}), correlation_id: d.correlation_id };
    const body = JSON.stringify({ eventId: d.event_id, name: d.name, timestamp: new Date(d.event_created_at).toISOString(), data, cursor: null });
    const res = await postWebhook(env, { subscriptionId: sub.id, url: sub.url, secrets: await signingSecrets(env, sub) }, d.event_id, body);
    const at = now();
    const attempts = d.attempts + 1;
    if (res.ok) {
      await env.DB.batch([
        env.DB.prepare("UPDATE event_deliveries SET status = 'delivered', last_error = NULL, updated_at = ? WHERE id = ?").bind(at, d.id),
        env.DB.prepare('UPDATE event_subscriptions SET last_delivery_at = ?, last_error = NULL, failed_since = NULL WHERE id = ?').bind(at, sub.id),
      ]);
      continue;
    }
    const error = res.error ?? 'connection_refused';
    const final = !res.retryable ? 'failed' : attempts >= MAX_ATTEMPTS ? 'dead' : null;
    await env.DB.batch([
      final
        ? env.DB.prepare('UPDATE event_deliveries SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').bind(final, error, at, d.id)
        : env.DB.prepare('UPDATE event_deliveries SET last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?').bind(error, at + RETRY_DELAYS_MS[attempts - 1], at, d.id),
      // A dead-lettered delivery suspends the subscription until the client refreshes it.
      env.DB.prepare('UPDATE event_subscriptions SET last_error = ?, failed_since = COALESCE(failed_since, ?), active = CASE WHEN ? THEN 0 ELSE active END WHERE id = ?').bind(error, at, final === 'dead' ? 1 : 0, sub.id),
    ]);
  }
  return attempted;
}

/** Fan out new events and deliver what is due, optionally for one owner only. */
export async function processEvents(env: Env, opts: { userId?: string } = {}): Promise<{ queued: number; attempted: number }> {
  if (!env.EVENTS_SECRET_KEY) return { queued: 0, attempted: 0 };
  const queued = await fanOut(env, opts.userId);
  const attempted = await deliverDue(env, opts.userId);
  return { queued, attempted };
}

/**
 * Retention: expired subscriptions after a day (their deliveries go with them), delivered and
 * given-up deliveries after 7 days, dead letters and outbox events after 30 days, and events no
 * subscription picked up after a day.
 */
export async function pruneEvents(env: Env): Promise<void> {
  if (!env.EVENTS_SECRET_KEY) return;
  const ts = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM event_subscriptions WHERE expires_at < ?').bind(ts - DAY),
    env.DB.prepare("DELETE FROM event_deliveries WHERE (status IN ('delivered','failed') AND updated_at < ?) OR (status = 'dead' AND updated_at < ?)").bind(ts - 7 * DAY, ts - 30 * DAY),
    env.DB.prepare('DELETE FROM event_outbox WHERE created_at < ? OR (dispatched_at IS NULL AND created_at < ?)').bind(ts - 30 * DAY, ts - DAY),
  ]);
}

onEventsWritten((env, userId) => processEvents(env, { userId }));
