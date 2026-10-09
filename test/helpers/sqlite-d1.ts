/** In-memory SQLite (node:sqlite) behind a minimal D1 interface, with the tables conversions touch. */
// @ts-expect-error Node's built-in SQLite is absent from the Worker type set.
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error Reading migrations under Node, which is absent from the Worker type set.
import { readFileSync } from 'node:fs';

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...v: unknown[]): unknown; run(...v: unknown[]): { changes: number | bigint }; all(...v: unknown[]): unknown[] };
  close(): void;
}

export function d1(db: SqliteDatabase): D1Database {
  const statement = (query: string) => {
    let values: unknown[] = [];
    const prepared = {
      get query() { return query; },
      get values() { return values; },
      bind(...next: unknown[]) { values = next.map((v) => (v === undefined ? null : v)); return prepared; },
      async first<T>() { return (db.prepare(query).get(...values) ?? null) as T | null; },
      async run() { return { meta: { changes: Number(db.prepare(query).run(...values).changes) } }; },
      async all<T>() { return { results: db.prepare(query).all(...values) as T[] }; },
    };
    return prepared;
  };
  // Like D1, a batch runs its statements in one transaction.
  const batch = async (statements: { query: string; values: unknown[] }[]) => {
    db.exec('BEGIN');
    try {
      const out = statements.map((s) => ({ meta: { changes: Number(db.prepare(s.query).run(...s.values).changes) }, results: [] }));
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  return { prepare: statement, batch } as unknown as D1Database;
}

const migration = (name: string) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

/** Users, quota and opt-out tables plus the real enrichment and reading-preference migrations. */
export function conversionDatabase(): SqliteDatabase {
  const db = new DatabaseSync(':memory:') as SqliteDatabase;
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'free');
    CREATE TABLE documents (id TEXT PRIMARY KEY);
    CREATE TABLE site_optouts (domain TEXT PRIMARY KEY, reason TEXT, created_by TEXT, created_at INTEGER);
    CREATE TABLE usage_events (id TEXT PRIMARY KEY, user_id TEXT, credits REAL NOT NULL DEFAULT 0, trace_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE credit_grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credits INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER);
    CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
      actor_user_id TEXT, auth_kind TEXT, credential_id TEXT, target_type TEXT NOT NULL DEFAULT '', via TEXT, request_id TEXT, idempotency_key TEXT);
  `);
  db.exec(migration('0005_conversion_enrichment.sql'));
  db.exec(migration('0006_reading_preferences.sql'));
  return db;
}
