/**
 * Paging sessions for social search. A `next_cursor` is an opaque, single-use handle `amdss2.<session>.<version>`;
 * the session row in D1 is the authority for the provider cursors, the time range and the posts already returned.
 * Each page claims the session by bumping `version` (compare-and-swap), so a replayed or concurrent cursor is
 * refused instead of charging twice or returning the same posts again.
 */
import type { Env } from '../env';
import { newId } from '../lib/util';
import type { TimeRange, SocialSearchPeriod } from './social-search-results';
import type { SocialPlatform } from './social-search-providers';
import { ConvertError } from './types';

export const SESSION_CURSOR_PREFIX = 'amdss2.';
/** How long a search can be continued. */
export const SESSION_TTL_MS = 24 * 3_600_000;
/** Most pages one search can page through; the last allowed page returns no next cursor. */
export const SESSION_MAX_PAGES = 50;
/** Most post identities a session remembers; reaching it ends paging rather than forgetting posts. */
export const SESSION_MAX_SEEN = 5000;
/** Sessions kept per user; the oldest are dropped when a new search starts paging. */
const SESSIONS_PER_USER = 50;

export type ProviderCursors = Partial<Record<SocialPlatform, string>>;

export interface SearchSession {
  id: string;
  version: number;
  platform: string;
  queryKey: string;
  range: TimeRange | null;
  cursors: ProviderCursors;
  seen: string[];
  pages: number;
}

/** Case- and whitespace-insensitive form of a query, used to bind a cursor to its search. */
export const queryKey = (query: string) => query.trim().replace(/\s+/g, ' ').toLowerCase();

export const isSessionCursor = (cursor: string) => cursor.startsWith(SESSION_CURSOR_PREFIX);
export const sessionCursor = (id: string, version: number) => `${SESSION_CURSOR_PREFIX}${id}.${version}`;

export function parseSessionCursor(cursor: string): { id: string; version: number } {
  const m = /^amdss2\.(sss_[a-z0-9]{10,40})\.([1-9]\d{0,5})$/.exec(cursor);
  if (!m) throw new ConvertError('Invalid social search: cursor is not a next_cursor from this search', 400, 'invalid_request');
  return { id: m[1], version: Number(m[2]) };
}

const expired = () => new ConvertError('This search can no longer be continued (cursors last 24 hours). Start the search again.', 400, 'cursor_expired');
const conflict = () =>
  new ConvertError('This page was already requested with this cursor. Continue from the latest next_cursor, or start the search again.', 409, 'cursor_conflict');

interface SessionRow {
  id: string; platform: string; query_key: string; period: string | null; since_ms: number | null; until_ms: number | null;
  cursors_json: string; seen_json: string; pages: number; version: number; expires_at: number;
}

/** The caller's live session for a cursor. Unknown, foreign and expired sessions look the same. */
export async function loadSession(env: Env, userId: string, id: string, now: number): Promise<SearchSession> {
  const row = await env.DB.prepare(
    'SELECT id, platform, query_key, period, since_ms, until_ms, cursors_json, seen_json, pages, version, expires_at FROM social_search_sessions WHERE id = ? AND user_id = ?',
  ).bind(id, userId).first<SessionRow>();
  if (!row || row.expires_at <= now) throw expired();
  const range = row.period || row.since_ms !== null || row.until_ms !== null
    ? { period: (row.period as SocialSearchPeriod | null) ?? null, since: row.since_ms, until: row.until_ms }
    : null;
  return { id: row.id, version: row.version, platform: row.platform, queryKey: row.query_key, range, cursors: JSON.parse(row.cursors_json), seen: JSON.parse(row.seen_json), pages: row.pages };
}

/** Take the page for `version`; a second request with the same cursor (replayed or concurrent) loses. */
export async function claimSession(env: Env, userId: string, id: string, version: number, now: number): Promise<void> {
  const r = await env.DB.prepare('UPDATE social_search_sessions SET version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ? AND expires_at > ?')
    .bind(now, id, userId, version, now).run();
  if (!r.meta.changes) throw conflict();
}

/** Undo a claim when the page failed before anything was returned, so the same cursor can be retried. */
export async function releaseSession(env: Env, id: string, claimed: number): Promise<void> {
  await env.DB.prepare('UPDATE social_search_sessions SET version = ? WHERE id = ? AND version = ?').bind(claimed - 1, id, claimed).run();
}

/** Store the state for the next page under the claimed version; that version is the next cursor. */
export async function advanceSession(env: Env, id: string, claimed: number, next: { cursors: ProviderCursors; seen: string[]; pages: number }, now: number): Promise<string> {
  const r = await env.DB.prepare('UPDATE social_search_sessions SET cursors_json = ?, seen_json = ?, pages = ?, updated_at = ? WHERE id = ? AND version = ?')
    .bind(JSON.stringify(next.cursors), JSON.stringify(next.seen), next.pages, now, id, claimed).run();
  if (!r.meta.changes) throw conflict();
  return sessionCursor(id, claimed);
}

export async function deleteSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM social_search_sessions WHERE id = ?').bind(id).run();
}

/** Start paging state after a first page that has more; drops the user's expired and oldest sessions in the same batch. */
export async function createSession(env: Env, userId: string, s: { platform: string; queryKey: string; range: TimeRange | null; cursors: ProviderCursors; seen: string[] }, now: number): Promise<string> {
  const id = newId('sss_').toLowerCase();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM social_search_sessions WHERE user_id = ? AND expires_at <= ?').bind(userId, now),
    env.DB.prepare(
      `INSERT INTO social_search_sessions (id, user_id, platform, query_key, period, since_ms, until_ms, cursors_json, seen_json, pages, version, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
    ).bind(id, userId, s.platform, s.queryKey, s.range?.period ?? null, s.range?.since ?? null, s.range?.until ?? null, JSON.stringify(s.cursors), JSON.stringify(s.seen), now, now, now + SESSION_TTL_MS),
    env.DB.prepare(
      'DELETE FROM social_search_sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM social_search_sessions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)',
    ).bind(userId, userId, SESSIONS_PER_USER),
  ]);
  return sessionCursor(id, 1);
}

/** Scheduled sweep of expired sessions, bounded per run. */
export async function sweepExpiredSessions(env: Env, now: number, limit = 1000): Promise<number> {
  const r = await env.DB.prepare('DELETE FROM social_search_sessions WHERE id IN (SELECT id FROM social_search_sessions WHERE expires_at <= ? LIMIT ?)').bind(now, limit).run();
  return Number(r.meta.changes ?? 0);
}
