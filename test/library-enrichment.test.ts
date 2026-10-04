import { describe, expect, it } from 'vitest';
// @ts-expect-error This test intentionally uses Node's built-in SQLite, which is absent from the Worker type set.
import { DatabaseSync } from 'node:sqlite';
import type { ConvertResult } from '../src/convert/types';
import type { Env } from '../src/env';
import { embedDocument, getDocument, saveDocument } from '../src/library/store';

interface SqliteStatement {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
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

function database(): { db: SqliteDatabase; env: Env; embeddedTexts: string[] } {
  const db = new DatabaseSync(':memory:') as SqliteDatabase;
  const embeddedTexts: string[] = [];
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT '',
      site TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      published TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT 'web',
      tags TEXT NOT NULL DEFAULT '',
      markdown TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      embedded_chunks INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      enrichment_json TEXT,
      base_markdown TEXT,
      UNIQUE (user_id, url_hash)
    );
  `);
  const env = {
    DB: d1Adapter(db),
    AI: {
      async run(_model: unknown, input: { text: string[] }) {
        embeddedTexts.push(...input.text);
        return { data: input.text.map(() => [0.1, 0.2]) };
      },
    },
    VECTORS: {
      async upsert() {},
      async deleteByIds() {},
    },
  } as unknown as Env;
  return { db, env, embeddedTexts };
}

function conversion(overrides: Partial<ConvertResult> = {}): ConvertResult {
  return {
    title: 'Original title',
    author: 'Original author',
    published: '2026-10-01T00:00:00.000Z',
    description: 'Original description',
    domain: 'example.com',
    site: 'Example',
    image: 'https://example.com/cover.png',
    language: 'en',
    content: 'Body',
    baseContent: 'Body',
    wordCount: 1,
    source: 'https://example.com/post',
    sourceKind: 'web',
    ...overrides,
  };
}

describe('library enrichment persistence', () => {
  it('refreshes metadata-only changes, preserves enrichment, and hides storage columns', async () => {
    const { db, env, embeddedTexts } = database();
    try {
      const fetchedAt = '2026-10-04T00:00:00.000Z';
      const first = conversion({
        enrichment: {
          comments: { complete: true, count: 1, fetchedAt, markdown: '> Alice\n\n> Saved comment' },
        },
      });
      const saved = await saveDocument(env, 'user-1', first, first.content);
      expect(saved).toMatchObject({ changed: true });
      db.prepare('UPDATE documents SET embedded_chunks = 3 WHERE id = ?').run(saved!.id);

      const refreshed = conversion({
        title: 'Updated title',
        author: 'Updated author',
        description: 'Updated description',
        image: 'https://example.com/new-cover.png',
        enrichment: {},
      });
      const updated = await saveDocument(env, 'user-1', refreshed, refreshed.content);
      expect(updated).toEqual({ id: saved!.id, changed: true });

      const stored = db.prepare(`SELECT title,author,description,image,markdown,enrichment_json,
        base_markdown,embedded_chunks FROM documents WHERE id = ?`).get(saved!.id) as Record<string, unknown>;
      expect(stored).toMatchObject({
        title: 'Updated title',
        author: 'Updated author',
        description: 'Updated description',
        image: 'https://example.com/new-cover.png',
        base_markdown: 'Body',
        embedded_chunks: 0,
      });
      expect(String(stored.markdown).includes('Saved comment')).toBe(true);
      expect(JSON.parse(String(stored.enrichment_json))).toMatchObject({ comments: { complete: true, count: 1 } });

      const publicDocument = await getDocument(env, 'user-1', saved!.id);
      expect(publicDocument).toMatchObject({ title: 'Updated title', author: 'Updated author' });
      expect(publicDocument).not.toHaveProperty('enrichment_json');
      expect(publicDocument).not.toHaveProperty('base_markdown');
      expect(publicDocument).not.toHaveProperty('content_hash');
      expect(publicDocument).not.toHaveProperty('url_hash');

      expect(await embedDocument(env, 'user-1', saved!.id)).toBeGreaterThan(0);
      expect(embeddedTexts[0]?.startsWith('Updated title\n\nBody')).toBe(true);
    } finally {
      db.close();
    }
  });
});
