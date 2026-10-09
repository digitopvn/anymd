/**
 * First-class audit log. Every privileged mutation records who acted (user, auth kind, API key or
 * OAuth client), through which adapter (`via`), for which request, the target and a minimal diff.
 * Rows never carry secrets: values whose key looks like a secret are dropped before writing.
 */
import { z } from 'zod';
import type { Env, Principal } from '../../env';
import { newId, now, safeJson } from '../../lib/util';
import { assertScope, clampLimit, cursorClause, decodeCursor, iso, page, parseInput, Timestamp, type Paged } from './shared';

/** Non-user actors such as billing webhooks. */
export interface SystemActor {
  system: string;
  via: string;
}

export interface AuditInput {
  action: string;
  targetType: string;
  target: string;
  /** Minimal before/after of what changed. */
  diff?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

const SECRET_KEY = /(secret|token|password|hash|authorization)$/i;
const MAX_META = 4000;

/** Longest string kept per value, tried in order until the row fits MAX_META. */
const VALUE_CAPS = [500, 200, 80, 24];

function shorten(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}… (${text.length} chars)`;
}

function scrub(value: unknown, cap: number, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return typeof value === 'string' ? shorten(value, cap) : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, cap, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, scrub(v, cap, depth + 1)]));
}

/**
 * Keeps every key of the diff and meta, shortening long values until the row fits, so a large
 * change still records what changed from what. Only if even short values do not fit (very many
 * keys) does it fall back to listing the keys.
 */
function serializeMeta(input: AuditInput): string {
  const raw = { ...(input.diff ? { diff: input.diff } : {}), ...(input.meta ?? {}) };
  for (const cap of VALUE_CAPS) {
    const text = JSON.stringify(scrub(raw, cap));
    if (text.length <= MAX_META) return text;
  }
  const keys = (o: object | undefined) => (o ? Object.keys(o).filter((k) => !SECRET_KEY.test(k)) : []);
  return JSON.stringify({ truncated: true, keys: keys(raw), ...(input.diff ? { diff_keys: keys(input.diff) } : {}) });
}

/** The legacy `actor` column (`<kind>:<userId>`), kept so existing readers still see who acted; the credential has its own column. */
function actorLabel(actor: Principal | SystemActor): string {
  if ('system' in actor) return actor.system;
  return `${actor.kind}:${actor.userId}`;
}

const AUDIT_COLUMNS = '(id,actor,action,target,meta,created_at,actor_user_id,auth_kind,credential_id,target_type,via,request_id,idempotency_key)';
const AUDIT_PLACEHOLDERS = '?,?,?,?,?,?,?,?,?,?,?,?,?';

function auditValues(actor: Principal | SystemActor, input: AuditInput, ts: number): unknown[] {
  const user = 'system' in actor ? null : actor;
  return [
    newId('aud_'),
    actorLabel(actor),
    input.action,
    input.target,
    serializeMeta(input),
    ts,
    user?.userId ?? null,
    user ? user.kind : 'system',
    user ? (user.apiKeyId ?? user.clientId ?? null) : null,
    input.targetType,
    'system' in actor ? actor.via : (user?.via ?? null),
    user?.requestId ?? null,
    input.idempotencyKey ?? null,
  ];
}

/**
 * A prepared insert, so callers can commit the audit row in the same batch as the mutation. With a
 * `guard`, the row is only written when the guard SQL holds (e.g. the guarded UPDATE before it won).
 */
export function auditStatement(env: Env, actor: Principal | SystemActor, input: AuditInput, ts = now(), guard?: { sql: string; binds: unknown[] }): D1PreparedStatement {
  const values = auditValues(actor, input, ts);
  if (!guard) return env.DB.prepare(`INSERT INTO audit_log ${AUDIT_COLUMNS} VALUES (${AUDIT_PLACEHOLDERS})`).bind(...values);
  return env.DB.prepare(`INSERT INTO audit_log ${AUDIT_COLUMNS} SELECT ${AUDIT_PLACEHOLDERS} WHERE ${guard.sql}`).bind(...values, ...guard.binds);
}

export async function recordAudit(env: Env, actor: Principal | SystemActor, input: AuditInput): Promise<void> {
  await auditStatement(env, actor, input).run();
}

// ─── Reading ────────────────────────────────────────────────────────────────

export const AuditQuery = z.object({
  action: z.string().max(80).optional().describe('Exact action, or a prefix ending in * (e.g. user.*)'),
  actorUserId: z.string().max(80).optional(),
  target: z.string().max(300).optional(),
  targetType: z.string().max(40).optional(),
  since: Timestamp.optional(),
  until: Timestamp.optional(),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  target: string;
  meta: string;
  created_at: number;
  actor_user_id: string | null;
  auth_kind: string | null;
  credential_id: string | null;
  target_type: string;
  via: string | null;
  request_id: string | null;
  idempotency_key: string | null;
}

function auditView(r: AuditRow) {
  return {
    id: r.id,
    at: iso(r.created_at),
    created_at: r.created_at,
    action: r.action,
    target_type: r.target_type || null,
    target: r.target,
    actor: r.actor,
    actor_user_id: r.actor_user_id,
    auth_kind: r.auth_kind,
    credential_id: r.credential_id,
    via: r.via,
    request_id: r.request_id,
    idempotency_key: r.idempotency_key,
    meta: safeJson<Record<string, unknown>>(r.meta, {}),
  };
}

export type AuditEvent = ReturnType<typeof auditView>;

function where(q: z.infer<typeof AuditQuery>) {
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (q.action) {
    if (q.action.endsWith('*')) {
      parts.push("action LIKE ? ESCAPE '\\'");
      binds.push(`${q.action.slice(0, -1).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    } else {
      parts.push('action = ?');
      binds.push(q.action);
    }
  }
  if (q.actorUserId) parts.push('actor_user_id = ?'), binds.push(q.actorUserId);
  if (q.target) parts.push('target = ?'), binds.push(q.target);
  if (q.targetType) parts.push('target_type = ?'), binds.push(q.targetType);
  if (q.since) parts.push('created_at >= ?'), binds.push(q.since);
  if (q.until) parts.push('created_at < ?'), binds.push(q.until);
  return { parts, binds };
}

/** Newest first, keyset-paginated. Needs `audit:read`. */
export async function listAuditEvents(env: Env, actor: Principal, raw: unknown): Promise<Paged<AuditEvent>> {
  assertScope(actor, 'audit:read');
  const q = parseInput(AuditQuery, raw);
  const limit = clampLimit(q.limit, 50, 200);
  const { parts, binds } = where(q);
  const c = cursorClause(decodeCursor(q.cursor));
  if (c.sql) parts.push(c.sql), binds.push(...c.binds);
  const { results } = await env.DB.prepare(`SELECT * FROM audit_log ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<AuditRow>();
  const paged = page(results, limit);
  return { items: paged.items.map(auditView), next_cursor: paged.next_cursor };
}

export const AUDIT_EXPORT_MAX = 5000;

/** NDJSON export of a filtered window, newest first, capped at AUDIT_EXPORT_MAX rows. */
export async function exportAuditEvents(env: Env, actor: Principal, raw: unknown): Promise<{ ndjson: string; count: number; truncated: boolean }> {
  assertScope(actor, 'audit:read');
  const q = parseInput(AuditQuery, raw);
  const { parts, binds } = where(q);
  const { results } = await env.DB.prepare(`SELECT * FROM audit_log ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...binds, AUDIT_EXPORT_MAX + 1)
    .all<AuditRow>();
  const rows = results.slice(0, AUDIT_EXPORT_MAX);
  return { ndjson: rows.map((r) => JSON.stringify(auditView(r))).join('\n') + (rows.length ? '\n' : ''), count: rows.length, truncated: results.length > AUDIT_EXPORT_MAX };
}

/** Most recent audit rows touching one target (user detail views). */
export async function recentAuditFor(env: Env, target: string, limit = 5): Promise<AuditEvent[]> {
  const { results } = await env.DB.prepare('SELECT * FROM audit_log WHERE target = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(target, limit).all<AuditRow>();
  return results.map(auditView);
}
