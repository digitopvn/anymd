/**
 * Building blocks shared by the admin control-plane services: the error type every adapter maps to
 * its own error shape, the acting principal, scope and rank guards, cursors and input validation.
 */
import { z } from 'zod';
import { roleAtLeast } from '../../auth/roles';
import type { Principal, RoleName, Scope } from '../../env';
import { base64url } from '../../lib/util';

/** A business-rule failure. REST maps it to `{ error: { code, message, details } }` with `status`; MCP to a tool error. */
export class AdminError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'invalid_request',
    public details?: unknown,
  ) {
    super(message);
  }
}

/** The signed-in principal performing an admin operation. */
export type Actor = Principal & { userId: string };

/** Services re-check scopes themselves so no adapter can forget a guard. */
export function assertScope(actor: Principal, ...scopes: Scope[]): asserts actor is Actor {
  if (!actor.userId) throw new AdminError('Sign in or send an API key.', 401, 'unauthorized');
  const missing = scopes.filter((s) => !actor.scopes.includes(s));
  if (missing.length) throw new AdminError(`Missing scope: ${missing.join(', ')}`, 403, 'insufficient_scope', { required: scopes });
}

/**
 * Who may act on whom. Nobody changes their own account through admin tools; anyone but the owner
 * can only act on accounts ranked below their own role (and only assign such roles).
 */
export function assertCanManage(actor: Actor, target: { id: string; role: RoleName }, nextRole?: RoleName): void {
  if (target.id === actor.userId) throw new AdminError('You cannot change your own account through admin tools.', 403, 'forbidden_self');
  if (actor.role === 'owner') return;
  if (roleAtLeast(target.role, actor.role) || (nextRole && roleAtLeast(nextRole, actor.role))) {
    throw new AdminError('You can only manage accounts and roles ranked below your own.', 403, 'forbidden_rank');
  }
}

// ─── Pagination ─────────────────────────────────────────────────────────────

export interface Paged<T> {
  items: T[];
  next_cursor: string | null;
}

/** Opaque cursor over a `(created_at DESC, id DESC)` ordering. Not an authorization token. */
export function encodeCursor(ts: number, id: string): string {
  return base64url(new TextEncoder().encode(JSON.stringify([ts, id])));
}

export function decodeCursor(cursor: string | null | undefined): { ts: number; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = atob(cursor.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((cursor.length + 3) % 4));
    const [ts, id] = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)))) as [unknown, unknown];
    if (typeof ts === 'number' && Number.isFinite(ts) && typeof id === 'string' && id.length <= 200) return { ts, id };
  } catch {
    // fall through to the error below
  }
  throw new AdminError('Invalid cursor. Pass next_cursor from the previous page unchanged.', 400, 'invalid_cursor');
}

/** `(created_at, id) < cursor` for a descending keyset page. */
export function cursorClause(cursor: { ts: number; id: string } | null, tsCol = 'created_at', idCol = 'id'): { sql: string; binds: unknown[] } {
  if (!cursor) return { sql: '', binds: [] };
  return { sql: `(${tsCol} < ? OR (${tsCol} = ? AND ${idCol} < ?))`, binds: [cursor.ts, cursor.ts, cursor.id] };
}

/** Fetch `limit + 1` rows and turn the extra one into a cursor. */
export function page<T extends { created_at: number; id: string }>(rows: T[], limit: number): Paged<T> {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next_cursor: more ? encodeCursor(items[items.length - 1].created_at, items[items.length - 1].id) : null };
}

export function clampLimit(raw: unknown, fallback = 20, max = 100): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

/** `LIKE` pattern with `%`/`_` escaped (use with `ESCAPE '\\'`). */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ─── Input validation ───────────────────────────────────────────────────────

export const IdempotencyKey = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'Use 8-100 characters from A-Z a-z 0-9 _ . : -');

/** Epoch milliseconds or an ISO 8601 string. */
export const Timestamp = z.union([z.number().int().positive(), z.string().min(4).max(40)]).transform((v, ctx) => {
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms)) {
    ctx.addIssue({ code: 'custom', message: 'Use epoch milliseconds or an ISO 8601 date' });
    return z.NEVER;
  }
  return ms;
});

/** Parse service input; zod failures become a 422 with per-field details. */
export function parseInput<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw new AdminError(`Invalid input: ${details.map((d) => `${d.path || '(root)'}: ${d.message}`).join('; ')}`, 422, 'invalid_request', details);
}

export const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null);
