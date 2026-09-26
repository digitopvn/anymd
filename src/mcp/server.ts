/**
 * MCP server over Streamable HTTP, stateless: every POST carries one JSON-RPC message (or a
 * batch) and gets a JSON response. Tools are filtered by the caller's scopes, so a read-only key
 * never even sees write tools. Auth is resolved before this runs (API key or OAuth token).
 */
import { z } from 'zod';
import { getUser } from '../auth/identity';
import { blockCatalog } from '../cms/blocks';
import { applyPageOps, createPage, getPage, listPages, OpSchema, PageError, pageView, publishPage, TEMPLATES, unpublishPage } from '../cms/pages';
import { createPost, getPostRow, listAllPosts, PostInputSchema, setPostPublished, updatePost } from '../cms/posts';
import { runConversion } from '../convert/service';
import { ConvertError } from '../convert/types';
import type { Env, Principal, Scope, WaitUntil } from '../env';
import { deleteDocument, getDocument, listDocuments } from '../library/store';
import { convertPayload, searchForPrincipal, usageSummary } from '../services';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'anymd', title: 'anymd — any URL to Markdown', version: '1.0.0' };
const INSTRUCTIONS =
  'anymd converts any URL (web pages, X, YouTube, GitHub, Reddit, Hacker News, PDFs, Office files, images) to clean Markdown and keeps a private, searchable library of everything converted. ' +
  'Use convert_url to read a page, search_library to recall saved pages, get_document for full text. Page-builder tools (list_blocks → create_page → apply_page_ops → publish_page) build landing pages: always read the page first and pass its current revision as baseRevision.';

interface ToolContext {
  env: Env;
  ctx: WaitUntil;
  principal: Principal & { userId: string };
  origin: string;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  input: z.ZodObject<z.ZodRawShape>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: any, t: ToolContext) => Promise<unknown>;
}

const READ = { readOnlyHint: true, openWorldHint: false };

const TOOLS: ToolDef[] = [
  {
    name: 'convert_url',
    title: 'Convert URL to Markdown',
    description: 'Fetch any URL and return clean Markdown with metadata. Saves to the library by default (save=false to skip). Costs 1–5 credits; cached results are free.',
    scope: 'convert',
    input: z.object({ url: z.string().describe('The URL to convert, e.g. https://example.com/post'), save: z.boolean().optional().describe('Save to the library (default true)'), fresh: z.boolean().optional().describe('Bypass the 1-hour cache') }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: async (a, t) => {
      const r = await runConversion(t.env, t.ctx, { url: a.url, channel: 'mcp', principal: t.principal, save: a.save, fresh: a.fresh });
      const { content: _content, ...rest } = convertPayload(r);
      return rest;
    },
  },
  {
    name: 'search_library',
    title: 'Search library',
    description: 'Search everything this user converted. Modes: hybrid (default: BM25 + semantic fused with RRF), bm25, fulltext (FTS5 syntax), semantic. Free.',
    scope: 'library:read',
    input: z.object({
      query: z.string().min(1),
      mode: z.enum(['hybrid', 'bm25', 'fulltext', 'semantic']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      fanout: z.boolean().optional().describe('Rewrite the query into variants (Pro+)'),
      decide: z.boolean().optional().describe('Let Jev break near-ties at the top (Pro+)'),
    }),
    annotations: READ,
    run: (a, t) => searchForPrincipal(t.env, t.principal, 'mcp', a.query, a),
  },
  {
    name: 'get_document',
    title: 'Get document',
    description: 'Full Markdown and metadata of one library document by id.',
    scope: 'library:read',
    input: z.object({ id: z.string() }),
    annotations: READ,
    run: async (a, t) => {
      const doc = await getDocument(t.env, t.principal.userId, a.id);
      if (!doc) throw new ToolError('Document not found');
      return { ...doc, tags: doc.tags.split(' ').filter(Boolean) };
    },
  },
  {
    name: 'list_documents',
    title: 'List documents',
    description: 'Most recent library documents (metadata only). Filter by domain.',
    scope: 'library:read',
    input: z.object({ limit: z.number().int().min(1).max(100).optional(), domain: z.string().optional(), before: z.number().optional().describe('Cursor: created_at of the last item') }),
    annotations: READ,
    run: async (a, t) => {
      const items = await listDocuments(t.env, t.principal.userId, { limit: a.limit ?? 20, domain: a.domain, before: a.before });
      return { items, next_cursor: items.length === (a.limit ?? 20) ? items[items.length - 1].created_at : null };
    },
  },
  {
    name: 'delete_document',
    title: 'Delete document',
    description: 'Permanently delete a library document and its embeddings.',
    scope: 'library:write',
    input: z.object({ id: z.string() }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (a, t) => {
      if (!(await deleteDocument(t.env, t.principal.userId, a.id))) throw new ToolError('Document not found');
      return { ok: true };
    },
  },
  {
    name: 'usage_summary',
    title: 'Usage summary',
    description: 'Plan, credits used and remaining this month, and recent requests.',
    scope: 'usage:read',
    input: z.object({ days: z.number().int().min(1).max(90).optional() }),
    annotations: READ,
    run: async (a, t) => {
      const user = await getUser(t.env, t.principal.userId);
      const s = await usageSummary(t.env, t.principal.userId, user?.plan ?? 'free', a.days ?? 30);
      return { ...s, events: s.events.slice(0, 20) };
    },
  },
  {
    name: 'list_blocks',
    title: 'List page blocks',
    description: 'Block catalog for the page builder: types, JSON Schema for props, sizes (small|medium|large), slots and an example of each.',
    scope: 'pages:read',
    input: z.object({}),
    annotations: READ,
    run: async () => ({ items: blockCatalog() }),
  },
  {
    name: 'list_page_templates',
    title: 'List page templates',
    description: 'Starting templates for create_page.',
    scope: 'pages:read',
    input: z.object({}),
    annotations: READ,
    run: async () => ({ items: Object.entries(TEMPLATES).map(([id, tpl]) => ({ id, label: tpl.label, description: tpl.description, layout: tpl.layout, blocks: tpl.blocks.map((b) => b.type) })) }),
  },
  {
    name: 'list_pages',
    title: 'List pages',
    description: 'Landing pages with status, revision and URLs.',
    scope: 'pages:read',
    input: z.object({}),
    annotations: READ,
    run: async (_a, t) => ({ items: (await listPages(t.env)).map((r) => ({ ...pageView(r, t.origin), draft: undefined })) }),
  },
  {
    name: 'get_page',
    title: 'Get page',
    description: 'A page with its draft document (blocks with ids) and current revision. Read this before apply_page_ops.',
    scope: 'pages:read',
    input: z.object({ id: z.string().describe('Page id or slug') }),
    annotations: READ,
    run: async (a, t) => {
      const row = await getPage(t.env, a.id);
      if (!row || row.status === 'archived') throw new ToolError('Page not found');
      return pageView(row, t.origin);
    },
  },
  {
    name: 'create_page',
    title: 'Create page',
    description: 'Create a draft landing page from a template (blank, ads-landing, seo-article, product-launch). Published later with publish_page at /p/<slug>.',
    scope: 'pages:write',
    input: z.object({ slug: z.string().min(1).max(80), title: z.string().min(1).max(140), description: z.string().max(300).optional(), template: z.string().optional(), layout: z.enum(['default', 'landing', 'article']).optional() }),
    annotations: { readOnlyHint: false, openWorldHint: false },
    run: async (a, t) => pageView(await createPage(t.env, t.principal, a), t.origin),
  },
  {
    name: 'apply_page_ops',
    title: 'Apply page ops',
    description:
      'Apply a batch of edits to a page draft atomically. baseRevision must equal the page revision (else revision_conflict: re-read with get_page and retry). Ops: insert {block:{type,props,size}, index?, parentId?, slot?}, update {id, props?, size?}, replace_props {id, props}, move {id, index, parentId?, slot?}, remove {id}, duplicate {id}, set_seo {seo}, set_layout {layout}, set_meta {title?, description?, slug?}.',
    scope: 'pages:write',
    input: z.object({ pageId: z.string(), baseRevision: z.number().int().min(1), ops: z.array(OpSchema).min(1).max(100), idempotencyKey: z.string().min(8).max(100).optional(), note: z.string().max(200).optional() }),
    annotations: { readOnlyHint: false, openWorldHint: false },
    run: async (a, t) => {
      const page = await getPage(t.env, a.pageId);
      if (!page) throw new ToolError('Page not found');
      const out = await applyPageOps(t.env, t.principal, page.id, { baseRevision: a.baseRevision, ops: a.ops, idempotencyKey: a.idempotencyKey, note: a.note });
      const fresh = await getPage(t.env, page.id);
      return { ...out, previewUrl: fresh ? `${t.origin}/p/${fresh.slug}?preview=${fresh.preview_token}` : null };
    },
  },
  {
    name: 'publish_page',
    title: 'Publish page',
    description: 'Publish the current draft (or a given revision) to /p/<slug>.',
    scope: 'pages:publish',
    input: z.object({ pageId: z.string(), revision: z.number().int().optional() }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    run: async (a, t) => {
      const page = await getPage(t.env, a.pageId);
      if (!page) throw new ToolError('Page not found');
      const out = await publishPage(t.env, t.principal, page.id, a.revision);
      return { ...out, url: `${t.origin}/p/${out.slug}` };
    },
  },
  {
    name: 'unpublish_page',
    title: 'Unpublish page',
    description: 'Take a page offline; the draft is kept.',
    scope: 'pages:publish',
    input: z.object({ pageId: z.string() }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    run: async (a, t) => {
      const page = await getPage(t.env, a.pageId);
      if (!page) throw new ToolError('Page not found');
      return unpublishPage(t.env, t.principal, page.id);
    },
  },
  {
    name: 'list_posts',
    title: 'List blog posts',
    description: 'Blog posts (drafts, published and bundled).',
    scope: 'content:read',
    input: z.object({}),
    annotations: READ,
    run: async (_a, t) => ({ items: (await listAllPosts(t.env)).map((p) => ({ id: p.id, slug: p.slug, title: p.title, status: p.status })) }),
  },
  {
    name: 'upsert_post',
    title: 'Create or update blog post',
    description: 'Create a draft post, or update one by id. Markdown body. Publish with publish_post.',
    scope: 'content:write',
    input: PostInputSchema.extend({ id: z.string().optional().describe('Post id to update; omit to create') }),
    annotations: { readOnlyHint: false, openWorldHint: false },
    run: async (a, t) => {
      const { id, ...input } = a;
      if (id) {
        const row = await updatePost(t.env, t.principal, id, input);
        if (!row) throw new ToolError('Post not found');
        return row;
      }
      return createPost(t.env, t.principal, input);
    },
  },
  {
    name: 'publish_post',
    title: 'Publish blog post',
    description: 'Publish (publish=true) or unpublish a post.',
    scope: 'content:publish',
    input: z.object({ id: z.string(), publish: z.boolean().default(true) }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    run: async (a, t) => {
      if (!(await getPostRow(t.env, a.id))) throw new ToolError('Post not found');
      const row = await setPostPublished(t.env, t.principal, a.id, a.publish);
      return { ...row, url: `${t.origin}/blog/${row!.slug}` };
    },
  },
];

class ToolError extends Error {}

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const inputSchemas = new Map(TOOLS.map((t) => [t.name, z.toJSONSchema(t.input, { io: 'input' })]));

function visibleTools(p: Principal) {
  return TOOLS.filter((t) => p.scopes.includes(t.scope));
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

async function callTool(params: Record<string, unknown> | undefined, t: ToolContext) {
  const name = String(params?.name ?? '');
  const tool = visibleTools(t.principal).find((x) => x.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool or missing scope: ${name}` }] };
  const parsed = tool.input.safeParse(params?.arguments ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${issues}` }] };
  }
  try {
    const out = await tool.run(parsed.data, t);
    const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    // convert_url: lead with the Markdown so the model reads the page, not escaped JSON.
    if (tool.name === 'convert_url' && out && typeof out === 'object' && 'markdown' in out) {
      const { markdown, ...meta } = out as { markdown: string };
      return { content: [{ type: 'text', text: markdown }, { type: 'text', text: JSON.stringify(meta, null, 2) }], structuredContent: out };
    }
    return { content: [{ type: 'text', text }], ...(out && typeof out === 'object' && !Array.isArray(out) ? { structuredContent: out } : {}) };
  } catch (err) {
    const e = err as { code?: string; message?: string; details?: unknown };
    const known = err instanceof ToolError || err instanceof PageError || err instanceof ConvertError || (e as { status?: number }).status;
    const text = known ? `${e.code ? `${e.code}: ` : ''}${e.message}${e.details ? `\n${JSON.stringify(e.details, null, 2)}` : ''}` : 'Internal error while running the tool.';
    if (!known) console.error('mcp tool error', name, err);
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

async function handleMessage(msg: JsonRpcMessage, t: ToolContext): Promise<object | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isNotification ? null : rpcError(id, -32600, 'Invalid Request');
  if (isNotification) return null;
  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: visibleTools(t.principal).map((x) => ({ name: x.name, title: x.title, description: x.description, inputSchema: inputSchemas.get(x.name), annotations: { title: x.title, ...x.annotations } })) },
      };
    case 'tools/call':
      return { jsonrpc: '2.0', id, result: await callTool(msg.params, t) };
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
};

export async function handleMcp(request: Request, env: Env, ctx: WaitUntil, principal: Principal): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response(JSON.stringify(rpcError(null, -32000, 'This server is stateless: POST JSON-RPC messages; no SSE stream.')), { status: 405, headers: { ...CORS, Allow: 'POST, OPTIONS', 'Content-Type': 'application/json' } });
  if (!principal.userId) return new Response(JSON.stringify(rpcError(null, -32001, 'Unauthorized')), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400, headers: CORS });
  }
  const t: ToolContext = { env, ctx, principal: principal as Principal & { userId: string }, origin: env.PUBLIC_URL };
  const batch = Array.isArray(payload);
  const messages = (batch ? payload : [payload]) as JsonRpcMessage[];
  const responses = (await Promise.all(messages.map((m) => handleMessage(m, t)))).filter(Boolean);
  if (!responses.length) return new Response(null, { status: 202, headers: CORS });
  return Response.json(batch ? responses : responses[0], { headers: CORS });
}

/** Tool names by scope, for docs and the OpenAPI description. */
export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);
