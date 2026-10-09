/**
 * In-memory Worker environment for service and MCP tests: every migration applied to Node's
 * built-in SQLite behind a D1-shaped adapter (batches are transactional, like D1), a Map-backed KV,
 * an OAuth grant store and counting rate limiters.
 */
// @ts-expect-error Node's built-in SQLite is absent from the Worker type set; tests run under Node.
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error Node's fs is absent from the Worker type set; tests run under Node.
import { readdirSync, readFileSync } from 'node:fs';
import { createApiKey, createSession, createUser, type UserRow } from '../../src/auth/identity';
import type { Env, Principal, RateLimit, RoleName } from '../../src/env';

interface SqliteStatement {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number | bigint };
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

function bindable(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

interface Prepared {
  query: string;
  values: unknown[];
}

function d1(db: SqliteDatabase): D1Database {
  const exec = (p: Prepared) => {
    const stmt = db.prepare(p.query);
    return stmt.run(...p.values.map(bindable));
  };
  const makeStatement = (query: string) => {
    const state: Prepared = { query, values: [] };
    const statement = {
      __prepared: state,
      bind(...values: unknown[]) {
        state.values = values;
        return statement;
      },
      async first<T>(column?: string) {
        const row = db.prepare(query).get(...state.values.map(bindable)) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (column ? row[column] : { ...row }) as T;
      },
      async all<T>() {
        const rows = db.prepare(query).all(...state.values.map(bindable)) as Record<string, unknown>[];
        return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} };
      },
      async run() {
        const result = exec(state);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return statement;
  };
  return {
    prepare: makeStatement,
    async batch(statements: { __prepared: Prepared }[]) {
      db.exec('BEGIN');
      try {
        // Like D1, a batched SELECT returns its rows; writes report their change count.
        const out = statements.map((s) =>
          /^\s*(SELECT|WITH)\b/i.test(s.__prepared.query)
            ? { success: true, results: db.prepare(s.__prepared.query).all(...s.__prepared.values.map(bindable)).map((r) => ({ ...(r as object) })), meta: { changes: 0 } }
            : { success: true, results: [], meta: { changes: Number(exec(s.__prepared).changes) } },
        );
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  } as unknown as D1Database;
}

function kv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

export interface TestGrant {
  id: string;
  clientId: string;
  userId: string;
  scope: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
}

/** A rate limiter that allows `max` calls per key and records every key it saw. */
export function counter(max = Infinity): RateLimit & { calls: string[] } {
  const seen = new Map<string, number>();
  const calls: string[] = [];
  return {
    calls,
    async limit({ key }: { key: string }) {
      calls.push(key);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= max };
    },
  };
}

export interface TestEnv {
  env: Env;
  db: SqliteDatabase;
  cache: KVNamespace & { store: Map<string, string> };
  grants: TestGrant[];
  close(): void;
}

export function createTestEnv(overrides: Partial<Env> = {}): TestEnv {
  const db = new DatabaseSync(':memory:') as SqliteDatabase;
  db.exec('PRAGMA foreign_keys = ON');
  const files = (readdirSync(MIGRATIONS) as string[]).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  const cache = kv();
  const grants: TestGrant[] = [];
  const env = {
    ENVIRONMENT: 'development',
    PUBLIC_URL: 'https://anymd.test',
    BILLING_PROVIDER: 'polar',
    POLAR_SERVER: 'sandbox',
    CREEM_SERVER: 'test',
    DB: d1(db),
    CACHE: cache,
    OAUTH_KV: kv(),
    RL_AUTH: counter(),
    RL_ANON: counter(),
    RL_DOMAIN: counter(),
    OAUTH_PROVIDER: {
      async listUserGrants(userId: string) {
        return { items: grants.filter((g) => g.userId === userId) };
      },
      async revokeGrant(grantId: string, userId: string) {
        const i = grants.findIndex((g) => g.id === grantId && g.userId === userId);
        if (i >= 0) grants.splice(i, 1);
      },
    },
    ...overrides,
  } as unknown as Env;
  return { env, db, cache, grants, close: () => db.close() };
}

let seq = 0;

/** A user with the given role (and optional plan/status), created through the real identity code. */
export async function seedUser(t: TestEnv, role: RoleName, extra: { plan?: string; createdAt?: number } = {}): Promise<UserRow> {
  seq += 1;
  const user = await createUser(t.env, { email: `${role}-${seq}@example.test`, name: `${role} ${seq}` });
  const ts = extra.createdAt ?? Date.now() - (1000 - seq) * 1000;
  t.db.prepare('UPDATE users SET role = ?, plan = ?, created_at = ? WHERE id = ?').run(role, extra.plan ?? 'free', ts, user.id);
  return { ...user, role, plan: extra.plan ?? 'free', created_at: ts };
}

export async function seedKey(t: TestEnv, user: UserRow, scopes: string[]) {
  return createApiKey(t.env, user, { name: 'test key', scopes });
}

export async function seedSession(t: TestEnv, user: UserRow) {
  return createSession(t.env, user.id, 'vitest');
}

/** The principal a signed-in session would carry. */
export function sessionOf(user: UserRow, scopes: Principal['scopes']): Principal {
  return { kind: 'session', userId: user.id, role: user.role as RoleName, scopes, requestId: 'req-test' };
}

export function auditRows(t: TestEnv, action?: string) {
  const sql = action ? 'SELECT * FROM audit_log WHERE action = ? ORDER BY created_at, id' : 'SELECT * FROM audit_log ORDER BY created_at, id';
  return (action ? t.db.prepare(sql).all(action) : t.db.prepare(sql).all()) as Record<string, unknown>[];
}
