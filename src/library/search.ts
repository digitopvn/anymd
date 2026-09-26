/**
 * Library search. Modes:
 *  - bm25      FTS5 BM25 over title/description/markdown/domain/tags (keywords OR-ed)
 *  - fulltext  raw FTS5 syntax: "phrases", AND/OR/NOT, prefix*, column:filters
 *  - semantic  bge-m3 embeddings in Vectorize, filtered to the caller's user_id
 *  - hybrid    bm25 + semantic fused with Reciprocal Rank Fusion (default)
 * `fanout` rewrites the query into variants with a small LLM and fuses every variant's results.
 * When the top of the fused list is too close to call, Jev may promote the best-answering doc.
 */
import type { Env } from '../env';
import type { Tracer } from '../lib/tracer';
import { embedTexts, getDocumentsByIds, type DocumentSummary } from './store';
import { isAmbiguous, jevDecide, type JevDecision } from './jev';

export type SearchMode = 'hybrid' | 'bm25' | 'fulltext' | 'semantic';
export const SEARCH_MODES: SearchMode[] = ['hybrid', 'bm25', 'fulltext', 'semantic'];

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  fanout?: boolean;
  decide?: boolean;
}

export interface SearchHit {
  id: string;
  title: string;
  url: string;
  domain: string;
  source_kind: string;
  snippet: string;
  score: number;
  matched: string[]; // which retrievers found it
  created_at: number;
  word_count: number;
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  variants: string[];
  hits: SearchHit[];
  jev: JevDecision | null;
  took_ms: number;
}

const RRF_K = 60;
const FANOUT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

interface Ranked {
  id: string;
  snippet: string;
}

function keywordQuery(q: string): string {
  const terms = q
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .slice(0, 16);
  return terms.map((t) => `"${t}"`).join(' OR ');
}

async function ftsSearch(env: Env, userId: string, match: string, limit: number): Promise<Ranked[]> {
  if (!match) return [];
  const { results } = await env.DB.prepare(
    `SELECT d.id AS id, snippet(documents_fts, 2, '<mark>', '</mark>', '…', 24) AS snip
     FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
     WHERE documents_fts MATCH ? AND d.user_id = ?
     ORDER BY bm25(documents_fts, 8.0, 3.0, 1.0, 2.0, 4.0) LIMIT ?`,
  )
    .bind(match, userId, limit)
    .all<{ id: string; snip: string }>();
  return results.map((r) => ({ id: r.id, snippet: r.snip }));
}

async function fulltextSearch(env: Env, userId: string, q: string, limit: number): Promise<Ranked[]> {
  try {
    return await ftsSearch(env, userId, q, limit);
  } catch {
    // Invalid FTS5 syntax — degrade to keyword matching rather than failing the request.
    return ftsSearch(env, userId, keywordQuery(q), limit);
  }
}

async function semanticSearch(env: Env, userId: string, q: string, limit: number): Promise<Ranked[]> {
  const [vector] = await embedTexts(env, [q]);
  const res = await env.VECTORS.query(vector, { topK: Math.min(limit * 3, 50), filter: { user_id: userId }, returnMetadata: 'all' });
  const best = new Map<string, Ranked>();
  for (const m of res.matches) {
    const docId = String(m.metadata?.doc_id ?? m.id.split('#')[0]);
    if (!best.has(docId)) best.set(docId, { id: docId, snippet: String(m.metadata?.text ?? '').slice(0, 240) });
    if (best.size >= limit) break;
  }
  return [...best.values()];
}

const FANOUT_PROMPT =
  'Rewrite a search query for a personal document library. Return ONLY a JSON array of 3 short alternative queries: one with synonyms, one more specific, one more general. No prose.';
const OPENROUTER_MODEL = 'google/gemini-2.5-flash-lite';

async function fanOutText(env: Env, q: string): Promise<string> {
  const messages = [
    { role: 'system', content: FANOUT_PROMPT },
    { role: 'user', content: q.slice(0, 300) },
  ];
  if (env.OPENROUTER_API_KEY) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': env.PUBLIC_URL,
          'X-Title': 'anymd.cc',
        },
        body: JSON.stringify({ model: OPENROUTER_MODEL, messages, max_tokens: 160, temperature: 0.3 }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const text = body.choices?.[0]?.message?.content;
        if (text) return text;
      }
    } catch {
      // fall through to Workers AI
    }
  }
  const out = (await env.AI.run(FANOUT_MODEL as keyof AiModels, { messages, max_tokens: 160, temperature: 0.3 } as never)) as { response?: string };
  return out.response ?? '';
}

/** Ask a small model for alternative phrasings. Falls back to the original query only. */
export async function fanOutQuery(env: Env, q: string): Promise<string[]> {
  try {
    const text = await fanOutText(env, q);
    const json = text.match(/\[[\s\S]*\]/)?.[0];
    const arr = json ? (JSON.parse(json) as unknown[]) : [];
    return arr
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s && s.toLowerCase() !== q.toLowerCase())
      .slice(0, 3);
  } catch {
    return [];
  }
}

function rrf(lists: { name: string; items: Ranked[] }[]): { id: string; score: number; snippet: string; matched: Set<string> }[] {
  const fused = new Map<string, { id: string; score: number; snippet: string; matched: Set<string> }>();
  for (const list of lists) {
    list.items.forEach((item, rank) => {
      const entry = fused.get(item.id) ?? { id: item.id, score: 0, snippet: '', matched: new Set<string>() };
      entry.score += 1 / (RRF_K + rank + 1);
      // Prefer keyword snippets (they carry <mark> highlights) over raw semantic chunks.
      if (!entry.snippet || (item.snippet.includes('<mark>') && !entry.snippet.includes('<mark>'))) entry.snippet = item.snippet;
      entry.matched.add(list.name);
      fused.set(item.id, entry);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

export async function searchLibrary(env: Env, userId: string, query: string, opts: SearchOptions, tracer?: Tracer): Promise<SearchResponse> {
  const started = Date.now();
  const q = query.trim().slice(0, 500);
  const mode: SearchMode = SEARCH_MODES.includes(opts.mode as SearchMode) ? (opts.mode as SearchMode) : 'hybrid';
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const span = <T,>(name: string, fn: () => Promise<T>, meta?: Record<string, unknown>) => (tracer ? tracer.span(name, fn, meta) : fn());
  if (!q) return { query: q, mode, variants: [], hits: [], jev: null, took_ms: 0 };

  const variants = opts.fanout ? await span('fanout', () => fanOutQuery(env, q)) : [];
  const queries = [q, ...variants];
  const pool = limit * 2;

  const runs: Promise<{ name: string; items: Ranked[] }>[] = [];
  for (const [i, text] of queries.entries()) {
    const tag = i === 0 ? '' : `#${i}`;
    if (mode === 'bm25' || mode === 'hybrid') runs.push(span(`bm25${tag}`, () => ftsSearch(env, userId, keywordQuery(text), pool)).then((items) => ({ name: 'bm25', items })));
    if (mode === 'fulltext') runs.push(span(`fulltext${tag}`, () => fulltextSearch(env, userId, i === 0 ? text : keywordQuery(text), pool)).then((items) => ({ name: 'fulltext', items })));
    if (mode === 'semantic' || mode === 'hybrid')
      runs.push(
        span(`semantic${tag}`, () => semanticSearch(env, userId, text, pool))
          .then((items) => ({ name: 'semantic', items }))
          .catch(() => ({ name: 'semantic', items: [] })),
      );
  }
  const lists = await Promise.all(runs);
  const fused = rrf(lists).slice(0, limit);
  const docs = await getDocumentsByIds(env, userId, fused.map((f) => f.id));
  const byId = new Map<string, DocumentSummary>(docs.map((d) => [d.id, d]));
  let hits: SearchHit[] = fused
    .filter((f) => byId.has(f.id))
    .map((f) => {
      const d = byId.get(f.id)!;
      return {
        id: d.id,
        title: d.title || d.url,
        url: d.url,
        domain: d.domain,
        source_kind: d.source_kind,
        snippet: f.snippet || d.description,
        score: Number(f.score.toFixed(5)),
        matched: [...f.matched],
        created_at: d.created_at,
        word_count: d.word_count,
      };
    });

  let jev: JevDecision | null = null;
  if (opts.decide !== false && hits.length > 1 && isAmbiguous(hits.map((h) => h.score))) {
    jev = await span('jev', () => jevDecide(env, q, hits.map((h) => ({ id: h.id, title: h.title, snippet: h.snippet, domain: h.domain }))));
    if (jev.choice) {
      const idx = hits.findIndex((h) => h.id === jev!.choice);
      if (idx > 0) hits = [hits[idx], ...hits.slice(0, idx), ...hits.slice(idx + 1)];
    }
  }
  return { query: q, mode, variants, hits, jev, took_ms: Date.now() - started };
}
