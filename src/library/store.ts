import type { Env } from '../env';
import type { ConvertResult } from '../convert/types';
import { newId, now, sha256 } from '../lib/util';
import { mergeEnrichment } from './enrichment';
import { renderEnrichment } from '../convert/image-enrichment';
import { countWords } from '../convert/types';
import type { Enrichment } from '../convert/enrichment-types';

export interface DocumentRow {
  id: string;
  user_id: string;
  url: string;
  title: string;
  author: string;
  description: string;
  domain: string;
  site: string;
  image: string;
  published: string;
  language: string;
  source_kind: string;
  tags: string;
  markdown: string;
  word_count: number;
  embedded_chunks: number;
  created_at: number;
  updated_at: number;
}

export type DocumentSummary = Omit<DocumentRow, 'markdown'>;

const DOCUMENT_COLUMNS =
  'id,user_id,url,title,author,description,domain,site,image,published,language,source_kind,tags,markdown,word_count,embedded_chunks,created_at,updated_at';
const SUMMARY_COLUMNS =
  'id,user_id,url,title,author,description,domain,site,image,published,language,source_kind,tags,word_count,embedded_chunks,created_at,updated_at';

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const CHUNK_CHARS = 1800;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS = 48;

/** Save (or refresh) a conversion in the user's library. Returns the document id and whether it changed. */
export async function saveDocument(
  env: Env,
  userId: string,
  result: ConvertResult,
  markdown: string,
  libraryLimit: number | null = null,
  attempt = 0,
): Promise<{ id: string; changed: boolean } | null> {
  const urlHash = await sha256(result.source);
  const ts = now();
  const existing = await env.DB.prepare(`SELECT id,content_hash,enrichment_json,base_markdown,
    title,author,description,domain,site,image,published,language,source_kind
    FROM documents WHERE user_id = ? AND url_hash = ?`)
    .bind(userId, urlHash)
    .first<{
      id: string;
      content_hash: string;
      enrichment_json: string | null;
      base_markdown: string | null;
      title: string;
      author: string;
      description: string;
      domain: string;
      site: string;
      image: string;
      published: string;
      language: string;
      source_kind: string;
    }>();
  let previous: Enrichment = {};
  try { previous = JSON.parse(existing?.enrichment_json ?? '{}'); } catch { /* Older records have no enrichment. */ }
  const enrichment = mergeEnrichment(previous, result.enrichment);
  const preserveThread = previous.thread && enrichment.thread === previous.thread;
  const base = preserveThread && existing?.base_markdown ? existing.base_markdown : result.baseContent ?? markdown;
  markdown = renderEnrichment(base, result.source, enrichment);
  const contentHash = await sha256(markdown);
  const wordCount = countWords(markdown);
  const enrichmentJson = JSON.stringify(enrichment);
  if (existing) {
    const metadataChanged = existing.title !== result.title
      || existing.author !== result.author
      || existing.description !== result.description
      || existing.domain !== result.domain
      || existing.site !== (result.site ?? '')
      || existing.image !== (result.image ?? '')
      || existing.published !== result.published
      || existing.language !== (result.language ?? '')
      || existing.source_kind !== result.sourceKind;
    if (existing.content_hash === contentHash && existing.enrichment_json === enrichmentJson && !metadataChanged) {
      await env.DB.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').bind(ts, existing.id).run();
      return { id: existing.id, changed: false };
    }
    const updated = await env.DB.prepare(
      'UPDATE documents SET title=?,author=?,description=?,domain=?,site=?,image=?,published=?,language=?,source_kind=?,markdown=?,word_count=?,content_hash=?,embedded_chunks=0,updated_at=?,enrichment_json=?,base_markdown=? WHERE id=? AND user_id=? AND content_hash=?',
    )
      .bind(
        result.title, result.author, result.description, result.domain, result.site ?? '', result.image ?? '',
        result.published, result.language ?? '', result.sourceKind, markdown, wordCount, contentHash, ts, enrichmentJson, base, existing.id, userId, existing.content_hash,
      )
      .run();
    if (!updated.meta.changes) {
      if (attempt >= 2) return null;
      return saveDocument(env, userId, result, result.baseContent ?? markdown, libraryLimit, attempt + 1);
    }
    return { id: existing.id, changed: true };
  }
  // A full library still converts; the new page is just not saved.
  if (libraryLimit !== null && (await countDocuments(env, userId)) >= libraryLimit) return null;
  const id = newId('doc_');
  const inserted = await env.DB.prepare(
    'INSERT INTO documents (id,user_id,url,url_hash,title,author,description,domain,site,image,published,language,source_kind,tags,markdown,word_count,content_hash,created_at,updated_at,enrichment_json,base_markdown) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,url_hash) DO NOTHING',
  )
    .bind(
      id, userId, result.source, urlHash, result.title, result.author, result.description, result.domain, result.site ?? '',
      result.image ?? '', result.published, result.language ?? '', result.sourceKind, '', markdown, wordCount, contentHash, ts, ts, enrichmentJson, base,
    )
    .run();
  if (!inserted.meta.changes) {
    if (attempt >= 2) return null;
    return saveDocument(env, userId, result, result.baseContent ?? markdown, libraryLimit, attempt + 1);
  }
  return { id, changed: true };
}

export async function countDocuments(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listDocuments(
  env: Env,
  userId: string,
  opts: { limit?: number; before?: number; domain?: string; kind?: string } = {},
): Promise<DocumentSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (opts.before) (where.push('created_at < ?'), params.push(opts.before));
  if (opts.domain) (where.push('domain = ?'), params.push(opts.domain));
  if (opts.kind) (where.push('source_kind = ?'), params.push(opts.kind));
  const { results } = await env.DB.prepare(`SELECT ${SUMMARY_COLUMNS} FROM documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .bind(...params, limit)
    .all<DocumentSummary>();
  return results;
}

export async function getDocument(env: Env, userId: string, id: string): Promise<DocumentRow | null> {
  return env.DB.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND user_id = ?`).bind(id, userId).first<DocumentRow>();
}

export async function getDocumentsByIds(env: Env, userId: string, ids: string[]): Promise<DocumentSummary[]> {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM documents WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(userId, ...ids)
    .all<DocumentSummary>();
  return results;
}

export async function updateTags(env: Env, userId: string, id: string, tags: string[]): Promise<boolean> {
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')).filter(Boolean))].slice(0, 20);
  const res = await env.DB.prepare('UPDATE documents SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(clean.join(' '), now(), id, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function deleteDocument(env: Env, userId: string, id: string): Promise<boolean> {
  const doc = await env.DB.prepare('SELECT embedded_chunks FROM documents WHERE id = ? AND user_id = ?').bind(id, userId).first<{ embedded_chunks: number }>();
  if (!doc) return false;
  await env.DB.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').bind(id, userId).run();
  if (doc.embedded_chunks > 0) {
    const ids = Array.from({ length: doc.embedded_chunks }, (_, i) => `${id}#${i}`);
    await env.VECTORS.deleteByIds(ids).catch(() => undefined);
  }
  return true;
}

export async function librarySummary(env: Env, userId: string) {
  const [totals, domains, kinds] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS docs, COALESCE(SUM(word_count),0) AS words FROM documents WHERE user_id = ?').bind(userId).first<{ docs: number; words: number }>(),
    env.DB.prepare('SELECT domain, COUNT(*) AS n FROM documents WHERE user_id = ? GROUP BY domain ORDER BY n DESC LIMIT 12').bind(userId).all<{ domain: string; n: number }>(),
    env.DB.prepare('SELECT source_kind AS kind, COUNT(*) AS n FROM documents WHERE user_id = ? GROUP BY source_kind ORDER BY n DESC').bind(userId).all<{ kind: string; n: number }>(),
  ]);
  return { docs: totals?.docs ?? 0, words: totals?.words ?? 0, domains: domains.results, kinds: kinds.results };
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

/** Split Markdown on paragraph boundaries into ~CHUNK_CHARS windows with a small overlap. */
export function chunkMarkdown(title: string, markdown: string): string[] {
  const body = markdown.replace(/^---[\s\S]*?\n---\n/, '').trim();
  const paragraphs = body.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > CHUNK_CHARS && current) {
      chunks.push(current);
      current = current.slice(-CHUNK_OVERLAP) + '\n\n' + p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
    while (current.length > CHUNK_CHARS * 1.5) {
      chunks.push(current.slice(0, CHUNK_CHARS));
      current = current.slice(CHUNK_CHARS - CHUNK_OVERLAP);
    }
    if (chunks.length >= MAX_CHUNKS) break;
  }
  if (current && chunks.length < MAX_CHUNKS) chunks.push(current);
  return chunks.map((c) => (title ? `${title}\n\n${c}` : c));
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const res = (await env.AI.run(EMBEDDING_MODEL as keyof AiModels, { text: texts.slice(i, i + 16) } as never)) as { data?: number[][] };
    if (!res.data) throw new Error('Embedding model returned no vectors');
    out.push(...res.data);
  }
  return out;
}

/** Embed a document into Vectorize. Runs in `waitUntil`, so failures only mean "not yet semantic". */
export async function embedDocument(env: Env, userId: string, docId: string): Promise<number> {
  const doc = await getDocument(env, userId, docId);
  if (!doc) return 0;
  const chunks = chunkMarkdown(doc.title, doc.markdown);
  if (!chunks.length) return 0;
  const vectors = await embedTexts(env, chunks);
  if (doc.embedded_chunks > chunks.length) {
    const stale = Array.from({ length: doc.embedded_chunks - chunks.length }, (_, i) => `${docId}#${chunks.length + i}`);
    await env.VECTORS.deleteByIds(stale).catch(() => undefined);
  }
  await env.VECTORS.upsert(
    vectors.map((values, i) => ({
      id: `${docId}#${i}`,
      values,
      metadata: { user_id: userId, doc_id: docId, chunk: i, text: chunks[i].slice(0, 900) },
    })),
  );
  await env.DB.prepare('UPDATE documents SET embedded_chunks = ? WHERE id = ?').bind(chunks.length, docId).run();
  return chunks.length;
}
