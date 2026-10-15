/**
 * Event emission. An event is written to `event_outbox` in the same D1 batch as the change it
 * describes, so an event exists exactly when its change committed, and only when its owner has a
 * live subscription to it (checked inside the same insert, so no extra round trip). While MCP
 * Events is not configured (no `EVENTS_SECRET_KEY`) the write runs alone, exactly as before.
 */
import type { Env, Principal, WaitUntil } from '../env';
import { newId, now } from '../lib/util';
import type { EventName } from './catalog';
import { actorHash } from './crypto';

/** Who made a change and how to deliver its events promptly. All optional. */
export interface EventOrigin {
  /** The credential that made the change, for `exclude_self` loop avoidance. */
  principal?: Pick<Principal, 'kind' | 'apiKeyId' | 'grantId' | 'requestId'> | null;
  /** Lets delivery start right after the response instead of on the next scheduler tick. */
  ctx?: WaitUntil;
}

export interface PendingEvent {
  name: EventName;
  userId: string;
  resourceId: string;
  data: Record<string, unknown>;
  /** Deterministic id for terminal transitions; a fresh one otherwise. */
  id?: string;
  /**
   * When the event is written. `changed` (default): only if the statement just before it changed a
   * row (SQLite `changes()`), so it must directly follow its write in the batch. `exists`: only if
   * this query returns a row, for a second event of the same write.
   */
  when?: { exists: string; binds: unknown[] };
}

export function eventsEnabled(env: Pick<Env, 'EVENTS_SECRET_KEY'>): boolean {
  return Boolean(env.EVENTS_SECRET_KEY);
}

/** The canonical identity of a credential, used as the subscription principal. Null for sessions. */
export function principalKey(p: Pick<Principal, 'kind' | 'apiKeyId' | 'grantId'> | null | undefined): string | null {
  if (!p) return null;
  if (p.kind === 'api_key' && p.apiKeyId) return `api_key:${p.apiKeyId}`;
  if (p.kind === 'oauth' && p.grantId) return `oauth:${p.grantId}`;
  return null;
}

const SUBSCRIBED = 'EXISTS (SELECT 1 FROM event_subscriptions WHERE user_id = ? AND name = ? AND active = 1 AND expires_at > ?)';

async function insertStatement(env: Env, e: PendingEvent, origin: EventOrigin | undefined): Promise<D1PreparedStatement> {
  const key = principalKey(origin?.principal);
  const ts = now();
  const values = [e.id ?? newId('evt_'), e.userId, e.name, e.resourceId, JSON.stringify(e.data), key ? await actorHash(key) : null, origin?.principal?.requestId ?? null, ts];
  const head = 'INSERT OR IGNORE INTO event_outbox (id,user_id,name,resource_id,data_json,actor_hash,correlation_id,created_at) SELECT ?,?,?,?,?,?,?,?';
  // `changes()` is the row count of the previous statement in the batch, so a `changed` event must
  // directly follow its write, and the write must be the first statement that changes data.
  return e.when
    ? env.DB.prepare(`${head} WHERE EXISTS (${e.when.exists}) AND ${SUBSCRIBED}`).bind(...values, ...e.when.binds, e.userId, e.name, ts)
    : env.DB.prepare(`${head} WHERE changes() > 0 AND ${SUBSCRIBED}`).bind(...values, e.userId, e.name, ts);
}

let kick: ((env: Env, userId: string) => Promise<unknown>) | null = null;

/** Registered by the dispatcher, so writers need not import delivery code. */
export function onEventsWritten(fn: (env: Env, userId: string) => Promise<unknown>): void {
  kick = fn;
}

/**
 * Run `write` and, in the same batch, the events of `events` whose owner subscribes to them.
 * Returns the write's change count.
 */
export async function writeWithEvents(env: Env, write: D1PreparedStatement, events: PendingEvent[], origin?: EventOrigin): Promise<number> {
  const userId = events[0]?.userId;
  if (!eventsEnabled(env) || !userId) return Number((await write.run()).meta.changes ?? 0);
  const results = await env.DB.batch([write, ...(await Promise.all(events.map((e) => insertStatement(env, e, origin))))]);
  const emitted = results.slice(1).some((r) => Number(r.meta?.changes ?? 0) > 0);
  if (emitted && origin?.ctx && kick) origin.ctx.waitUntil(kick(env, userId).catch((err) => console.error('events dispatch', err instanceof Error ? err.message : String(err))));
  return Number(results[0].meta?.changes ?? 0);
}
