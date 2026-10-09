import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error This test intentionally uses Node's built-in SQLite, which is absent from the Worker type set.
import { DatabaseSync } from 'node:sqlite';
import type { AppBindings, Env, Principal } from '../src/env';
import { handleMcp } from '../src/mcp/server';
import { api } from '../src/routes/api';
import { addTags, applyTagEdit, editTags, listDocuments, listTags, normalizeTags, parseTagFilter, removeTags, TagError, updateTags } from '../src/library/store';

interface SqliteStatement {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

/** Minimal D1 facade over node:sqlite: prepare/bind/first/all/run. */
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
        async all<T>() {
          return { results: db.prepare(query).all(...values).map((r) => ({ ...(r as object) })) as T[] };
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

let db: SqliteDatabase;
let env: Env;
let seq = 0;

function insertDoc(userId: string, tags: string, createdAt = ++seq): string {
  const id = `doc_${seq}_${userId}`;
  db.prepare('INSERT INTO documents (id,user_id,url,url_hash,title,markdown,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
    id, userId, `https://example.com/${id}`, `h_${id}`, `Title ${id}`, 'Body', tags, createdAt, createdAt,
  );
  return id;
}

const storedTags = (id: string) => (db.prepare('SELECT tags FROM documents WHERE id = ?').get(id) as { tags: string }).tags;

beforeEach(() => {
  db = new DatabaseSync(':memory:') as SqliteDatabase;
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT NOT NULL, url_hash TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT '', site TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
      published TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', source_kind TEXT NOT NULL DEFAULT 'web',
      tags TEXT NOT NULL DEFAULT '', markdown TEXT NOT NULL, word_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '', embedded_chunks INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, url_hash)
    );
  `);
  env = { DB: d1Adapter(db), RL_AUTH: { limit: async () => ({ success: true }) }, RL_ANON: { limit: async () => ({ success: true }) } } as unknown as Env;
});

describe('tag normalization and edit semantics', () => {
  it('lowercases, strips invalid characters, drops empties and dedupes', () => {
    expect(normalizeTags([' AI ', 'ai', 'Machine Learning', 'c++', '!!!', 'rag_2-x'])).toEqual(['ai', 'machinelearning', 'c', 'rag_2-x']);
  });

  it('adds without duplicates, removes, and sets', () => {
    expect(applyTagEdit(['ai'], { add: ['AI', 'rag'] })).toEqual(['ai', 'rag']);
    expect(applyTagEdit(['ai', 'rag'], { remove: ['RAG', 'missing'] })).toEqual(['ai']);
    expect(applyTagEdit(['ai', 'rag'], { add: ['llm'], remove: ['ai'] })).toEqual(['rag', 'llm']);
    expect(applyTagEdit(['ai'], { set: ['x', 'y'] })).toEqual(['x', 'y']);
    expect(applyTagEdit(['ai'], { set: [] })).toEqual([]);
  });

  it('rejects an add past the 20-tag cap instead of truncating', () => {
    const full = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(() => applyTagEdit(full, { add: ['one-more'] })).toThrowError(TagError);
    expect(() => applyTagEdit(full.slice(0, 19), { add: ['a', 'b'] })).toThrowError(/at most 20/);
    // Swapping one tag at the cap is fine.
    expect(applyTagEdit(full, { add: ['new'], remove: ['t0'] })).toHaveLength(20);
    // Re-adding an existing tag at the cap is a no-op, not an error.
    expect(applyTagEdit(full, { add: ['t3'] })).toEqual(full);
  });
});

describe('tag storage', () => {
  it('adds, removes and edits tags atomically per document', async () => {
    const id = insertDoc('u1', 'ai');
    expect(await addTags(env, 'u1', id, ['RAG', 'ai'])).toEqual(['ai', 'rag']);
    expect(storedTags(id)).toBe('ai rag');
    expect(await removeTags(env, 'u1', id, ['ai'])).toEqual(['rag']);
    expect(await editTags(env, 'u1', id, { set: [] })).toEqual([]);
    expect(storedTags(id)).toBe('');
  });

  it('cannot tag or read another user’s document', async () => {
    const id = insertDoc('u2', 'secret');
    expect(await addTags(env, 'u1', id, ['mine'])).toBeNull();
    expect(await updateTags(env, 'u1', id, ['mine'])).toBe(false);
    expect(storedTags(id)).toBe('secret');
    expect(await listTags(env, 'u1')).toEqual([]);
    expect(await listDocuments(env, 'u1', { tags: ['secret'] })).toEqual([]);
  });

  it('surfaces a cap overflow as a 422 too_many_tags error and leaves tags unchanged', async () => {
    const id = insertDoc('u1', Array.from({ length: 20 }, (_, i) => `t${i}`).join(' '));
    await expect(addTags(env, 'u1', id, ['extra'])).rejects.toMatchObject({ code: 'too_many_tags', status: 422 });
    expect(storedTags(id).split(' ')).toHaveLength(20);
  });

  it('lists tags by document count, scoped to the user and bounded', async () => {
    insertDoc('u1', 'ai rag');
    insertDoc('u1', 'ai');
    insertDoc('u1', 'ai llm');
    insertDoc('u1', '');
    insertDoc('u2', 'ai ai-other');
    expect(await listTags(env, 'u1')).toEqual([
      { tag: 'ai', count: 3 },
      { tag: 'llm', count: 1 },
      { tag: 'rag', count: 1 },
    ]);
    expect(await listTags(env, 'u1', 1)).toEqual([{ tag: 'ai', count: 3 }]);
  });

  it('filters by whole tags with AND semantics', async () => {
    const ai = insertDoc('u1', 'ai');
    const rai = insertDoc('u1', 'rai ai-safety');
    const both = insertDoc('u1', 'rag ai');
    const underscore = insertDoc('u1', 'a_b');
    insertDoc('u2', 'ai');
    const ids = async (tags: string[]) => (await listDocuments(env, 'u1', { tags })).map((d) => d.id).sort();
    expect(await ids(['ai'])).toEqual([ai, both].sort());
    expect(await ids(['AI', 'rag'])).toEqual([both]);
    expect(await ids(['rai'])).toEqual([rai]);
    // `_` is a literal character, not a wildcard.
    expect(await ids(['a_b'])).toEqual([underscore]);
    expect(await ids(['axb'])).toEqual([]);
    expect(await ids(['!!!'])).toEqual([]);
  });
});

describe('concurrent tag edits', () => {
  /** Wrap the DB so another writer changes the row right before each of the first `races` guarded UPDATEs. */
  function racingEnv(id: string, races: number): Env {
    const base = env.DB;
    let raced = 0;
    const DB = {
      prepare(query: string) {
        if (query.startsWith('UPDATE documents SET tags') && raced < races) {
          raced++;
          db.prepare('UPDATE documents SET tags = ? WHERE id = ?').run(`other${raced}`, id);
        }
        return base.prepare(query);
      },
    } as unknown as D1Database;
    return { ...env, DB };
  }

  it('retries on a concurrent change and applies the edit to the fresh value', async () => {
    const id = insertDoc('u1', 'ai');
    expect(await addTags(racingEnv(id, 1), 'u1', id, ['rag'])).toEqual(['other1', 'rag']);
    expect(storedTags(id)).toBe('other1 rag');
  });

  it('gives up with 409 tag_conflict when the row keeps changing', async () => {
    const id = insertDoc('u1', 'ai');
    await expect(addTags(racingEnv(id, 3), 'u1', id, ['rag'])).rejects.toMatchObject({ code: 'tag_conflict', status: 409 });
    expect(storedTags(id)).toBe('other3');
  });
});

describe('tag filter parsing', () => {
  it('splits commas, drops blanks, treats empty as no filter and enforces limits', () => {
    expect(parseTagFilter(['ai,rag', ' llm ', ''])).toEqual(['ai', 'rag', 'llm']);
    expect(parseTagFilter([])).toBeUndefined();
    expect(parseTagFilter([' , '])).toBeUndefined();
    expect(() => parseTagFilter([Array.from({ length: 11 }, (_, i) => `t${i}`).join(',')])).toThrowError(TagError);
    expect(() => parseTagFilter(['x'.repeat(41)])).toThrowError(/at most 40/);
  });
});

// ─── MCP ──────────────────────────────────────────────────────────────────────

async function rpc(method: string, params: Record<string, unknown> | undefined, scopes: Principal['scopes']) {
  const principal: Principal = { kind: 'api_key', userId: 'u1', role: 'user', scopes };
  const req = new Request('https://anymd.cc/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const res = await handleMcp(req, env, { waitUntil: () => {} } as never, principal);
  return ((await res.json()) as { result: any }).result;
}

describe('mcp tag tools', () => {
  it('shows tag_document only with library:write and list_tags with library:read', async () => {
    const readOnly = (await rpc('tools/list', undefined, ['library:read'])).tools.map((t: { name: string }) => t.name);
    expect(readOnly.includes('list_tags')).toBe(true);
    expect(readOnly.includes('tag_document')).toBe(false);
    const none = (await rpc('tools/list', undefined, ['convert'])).tools.map((t: { name: string }) => t.name);
    expect(none.includes('list_tags')).toBe(false);
    const tools = (await rpc('tools/list', undefined, ['library:read', 'library:write'])).tools;
    const tag = tools.find((t: { name: string }) => t.name === 'tag_document');
    expect(tag.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(tools.find((t: { name: string }) => t.name === 'list_documents').inputSchema.properties.tags.type).toBe('array');
  });

  it('refuses tag_document without library:write', async () => {
    const id = insertDoc('u1', '');
    const out = await rpc('tools/call', { name: 'tag_document', arguments: { id, add: ['x'] } }, ['library:read']);
    expect(out.isError).toBe(true);
    expect(storedTags(id)).toBe('');
  });

  it('tags a document, validates modes and filters list_documents', async () => {
    const id = insertDoc('u1', 'old');
    insertDoc('u1', 'other');
    const scopes: Principal['scopes'] = ['library:read', 'library:write'];
    const ok = await rpc('tools/call', { name: 'tag_document', arguments: { id, add: ['AI', 'rag'], remove: ['old'] } }, scopes);
    expect(ok.structuredContent).toEqual({ id, tags: ['ai', 'rag'] });
    const mixed = await rpc('tools/call', { name: 'tag_document', arguments: { id, set: ['x'], add: ['y'] } }, scopes);
    expect(mixed.isError).toBe(true);
    const empty = await rpc('tools/call', { name: 'tag_document', arguments: { id } }, scopes);
    expect(empty.isError).toBe(true);
    const missing = await rpc('tools/call', { name: 'tag_document', arguments: { id: 'doc_nope', add: ['x'] } }, scopes);
    expect(missing.content[0].text.includes('Document not found')).toBe(true);
    const listed = await rpc('tools/call', { name: 'list_documents', arguments: { tags: ['ai'] } }, scopes);
    expect(listed.structuredContent.items.map((d: { id: string }) => d.id)).toEqual([id]);
    const comma = await rpc('tools/call', { name: 'list_documents', arguments: { tags: ['ai,rag'] } }, scopes);
    expect(comma.structuredContent.items.map((d: { id: string }) => d.id)).toEqual([id]);
    const unfiltered = await rpc('tools/call', { name: 'list_documents', arguments: { tags: [] } }, scopes);
    expect(unfiltered.isError).toBeUndefined();
    expect(unfiltered.structuredContent.items).toHaveLength(2);
    const tags = await rpc('tools/call', { name: 'list_tags', arguments: {} }, scopes);
    expect(tags.structuredContent.items).toEqual([{ tag: 'ai', count: 1 }, { tag: 'other', count: 1 }, { tag: 'rag', count: 1 }]);
  });
});

// ─── REST ─────────────────────────────────────────────────────────────────────

function restApp(scopes: Principal['scopes']) {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('principal', { kind: 'api_key', userId: 'u1', role: 'user', scopes });
    c.set('user', null);
    await next();
  });
  app.route('/api/v1', api);
  return (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } }, env);
}

describe('REST tag routes', () => {
  it('lists tags and filters the library with ?tag=', async () => {
    const a = insertDoc('u1', 'ai rag');
    insertDoc('u1', 'ai');
    insertDoc('u2', 'ai rag');
    const call = restApp(['library:read']);
    expect(await (await call('/api/v1/library/tags')).json()).toEqual({ items: [{ tag: 'ai', count: 2 }, { tag: 'rag', count: 1 }] });
    const both = (await (await call('/api/v1/library?tag=ai&tag=rag')).json()) as { items: { id: string }[] };
    expect(both.items.map((d) => d.id)).toEqual([a]);
    const comma = (await (await call('/api/v1/library?tag=ai,rag')).json()) as { items: { id: string }[] };
    expect(comma.items.map((d) => d.id)).toEqual([a]);
    const tooMany = await call(`/api/v1/library?tag=${Array.from({ length: 11 }, (_, i) => `t${i}`).join(',')}`);
    expect(tooMany.status).toBe(422);
  });

  it('POST /library/:id/tags adds, removes and sets, with clear errors', async () => {
    const id = insertDoc('u1', 'ai');
    const call = restApp(['library:read', 'library:write']);
    const post = (body: unknown, docId = id) => call(`/api/v1/library/${docId}/tags`, { method: 'POST', body: JSON.stringify(body) });
    const added = await post({ add: ['RAG'], remove: ['ai'] });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ id, tags: ['rag'] });
    expect(await (await post({ set: ['x', 'y'] })).json()).toEqual({ id, tags: ['x', 'y'] });
    expect((await post({ set: ['x'], add: ['y'] })).status).toBe(422);
    expect((await post({})).status).toBe(422);
    expect((await post({ tags: ['x'] })).status).toBe(422);
    expect((await post({ add: ['x'] }, insertDoc('u2', ''))).status).toBe(404);
    db.prepare('UPDATE documents SET tags = ? WHERE id = ?').run(Array.from({ length: 20 }, (_, i) => `t${i}`).join(' '), id);
    const overflow = await post({ add: ['extra'] });
    expect(overflow.status).toBe(422);
    expect(((await overflow.json()) as { error: { code: string } }).error.code).toBe('too_many_tags');
  });

  it('keeps PATCH /library/:id replacing tags', async () => {
    const id = insertDoc('u1', 'ai');
    const call = restApp(['library:write']);
    const res = await call(`/api/v1/library/${id}`, { method: 'PATCH', body: JSON.stringify({ tags: ['One', 'two'] }) });
    expect(await res.json()).toEqual({ ok: true });
    expect(storedTags(id)).toBe('one two');
  });

  it('requires the right scopes', async () => {
    const id = insertDoc('u1', '');
    const readOnly = restApp(['library:read']);
    expect((await readOnly(`/api/v1/library/${id}/tags`, { method: 'POST', body: JSON.stringify({ add: ['x'] }) })).status).toBe(403);
    expect((await restApp(['convert'])('/api/v1/library/tags')).status).toBe(403);
  });
});
