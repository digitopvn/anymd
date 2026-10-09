import { describe, expect, it } from 'vitest';
// @ts-expect-error This test intentionally uses Node's built-in SQLite, which is absent from the Worker type set.
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error This test intentionally reads the migration under Node, which is absent from the Worker type set.
import { readFileSync } from 'node:fs';
import type { Env } from '../src/env';
import { creditsUsedThisMonth, monthStart } from '../src/lib/usage';
import { reserveConversion, settleConversion } from '../src/lib/conversion-budget';

interface SqliteStatement {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function readMigration(): string {
  return readFileSync(new URL('../migrations/0005_conversion_enrichment.sql', import.meta.url), 'utf8');
}

function d1Adapter(db: SqliteDatabase): D1Database {
  return {
    prepare(query: string) {
      let values: unknown[] = [];
      const prepared = {
        bind(...next: unknown[]) {
          values = next;
          return prepared;
        },
        async first<T>() {
          return (db.prepare(query).get(...values) ?? null) as T | null;
        },
        async run() {
          const result = db.prepare(query).run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
}

async function database(): Promise<{ db: SqliteDatabase; env: Env }> {
  const db = new DatabaseSync(':memory:') as SqliteDatabase;
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE documents (id TEXT PRIMARY KEY);
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      credits REAL NOT NULL DEFAULT 0,
      trace_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE credit_grants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credits INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER
    );
  `);
  db.exec(readMigration());
  return { db, env: { DB: d1Adapter(db) } as Env };
}

describe('conversion reservation SQLite semantics', () => {
  it('applies migration constraints and excludes settled charge usage from telemetry', async () => {
    const { db, env } = await database();
    try {
      const now = Date.now();
      db.prepare('INSERT INTO users (id) VALUES (?)').run('user-1');
      db.prepare('INSERT INTO conversion_charges (id,user_id,reserved,credits,settled,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .run('trace-1', 'user-1', 5, 3, 1, now, now + 60_000);
      db.prepare('INSERT INTO usage_events (id,user_id,credits,trace_id,created_at) VALUES (?,?,?,?,?)')
        .run('event-1', 'user-1', 3, 'trace-1', now);

      expect(await creditsUsedThisMonth(env, 'user-1')).toBe(3);
      expect(() => db.prepare('INSERT INTO conversion_charges (id,user_id,reserved,created_at,expires_at) VALUES (?,?,?,?,?)')
        .run('negative', 'user-1', -1, now, now + 60_000)).toThrow();
      expect(() => db.prepare('UPDATE conversion_charges SET credits = 6 WHERE id = ?').run('trace-1')).toThrow();
    } finally {
      db.close();
    }
  });

  it('atomically allows only one competing reservation and settles it exactly once', async () => {
    const { db, env } = await database();
    try {
      const now = Date.now();
      db.prepare('INSERT INTO users (id) VALUES (?)').run('user-1');
      db.prepare('INSERT INTO usage_events (id,user_id,credits,trace_id,created_at) VALUES (?,?,?,?,?)')
        .run('used', 'user-1', 499, null, monthStart(now));

      const attempts = await Promise.allSettled([
        reserveConversion(env, 'reservation-a', 'user-1', 'free', 1),
        reserveConversion(env, 'reservation-b', 'user-1', 'free', 1),
      ]);
      const successes = attempts.filter((result) => result.status === 'fulfilled');
      const failures = attempts.filter((result) => result.status === 'rejected');
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const row = db.prepare('SELECT id,reserved,credits,settled FROM conversion_charges').get() as {
        id: string;
        reserved: number;
        credits: number;
        settled: number;
      };
      expect(row).toMatchObject({ reserved: 1, credits: 0, settled: 0 });

      await settleConversion(env, row.id, 1);
      expect(db.prepare('SELECT credits,settled FROM conversion_charges WHERE id = ?').get(row.id))
        .toMatchObject({ credits: 1, settled: 1 });
      await expect(settleConversion(env, row.id, 1)).rejects.toMatchObject({ code: 'billing_unavailable', status: 503 });
      expect(await creditsUsedThisMonth(env, 'user-1')).toBe(500);
    } finally {
      db.close();
    }
  });

  it('counts active reservations, ignores expired ones, and refuses settlement above the reservation', async () => {
    const { db, env } = await database();
    try {
      const now = Date.now();
      db.prepare('INSERT INTO users (id) VALUES (?)').run('user-1');
      db.prepare('INSERT INTO conversion_charges (id,user_id,reserved,created_at,expires_at) VALUES (?,?,?,?,?)')
        .run('active', 'user-1', 4, now, now + 60_000);
      db.prepare('INSERT INTO conversion_charges (id,user_id,reserved,created_at,expires_at) VALUES (?,?,?,?,?)')
        .run('expired', 'user-1', 7, now, now - 1);

      expect(await creditsUsedThisMonth(env, 'user-1')).toBe(4);
      await expect(settleConversion(env, 'active', 5)).rejects.toMatchObject({ code: 'billing_unavailable' });
      expect(db.prepare('SELECT credits,settled FROM conversion_charges WHERE id = ?').get('active'))
        .toMatchObject({ credits: 0, settled: 0 });
    } finally {
      db.close();
    }
  });
});
