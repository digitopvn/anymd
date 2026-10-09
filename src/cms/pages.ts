/**
 * Page documents and their operations — the single service behind the editor UI, REST API, CLI,
 * MCP and WebMCP. Every mutation is a batch of ops against a `baseRevision` (optimistic
 * concurrency), optionally idempotent, validated block-by-block, and recorded as a revision.
 */
import { z } from 'zod';
import type { Env, Principal } from '../env';
import { newId, now, randomToken, sha256, slugify } from '../lib/util';
import { recordAudit } from '../services/admin/audit';
import { getBlock, SIZES, type BlockSize } from './blocks';

export interface BlockNode {
  id: string;
  type: string;
  version: number;
  size: BlockSize;
  props: Record<string, unknown>;
  slots?: Record<string, BlockNode[]>;
}

export interface PageSeo {
  title?: string;
  description?: string;
  image?: string;
  noindex?: boolean;
}

export interface PageDocument {
  version: 1;
  layout: 'default' | 'landing' | 'article';
  seo: PageSeo;
  blocks: BlockNode[];
}

export interface PageRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  revision: number;
  published_revision: number | null;
  draft: string;
  published: string | null;
  preview_token: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

export class PageError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'invalid_request',
    public details?: unknown,
  ) {
    super(message);
  }
}

const RESERVED_SLUGS = new Set([
  'api', 'mcp', 'docs', 'blog', 'pricing', 'dashboard', 'admin', 'login', 'signup', 'logout', 'legal', 'changelog', 'ecosystem',
  'authorize', 'oauth', 'assets', 'brand', 'og', 'p', 'reset', 'forgot', 'llms', 'sitemap', 'robots', 'convert', 'status',
]);

// ─── Op schemas ─────────────────────────────────────────────────────────────

const newBlock = z.object({
  type: z.string(),
  props: z.record(z.string(), z.unknown()).default({}),
  size: z.enum(SIZES).optional(),
});

const target = { parentId: z.string().optional(), slot: z.string().optional() };

export const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('insert'), block: newBlock, index: z.number().int().min(0).optional(), ...target }),
  z.object({ op: z.literal('update'), id: z.string(), props: z.record(z.string(), z.unknown()).optional(), size: z.enum(SIZES).optional() }),
  z.object({ op: z.literal('replace_props'), id: z.string(), props: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('move'), id: z.string(), index: z.number().int().min(0), ...target }),
  z.object({ op: z.literal('remove'), id: z.string() }),
  z.object({ op: z.literal('duplicate'), id: z.string() }),
  z.object({ op: z.literal('set_seo'), seo: z.object({ title: z.string().max(140).optional(), description: z.string().max(300).optional(), image: z.string().max(500).optional(), noindex: z.boolean().optional() }) }),
  z.object({ op: z.literal('set_layout'), layout: z.enum(['default', 'landing', 'article']) }),
  z.object({ op: z.literal('set_meta'), title: z.string().min(1).max(140).optional(), description: z.string().max(300).optional(), slug: z.string().min(1).max(80).optional() }),
]);
export type PageOp = z.infer<typeof OpSchema>;

export const OpsRequestSchema = z.object({
  baseRevision: z.number().int().min(1),
  ops: z.array(OpSchema).min(1).max(100),
  idempotencyKey: z.string().min(8).max(100).optional(),
  note: z.string().max(200).optional(),
});

// ─── Document helpers ───────────────────────────────────────────────────────

function validateProps(type: string, props: Record<string, unknown>): { version: number; props: Record<string, unknown> } {
  const def = getBlock(type);
  if (!def) throw new PageError(`Unknown block type "${type}". Call list_blocks for the catalog.`, 422, 'unknown_block');
  const parsed = def.schema.safeParse(props);
  if (!parsed.success) {
    throw new PageError(`Invalid props for ${type}`, 422, 'invalid_props', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return { version: def.version, props: parsed.data as Record<string, unknown> };
}

function createNode(input: z.infer<typeof newBlock>): BlockNode {
  const def = getBlock(input.type);
  const { version, props } = validateProps(input.type, input.props);
  const size = input.size ?? def!.defaultSize;
  if (!def!.sizes.includes(size)) throw new PageError(`${input.type} supports sizes: ${def!.sizes.join(', ')}`, 422, 'invalid_size');
  const node: BlockNode = { id: newId('b_'), type: input.type, version, size, props };
  if (def!.slots) node.slots = Object.fromEntries(def!.slots.map((s) => [s, []]));
  return node;
}

interface Located {
  list: BlockNode[];
  index: number;
  node: BlockNode;
}

function locate(blocks: BlockNode[], id: string): Located | null {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].id === id) return { list: blocks, index: i, node: blocks[i] };
    for (const children of Object.values(blocks[i].slots ?? {})) {
      const found = locate(children, id);
      if (found) return found;
    }
  }
  return null;
}

function targetList(doc: PageDocument, parentId?: string, slot?: string): BlockNode[] {
  if (!parentId) return doc.blocks;
  const parent = locate(doc.blocks, parentId);
  if (!parent) throw new PageError(`Parent block ${parentId} not found`, 404, 'not_found');
  const slots = parent.node.slots;
  if (!slots) throw new PageError(`Block ${parent.node.type} has no slots`, 422, 'no_slots');
  const name = slot ?? Object.keys(slots)[0];
  if (!slots[name]) throw new PageError(`Slot "${name}" does not exist on ${parent.node.type}`, 422, 'invalid_slot');
  return slots[name];
}

function cloneWithNewIds(node: BlockNode): BlockNode {
  return {
    ...structuredClone(node),
    id: newId('b_'),
    slots: node.slots ? Object.fromEntries(Object.entries(node.slots).map(([k, v]) => [k, v.map(cloneWithNewIds)])) : undefined,
  };
}

function countBlocks(blocks: BlockNode[]): number {
  return blocks.reduce((n, b) => n + 1 + Object.values(b.slots ?? {}).reduce((m, s) => m + countBlocks(s), 0), 0);
}

export function applyOpsToDocument(
  doc: PageDocument,
  meta: { title: string; description: string; slug: string },
  ops: PageOp[],
): { doc: PageDocument; meta: typeof meta; created: string[] } {
  const next = structuredClone(doc);
  const nextMeta = { ...meta };
  const created: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        if (op.parentId && op.block.type === 'columns') throw new PageError('Columns cannot be nested', 422, 'invalid_nesting');
        const node = createNode(op.block);
        const list = targetList(next, op.parentId, op.slot);
        list.splice(op.index ?? list.length, 0, node);
        created.push(node.id);
        break;
      }
      case 'update': {
        const found = locate(next.blocks, op.id);
        if (!found) throw new PageError(`Block ${op.id} not found`, 404, 'not_found');
        if (op.props) found.node.props = validateProps(found.node.type, { ...found.node.props, ...op.props }).props;
        if (op.size) {
          const def = getBlock(found.node.type)!;
          if (!def.sizes.includes(op.size)) throw new PageError(`${found.node.type} supports sizes: ${def.sizes.join(', ')}`, 422, 'invalid_size');
          found.node.size = op.size;
        }
        break;
      }
      case 'replace_props': {
        const found = locate(next.blocks, op.id);
        if (!found) throw new PageError(`Block ${op.id} not found`, 404, 'not_found');
        found.node.props = validateProps(found.node.type, op.props).props;
        break;
      }
      case 'move': {
        const found = locate(next.blocks, op.id);
        if (!found) throw new PageError(`Block ${op.id} not found`, 404, 'not_found');
        if (op.parentId && (op.parentId === op.id || (found.node.slots && locate(Object.values(found.node.slots).flat(), op.parentId)))) {
          throw new PageError('Cannot move a block into itself', 422, 'invalid_move');
        }
        if (op.parentId && found.node.type === 'columns') throw new PageError('Columns cannot be nested', 422, 'invalid_nesting');
        found.list.splice(found.index, 1);
        const list = targetList(next, op.parentId, op.slot);
        list.splice(Math.min(op.index, list.length), 0, found.node);
        break;
      }
      case 'remove': {
        const found = locate(next.blocks, op.id);
        if (!found) throw new PageError(`Block ${op.id} not found`, 404, 'not_found');
        found.list.splice(found.index, 1);
        break;
      }
      case 'duplicate': {
        const found = locate(next.blocks, op.id);
        if (!found) throw new PageError(`Block ${op.id} not found`, 404, 'not_found');
        const copy = cloneWithNewIds(found.node);
        found.list.splice(found.index + 1, 0, copy);
        created.push(copy.id);
        break;
      }
      case 'set_seo':
        next.seo = { ...next.seo, ...op.seo };
        break;
      case 'set_layout':
        next.layout = op.layout;
        break;
      case 'set_meta':
        if (op.title) nextMeta.title = op.title;
        if (op.description !== undefined) nextMeta.description = op.description;
        if (op.slug) nextMeta.slug = normalizeSlug(op.slug);
        break;
    }
  }
  if (countBlocks(next.blocks) > 80) throw new PageError('A page can hold at most 80 blocks', 422, 'too_many_blocks');
  return { doc: next, meta: nextMeta, created };
}

export function normalizeSlug(raw: string): string {
  const slug = raw
    .split('/')
    .map((s) => slugify(s))
    .filter(Boolean)
    .join('/');
  if (!slug) throw new PageError('Slug is empty', 422, 'invalid_slug');
  if (RESERVED_SLUGS.has(slug.split('/')[0])) throw new PageError(`Slug "${slug}" is reserved`, 422, 'reserved_slug');
  return slug;
}

// ─── Templates ──────────────────────────────────────────────────────────────

type Seed = { type: string; props: Record<string, unknown>; size?: BlockSize };

export const TEMPLATES: Record<string, { label: string; description: string; layout: PageDocument['layout']; blocks: Seed[] }> = {
  blank: { label: 'Blank', description: 'Start from nothing.', layout: 'default', blocks: [] },
  'ads-landing': {
    label: 'Ads landing page',
    description: 'Focused page for paid campaigns: hero with converter, proof, pricing, FAQ, CTA. Minimal navigation.',
    layout: 'landing',
    blocks: [
      { type: 'offer', props: { title: 'Launch offer', code: 'LAUNCH30', percent: 30, endsAt: '2026-10-31T23:59:59Z', href: '/pricing' } },
      { type: 'hero', props: { title: 'Turn any link into clean Markdown', subtitle: 'Web pages, X posts, YouTube, PDFs — ready for ChatGPT, Claude and your agents.', showConverter: true, primary: { label: 'Start free', href: '/signup' } } },
      { type: 'feature-grid', props: { title: 'Why it works', columns: 3, items: [{ icon: 'bolt', title: 'Fewer tokens', body: 'Only the content, none of the page chrome.' }, { icon: 'search', title: 'Searchable library', body: 'Everything you convert, findable later.' }, { icon: 'plug', title: 'Agent-ready', body: 'API, CLI, MCP and WebMCP.' }] } },
      { type: 'pricing', props: { title: 'Start free. Upgrade when it pays for itself.' } },
      { type: 'faq', props: { title: 'FAQ', items: [{ q: 'Do I need an account?', a: 'No — prefix any URL with anymd.cc/. An account adds a library and 500 credits a month.' }] } },
      { type: 'cta', props: { title: 'Stop feeding your agent HTML.', primary: { label: 'Create free account', href: '/signup' }, tone: 'accent' } },
    ],
  },
  'seo-article': {
    label: 'SEO article',
    description: 'Long-form page targeting a search query: short hero, rich text, FAQ, CTA.',
    layout: 'article',
    blocks: [
      { type: 'hero', props: { title: 'How to convert a web page to Markdown', subtitle: 'The fastest way, with and without code.', align: 'left' }, size: 'small' },
      { type: 'rich-text', props: { markdown: '## The short answer\n\nPut `anymd.cc/` in front of the link.' } },
      { type: 'converter', props: { title: 'Try it here' } },
      { type: 'faq', props: { items: [{ q: 'Is it free?', a: 'Yes, up to 50 conversions a day without an account.' }] } },
      { type: 'cta', props: { title: 'Keep every page you convert', primary: { label: 'Create free account', href: '/signup' }, tone: 'dark' } },
    ],
  },
  'product-launch': {
    label: 'Product launch',
    description: 'Announcement page: hero, stats, steps, code, CTA.',
    layout: 'default',
    blocks: [
      { type: 'hero', props: { eyebrow: 'New', title: 'Something new on anymd', subtitle: 'What it is and why it matters.', primary: { label: 'Try it', href: '/' } } },
      { type: 'stats', props: { items: [{ value: '9', label: 'source types' }, { value: '4', label: 'search modes' }] } },
      { type: 'steps', props: { title: 'How it works', items: [{ title: 'Step one', body: 'Describe it.' }] } },
      { type: 'code-tabs', props: { tabs: [{ label: 'cURL', language: 'bash', code: 'curl https://anymd.cc/example.com' }] } },
      { type: 'cta', props: { title: 'Ready?', primary: { label: 'Get started', href: '/signup' } } },
    ],
  },
};

function templateDocument(template: string): PageDocument {
  const t = TEMPLATES[template] ?? TEMPLATES.blank;
  return { version: 1, layout: t.layout, seo: {}, blocks: t.blocks.map((b) => createNode({ type: b.type, props: b.props, size: b.size })) };
}

// ─── Persistence ────────────────────────────────────────────────────────────

export function parseDoc(raw: string | null): PageDocument | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PageDocument;
  } catch {
    return null;
  }
}

export function pageView(row: PageRow, origin: string) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    revision: row.revision,
    publishedRevision: row.published_revision,
    url: `${origin}/p/${row.slug}`,
    markdownUrl: `${origin}/p/${row.slug}.md`,
    previewUrl: `${origin}/p/${row.slug}?preview=${row.preview_token}`,
    updatedAt: new Date(row.updated_at).toISOString(),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    draft: parseDoc(row.draft),
  };
}

export async function listPages(env: Env): Promise<PageRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM pages WHERE status != 'archived' ORDER BY updated_at DESC LIMIT 200").all<PageRow>();
  return results;
}

export async function getPage(env: Env, idOrSlug: string): Promise<PageRow | null> {
  return env.DB.prepare('SELECT * FROM pages WHERE id = ? OR slug = ?').bind(idOrSlug, idOrSlug).first<PageRow>();
}

/** CMS changes go to the shared audit log with the acting credential and adapter. */
async function audit(env: Env, actor: Principal, action: string, target: string, meta: Record<string, unknown> = {}) {
  await recordAudit(env, actor, { action, targetType: 'page', target, meta });
}

export async function createPage(
  env: Env,
  actor: Principal,
  input: { slug: string; title: string; description?: string; template?: string; layout?: PageDocument['layout'] },
): Promise<PageRow> {
  const slug = normalizeSlug(input.slug);
  if (await env.DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(slug).first()) throw new PageError(`Slug "${slug}" already exists`, 409, 'slug_taken');
  const doc = templateDocument(input.template ?? 'blank');
  if (input.layout) doc.layout = input.layout;
  const ts = now();
  const row: PageRow = {
    id: newId('pg_'),
    slug,
    title: input.title,
    description: input.description ?? '',
    status: 'draft',
    revision: 1,
    published_revision: null,
    draft: JSON.stringify(doc),
    published: null,
    preview_token: randomToken(18),
    created_by: actor.userId,
    created_at: ts,
    updated_at: ts,
    published_at: null,
  };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO pages (id,slug,title,description,status,revision,draft,preview_token,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(
      row.id, row.slug, row.title, row.description, row.status, row.revision, row.draft, row.preview_token, row.created_by, ts, ts,
    ),
    env.DB.prepare('INSERT INTO page_revisions (page_id,revision,doc,author,note,created_at) VALUES (?,?,?,?,?,?)').bind(row.id, 1, row.draft, actor.userId, `created from ${input.template ?? 'blank'}`, ts),
  ]);
  await audit(env, actor, 'page.create', row.id, { slug, template: input.template ?? 'blank' });
  return row;
}

export async function applyPageOps(env: Env, actor: Principal, pageId: string, request: z.infer<typeof OpsRequestSchema>) {
  const principalKey = `${actor.kind}:${actor.userId}:${actor.apiKeyId ?? ''}`;
  const payloadHash = await sha256(JSON.stringify({ pageId, ops: request.ops, baseRevision: request.baseRevision }));
  if (request.idempotencyKey) {
    const prior = await env.DB.prepare('SELECT payload_hash, response FROM idempotency_keys WHERE key = ? AND principal = ?')
      .bind(request.idempotencyKey, principalKey)
      .first<{ payload_hash: string; response: string }>();
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new PageError('idempotencyKey was already used with a different payload', 422, 'idempotency_mismatch');
      return { ...(JSON.parse(prior.response) as object), replayed: true };
    }
  }
  const page = await getPage(env, pageId);
  if (!page || page.status === 'archived') throw new PageError('Page not found', 404, 'not_found');
  if (page.revision !== request.baseRevision) {
    throw new PageError(`Revision conflict: page is at revision ${page.revision}, you sent baseRevision ${request.baseRevision}. Re-read the page and retry.`, 409, 'revision_conflict', {
      currentRevision: page.revision,
    });
  }
  const doc = parseDoc(page.draft)!;
  const { doc: nextDoc, meta, created } = applyOpsToDocument(doc, { title: page.title, description: page.description, slug: page.slug }, request.ops);
  if (meta.slug !== page.slug && (await env.DB.prepare('SELECT id FROM pages WHERE slug = ? AND id != ?').bind(meta.slug, page.id).first())) {
    throw new PageError(`Slug "${meta.slug}" already exists`, 409, 'slug_taken');
  }
  const revision = page.revision + 1;
  const ts = now();
  const serialized = JSON.stringify(nextDoc);
  // The revision guard in WHERE makes the write atomic against concurrent editors.
  const res = await env.DB.prepare('UPDATE pages SET draft=?, revision=?, title=?, description=?, slug=?, updated_at=? WHERE id=? AND revision=?')
    .bind(serialized, revision, meta.title, meta.description, meta.slug, ts, page.id, page.revision)
    .run();
  if (!res.meta.changes) throw new PageError('Revision conflict: the page changed while applying. Re-read and retry.', 409, 'revision_conflict');
  const response = { pageId: page.id, revision, createdBlockIds: created, slug: meta.slug };
  const stmts = [env.DB.prepare('INSERT INTO page_revisions (page_id,revision,doc,author,note,created_at) VALUES (?,?,?,?,?,?)').bind(page.id, revision, serialized, actor.userId, request.note ?? '', ts)];
  if (request.idempotencyKey) {
    stmts.push(
      env.DB.prepare('INSERT INTO idempotency_keys (key,principal,op,payload_hash,response,created_at) VALUES (?,?,?,?,?,?)').bind(
        request.idempotencyKey, principalKey, 'page.ops', payloadHash, JSON.stringify(response), ts,
      ),
    );
  }
  await env.DB.batch(stmts);
  await audit(env, actor, 'page.ops', page.id, { revision, ops: request.ops.map((o) => o.op) });
  return { ...response, replayed: false };
}

export async function publishPage(env: Env, actor: Principal, pageId: string, revision?: number) {
  const page = await getPage(env, pageId);
  if (!page || page.status === 'archived') throw new PageError('Page not found', 404, 'not_found');
  let doc = page.draft;
  let rev = page.revision;
  if (revision && revision !== page.revision) {
    const old = await env.DB.prepare('SELECT doc FROM page_revisions WHERE page_id = ? AND revision = ?').bind(page.id, revision).first<{ doc: string }>();
    if (!old) throw new PageError(`Revision ${revision} not found`, 404, 'not_found');
    doc = old.doc;
    rev = revision;
  }
  const ts = now();
  await env.DB.prepare("UPDATE pages SET published=?, published_revision=?, status='published', published_at=?, updated_at=? WHERE id=?").bind(doc, rev, ts, ts, page.id).run();
  await env.CACHE.delete(`page:${page.slug}`);
  await audit(env, actor, 'page.publish', page.id, { revision: rev });
  return { pageId: page.id, publishedRevision: rev, slug: page.slug };
}

export async function unpublishPage(env: Env, actor: Principal, pageId: string) {
  const page = await getPage(env, pageId);
  if (!page) throw new PageError('Page not found', 404, 'not_found');
  await env.DB.prepare("UPDATE pages SET status='draft', published=NULL, published_revision=NULL, updated_at=? WHERE id=?").bind(now(), page.id).run();
  await env.CACHE.delete(`page:${page.slug}`);
  await audit(env, actor, 'page.unpublish', page.id);
  return { pageId: page.id, status: 'draft' };
}

export async function archivePage(env: Env, actor: Principal, pageId: string) {
  const page = await getPage(env, pageId);
  if (!page) throw new PageError('Page not found', 404, 'not_found');
  await env.DB.prepare("UPDATE pages SET status='archived', slug = slug || '--archived-' || ?, updated_at=? WHERE id=?").bind(Date.now().toString(36), now(), page.id).run();
  await env.CACHE.delete(`page:${page.slug}`);
  await audit(env, actor, 'page.archive', page.id);
  return { pageId: page.id, status: 'archived' };
}

export async function listRevisions(env: Env, pageId: string) {
  const { results } = await env.DB.prepare('SELECT revision, author, note, created_at FROM page_revisions WHERE page_id = ? ORDER BY revision DESC LIMIT 50').bind(pageId).all();
  return results;
}

/** New preview link; the previous one stops working. The token itself is never audited. */
export async function rotatePreviewToken(env: Env, actor: Principal, pageId: string): Promise<string> {
  const token = randomToken(18);
  await env.DB.prepare('UPDATE pages SET preview_token = ? WHERE id = ?').bind(token, pageId).run();
  await audit(env, actor, 'page.preview_rotate', pageId);
  return token;
}

/** Markdown twin of a page document. */
export function pageToMarkdown(title: string, description: string, doc: PageDocument): string {
  const walk = (blocks: BlockNode[]): string[] =>
    blocks.flatMap((b) => {
      const def = getBlock(b.type);
      const own = def ? def.toMarkdown(b.props as never) : '';
      const children = Object.values(b.slots ?? {}).flatMap(walk);
      return [own, ...children].filter(Boolean);
    });
  const body = walk(doc.blocks).join('\n\n');
  const hasH1 = /^# /m.test(body);
  return `${hasH1 ? '' : `# ${title}\n\n`}${description && !hasH1 ? `${description}\n\n` : ''}${body}\n`;
}
