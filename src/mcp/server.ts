/**
 * MCP server over Streamable HTTP, stateless: every POST carries one JSON-RPC message (or, for
 * pre-2025-06-18 clients, a batch) and gets a JSON response. Both protocol eras are served (see
 * ./protocol). Tools are filtered by the caller's scopes, so a read-only key never even sees write
 * tools; calling a hidden tool asks OAuth clients to step up their scopes. Auth is resolved before
 * this runs (API key or OAuth token); requests are rate limited per user and credential.
 */
import { z } from 'zod';
import { getUser } from '../auth/identity';
import { scopesForRole } from '../auth/roles';
import { blockCatalog } from '../cms/blocks';
import { applyPageOps, createPage, getPage, listPages, OpSchema, PageError, pageView, publishPage, TEMPLATES, unpublishPage } from '../cms/pages';
import { createPost, getPostRow, listAllPosts, PostInputSchema, setPostPublished, updatePost } from '../cms/posts';
import { runConversion } from '../convert/service';
import { getVideoJob, videoJobPayload } from '../convert/youtube-video';
import { runSocialSearch, SOCIAL_SEARCH_ALL_MAX, socialSearchInput, socialSearchPayload } from '../convert/social-search';
import { SOCIAL_SEARCH_CREDITS } from '../billing/plans';
import { enrichmentOptions } from '../convert/enrichment-types';
import { ConvertError } from '../convert/types';
import type { Env, Principal, WaitUntil } from '../env';
import { deleteDocument, editTags, getDocument, listDocuments, listTags, MAX_TAG_FILTERS, MAX_TAG_LENGTH, MAX_TAGS, parseStoredTags, parseTagFilter } from '../library/store';
import { convertPayload, searchForPrincipal, usageSummary } from '../services';
import { AdminError } from '../services/admin/shared';
import { ACCOUNT_TOOLS } from './account-tools';
import { ADMIN_TOOLS } from './admin-tools';
import { CMS_PARITY_TOOLS } from './cms-parity-tools';
import {
  isModernRequest,
  LEGACY_VERSIONS,
  LIST_TTL_MS,
  META_SERVER_INFO,
  RPC,
  resourceMetadataUrl,
  rpcError,
  SUPPORTED_VERSIONS,
  validateModern,
  type JsonRpcId,
  type JsonRpcMessage,
} from './protocol';
import { checkMcpRate, type RateLimited } from './rate-limit';
import { DESTRUCTIVE, IDEMPOTENT_WRITE, isMutation, READ_ONLY, ToolError, WRITE, type ToolContext, type ToolDef } from './tool-types';

const SERVER_INFO = { name: 'anymd', title: 'anymd — the web context layer for AI agents', version: '1.1.0' };
const INSTRUCTIONS =
  'anymd is the web context layer for AI agents: it reads public web content (web pages, GitHub, YouTube, Reddit, Hacker News, X, PDFs, Office files, images) into structured Markdown and keeps a private, searchable library of everything read. ' +
  'Use read_url to read a page (convert_url is the same tool under its original name), search_library to recall saved sources before reading the web again, get_document for full text, search_social to find public posts on X, Facebook, Instagram, Threads or LinkedIn (read a result with read_url). Page-builder tools (list_blocks → create_page → apply_page_ops → publish_page) build landing pages: always read the page first and pass its current revision as baseRevision. ' +
  'Admin tools appear only for owner/admin credentials granted their scopes: start with system_overview, page with next_cursor, pass expected* values and an idempotencyKey with every change; every change lands in list_audit_events.';

const READ = READ_ONLY;
const TAG_LIST_INPUT = z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS).optional();
const TAG_FILTER_INPUT = z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAG_FILTERS).optional().describe('Only documents carrying every one of these tags ([] means no filter)');

/** Reading a URL. Exposed as `read_url`, and as `convert_url` for clients built before the rename. */
const READ_URL_INPUT = z.object({
  ...enrichmentOptions,
  url: z.string().describe('The public URL to read, e.g. https://example.com/post'),
  save: z.boolean().optional().describe('Save to the library (default true)'),
  fresh: z.boolean().optional().describe('Bypass the 1-hour cache'),
  removeImages: z.boolean().optional().describe('Strip image/media references (no credit effect)'),
});
const READ_URL_TEXT = 'Saves to the library by default (save=false to skip) when this connection holds library:write; the result reports saved and, when not saved, not_saved_reason (missing_scope means re-authorize with library:write). Deep reading is opt-in and costs extra credits: expandThread (X same-author thread, up to maxThreadPosts), includeComments and analyzeImages. Omitted options use the account\'s saved reading preferences, otherwise they are off; the user\'s sign-in alone never enables them. maxCredits defaults to 100; partial results explain missing content. Cached reads are free. For YouTube, downloadVideo=true (or the account setting) also starts a background download of the lowest-quality video to the anymd CDN and returns video_download.id: check it with get_video_download. analyzeVideo=true (implies downloadVideo) then has the same job analyzed by AI (analysis.markdown); both cost extra credits outside maxCredits, charged only when ready.';
const readUrl = async (a: z.infer<typeof READ_URL_INPUT>, t: ToolContext) => {
  const r = await runConversion(t.env, t.ctx, { ...a, channel: 'mcp', principal: t.principal });
  const { content: _content, ...rest } = convertPayload(r);
  return rest;
};
const READ_URL_TOOLS = new Set(['read_url', 'convert_url']);

const TOOLS: ToolDef[] = [
  {
    name: 'read_url',
    title: 'Read URL',
    description: `Read a public URL and return its content as structured Markdown with metadata. ${READ_URL_TEXT}`,
    scope: 'convert',
    input: READ_URL_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: readUrl,
  },
  {
    name: 'convert_url',
    title: 'Convert URL to Markdown',
    description: `Same as read_url, kept under its original name for existing clients. Fetch a URL and return clean Markdown with metadata. ${READ_URL_TEXT}`,
    scope: 'convert',
    input: READ_URL_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: readUrl,
  },
  {
    name: 'search_library',
    title: 'Search library',
    description: 'Search every source this user has read and saved. Modes: hybrid (default: BM25 + semantic fused with RRF), bm25, fulltext (FTS5 syntax), semantic. Free.',
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
    name: 'get_video_download',
    title: 'Get video download',
    description: 'Status of a background YouTube video download started by read_url with downloadVideo (option or account setting). Poll every 15-30 s until status is ready (cdn_url is the lowest-quality MP4 on the anymd CDN) or failed (see error). Credits are charged only when ready. When analysis is not null (analyzeVideo), keep polling until analysis.status is ready (analysis.markdown is the AI analysis of the video) or failed.',
    scope: 'convert',
    input: z.object({ id: z.string().describe('Job id from read_url, e.g. vid_…') }),
    annotations: READ,
    run: async (a, t) => {
      const job = t.principal.userId ? await getVideoJob(t.env, t.principal.userId, a.id) : null;
      if (!job) throw new ToolError('Video download not found');
      return videoJobPayload(t.env, job);
    },
  },
  {
    name: 'search_social',
    title: 'Search social media',
    description: `Search public posts on X, Facebook, Instagram, Threads, LinkedIn or all of them (platform "all", merged newest first) by keyword and return normalized results (platform, url, author, text, published_at, stats) plus a per-platform status. Each page that returns results costs ${SOCIAL_SEARCH_CREDITS.x} credits on X, Facebook, Instagram or Threads and ${SOCIAL_SEARCH_CREDITS.linkedin} on LinkedIn; "all" searches every platform at once and costs the sum for the platforms that returned results (at most ${SOCIAL_SEARCH_ALL_MAX}). Empty pages are free. Pass next_cursor as cursor for the next page. Searches are kept in the dashboard history, not the library; read a post with read_url.`,
    scope: 'convert',
    input: z.object(socialSearchInput),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (a, t) => socialSearchPayload(await runSocialSearch(t.env, t.ctx, { ...a, channel: 'mcp', principal: t.principal })),
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
      return { ...doc, tags: parseStoredTags(doc.tags) };
    },
  },
  {
    name: 'list_documents',
    title: 'List documents',
    description: 'Most recent library documents (metadata only). Filter by domain and/or tags (documents must carry every tag).',
    scope: 'library:read',
    input: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      domain: z.string().optional(),
      tags: TAG_FILTER_INPUT,
      before: z.number().optional().describe('Cursor: created_at of the last item'),
    }),
    annotations: READ,
    run: async (a, t) => {
      const items = await listDocuments(t.env, t.principal.userId, { limit: a.limit ?? 20, domain: a.domain, tags: parseTagFilter(a.tags), before: a.before });
      return { items, next_cursor: items.length === (a.limit ?? 20) ? items[items.length - 1].created_at : null };
    },
  },
  {
    name: 'delete_document',
    title: 'Delete document',
    description: 'Permanently delete a library document and its embeddings.',
    scope: 'library:write',
    input: z.object({ id: z.string() }),
    annotations: DESTRUCTIVE,
    run: async (a, t) => {
      if (!(await deleteDocument(t.env, t.principal.userId, a.id))) throw new ToolError('Document not found');
      return { ok: true };
    },
  },
  // ─── Library tags ─────────────────────────────────────────────────────────
  {
    name: 'tag_document',
    title: 'Tag document',
    description: `Add and/or remove tags on a library document, or replace them all with set. Tags are lowercased and keep only a-z, 0-9, - and _. At most ${MAX_TAGS} tags per document; an add that would exceed it fails. Returns the resulting tags.`,
    scope: 'library:write',
    input: z.object({
      id: z.string().min(1).describe('Document id'),
      add: TAG_LIST_INPUT.describe('Tags to add'),
      remove: TAG_LIST_INPUT.describe('Tags to remove'),
      set: TAG_LIST_INPUT.describe('Replace all tags with these (cannot be combined with add/remove; [] clears)'),
    }),
    annotations: IDEMPOTENT_WRITE,
    run: async (a, t) => {
      if (a.set && (a.add || a.remove)) throw new ToolError('Use either set, or add and/or remove, not both.');
      if (!a.set && !a.add && !a.remove) throw new ToolError('Pass add, remove or set.');
      const tags = await editTags(t.env, t.principal.userId, a.id, { add: a.add, remove: a.remove, set: a.set });
      if (!tags) throw new ToolError('Document not found');
      return { id: a.id, tags };
    },
  },
  {
    name: 'list_tags',
    title: 'List tags',
    description: 'Tags used in this library with the number of documents carrying each, most used first. Use with list_documents tags filter.',
    scope: 'library:read',
    input: z.object({ limit: z.number().int().min(1).max(500).optional().describe('Max tags (default 100)') }),
    annotations: READ,
    run: async (a, t) => ({ items: await listTags(t.env, t.principal.userId, a.limit ?? 100) }),
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
    annotations: WRITE,
    run: async (a, t) => pageView(await createPage(t.env, t.principal, a), t.origin),
  },
  {
    name: 'apply_page_ops',
    title: 'Apply page ops',
    description:
      'Apply a batch of edits to a page draft atomically. baseRevision must equal the page revision (else revision_conflict: re-read with get_page and retry). Ops: insert {block:{type,props,size}, index?, parentId?, slot?}, update {id, props?, size?}, replace_props {id, props}, move {id, index, parentId?, slot?}, remove {id}, duplicate {id}, set_seo {seo}, set_layout {layout}, set_meta {title?, description?, slug?}.',
    scope: 'pages:write',
    input: z.object({ pageId: z.string(), baseRevision: z.number().int().min(1), ops: z.array(OpSchema).min(1).max(100), idempotencyKey: z.string().min(8).max(100).optional(), note: z.string().max(200).optional() }),
    annotations: WRITE,
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
    annotations: IDEMPOTENT_WRITE,
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
    annotations: IDEMPOTENT_WRITE,
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
    annotations: WRITE,
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
    annotations: IDEMPOTENT_WRITE,
    run: async (a, t) => {
      if (!(await getPostRow(t.env, a.id))) throw new ToolError('Post not found');
      const row = await setPostPublished(t.env, t.principal, a.id, a.publish);
      return { ...row, url: `${t.origin}/blog/${row!.slug}` };
    },
  },
];

// ─── Admin control plane, account and CMS parity tools ──────────────────────
// Defined in their own modules; appended after the core tools so existing tool order is unchanged.

const ALL_TOOLS: ToolDef[] = [...TOOLS, ...CMS_PARITY_TOOLS, ...ACCOUNT_TOOLS, ...ADMIN_TOOLS];
const TOOL_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));
const inputSchemas = new Map(ALL_TOOLS.map((t) => [t.name, z.toJSONSchema(t.input, { io: 'input' })]));

function visibleTools(p: Principal) {
  return ALL_TOOLS.filter((t) => p.scopes.includes(t.scope));
}

function toolListing(p: Principal) {
  return visibleTools(p).map((x) => ({ name: x.name, title: x.title, description: x.description, inputSchema: inputSchemas.get(x.name), annotations: { title: x.title, ...x.annotations } }));
}

/** A tool the caller cannot use because of scope. `stepUp` when an OAuth client could request it. */
interface ScopeDenial {
  tool: ToolDef;
  stepUp: boolean;
  roleAllows: boolean;
}

function scopeDenial(name: string, p: Principal): ScopeDenial | null {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool || p.scopes.includes(tool.scope)) return null;
  const roleAllows = scopesForRole(p.role).includes(tool.scope);
  return { tool, roleAllows, stepUp: roleAllows && p.kind === 'oauth' };
}

function denialToolResult(d: ScopeDenial, p: Principal) {
  const code = d.roleAllows ? 'insufficient_scope' : 'forbidden';
  const message = !d.roleAllows
    ? `Your role (${p.role}) does not allow ${d.tool.name} (needs ${d.tool.scope}).`
    : p.kind === 'api_key'
      ? `This API key lacks the ${d.tool.scope} scope needed for ${d.tool.name}. Create a key that includes it (see list_roles for presets).`
      : `This connection lacks the ${d.tool.scope} scope needed for ${d.tool.name}. Reconnect and approve it.`;
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }], structuredContent: { error: { code, message, required: [d.tool.scope], tool: d.tool.name } } };
}

function errorToolResult(code: string | undefined, message: string, details?: unknown, status?: number) {
  const text = `${code ? `${code}: ` : ''}${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ''}`;
  return { isError: true, content: [{ type: 'text', text }], structuredContent: { error: { code: code ?? 'error', message, ...(status ? { status } : {}), ...(details !== undefined ? { details } : {}) } } };
}

async function callTool(params: Record<string, unknown> | undefined, t: ToolContext) {
  const name = String(params?.name ?? '');
  const denied = scopeDenial(name, t.principal);
  if (denied) return denialToolResult(denied, t.principal);
  const tool = visibleTools(t.principal).find((x) => x.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  const parsed = tool.input.safeParse(params?.arguments ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${issues}` }] };
  }
  // Audit rows name the tool that acted.
  const principal = { ...t.principal, via: `mcp:${tool.name}` };
  try {
    const out = await tool.run(parsed.data, { ...t, principal });
    const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    // read_url / convert_url: lead with the Markdown so the model reads the page, not escaped JSON.
    if (READ_URL_TOOLS.has(tool.name) && out && typeof out === 'object' && 'markdown' in out) {
      const { markdown, ...meta } = out as { markdown: string };
      return { content: [{ type: 'text', text: markdown }, { type: 'text', text: JSON.stringify(meta, null, 2) }], structuredContent: out };
    }
    return { content: [{ type: 'text', text }], ...(out && typeof out === 'object' && !Array.isArray(out) ? { structuredContent: out } : {}) };
  } catch (err) {
    if (err instanceof AdminError) return errorToolResult(err.code, err.message, err.details, err.status);
    const e = err as { code?: string; message?: string; details?: unknown; status?: number };
    const known = err instanceof ToolError || err instanceof PageError || err instanceof ConvertError || e.status;
    if (!known) {
      console.error('mcp tool error', name, err);
      return errorToolResult('internal', 'Internal error while running the tool.');
    }
    return errorToolResult(e.code, e.message ?? 'Tool failed', e.details, e.status);
  }
}

type Era = 'modern' | 'legacy';

/** A JSON-RPC message must be an object; `null`, arrays and scalars are invalid requests. */
function isMessageObject(msg: unknown): msg is JsonRpcMessage {
  return typeof msg === 'object' && msg !== null && !Array.isArray(msg);
}

async function handleMessage(msg: JsonRpcMessage, t: ToolContext, era: Era): Promise<object | null> {
  if (!isMessageObject(msg)) return rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: a JSON-RPC message must be an object');
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isNotification ? null : rpcError(id, RPC.INVALID_REQUEST, 'Invalid Request');
  if (isNotification) return null;
  const ok = (result: Record<string, unknown>) => ({ jsonrpc: '2.0', id, result: era === 'modern' ? { resultType: 'complete', ...result } : result });
  const listCache = era === 'modern' ? { ttlMs: LIST_TTL_MS, cacheScope: 'private' } : {};
  switch (msg.method) {
    case 'server/discover':
      return ok({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
        ttlMs: LIST_TTL_MS,
        cacheScope: 'private',
        _meta: { [META_SERVER_INFO]: SERVER_INFO },
      });
    case 'tools/list':
      return ok({ tools: toolListing(t.principal), ...listCache });
    case 'tools/call':
      return ok(await callTool(msg.params, t));
  }
  if (era === 'legacy') {
    switch (msg.method) {
      case 'initialize': {
        const requested = String(msg.params?.protocolVersion ?? '');
        return ok({
          protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok({});
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
    }
  }
  return rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate, Retry-After',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, ...headers } });
}

/** A batch is answered with an array (one error per request in it), a single message with one error. */
function rateLimitedResponse(messages: JsonRpcMessage[], batch: boolean, limited: RateLimited): Response {
  const message = limited.bucket === 'mutation' ? 'Too many changes. Slow down and retry later.' : 'Too many requests. Slow down and retry later.';
  const error = (id: JsonRpcId) => rpcError(id, RPC.RATE_LIMITED, message, { code: 'rate_limited', bucket: limited.bucket, retryAfter: limited.retryAfter });
  const ids = messages.filter((m) => isMessageObject(m) && m.id !== undefined).map((m) => m.id ?? null);
  const body = batch ? (ids.length ? ids : [null]).map(error) : error(isMessageObject(messages[0]) ? (messages[0].id ?? null) : null);
  return json(body, 429, { 'Retry-After': String(limited.retryAfter) });
}

/**
 * OAuth step-up (RFC 6750 insufficient_scope): the client can re-authorize with the listed scope
 * set, which keeps what it has and adds what the tool needs.
 */
function stepUpResponse(env: Env, id: JsonRpcId, d: ScopeDenial, p: Principal): Response {
  const scope = [...new Set([...p.scopes, d.tool.scope])].join(' ');
  const message = `${d.tool.name} needs the ${d.tool.scope} scope. Re-authorize to grant it.`;
  return json(rpcError(id, RPC.INSUFFICIENT_SCOPE, message, { code: 'insufficient_scope', required: [d.tool.scope], scope, tool: d.tool.name }), 403, {
    'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadataUrl(env)}", error_description="${message}"`,
  });
}

/** Legacy batches are bounded so one HTTP request cannot fan out into an unbounded number of calls. */
const MAX_BATCH = 20;

/**
 * JSON-RPC batching exists in 2025-03-26 and earlier; 2025-06-18 dropped it. A client that names a
 * later version in its header gets a batch rejected; older clients (which send no version header,
 * or name one of these) keep batching.
 */
const BATCH_VERSIONS = new Set(['2025-03-26', '2024-11-05']);

function batchAllowed(versionHeader: string | null): boolean {
  return !versionHeader || BATCH_VERSIONS.has(versionHeader.trim());
}

function callsMutation(m: JsonRpcMessage, p: Principal): boolean {
  if (!isMessageObject(m) || m.method !== 'tools/call') return false;
  const tool = TOOL_BY_NAME.get(String(m.params?.name ?? ''));
  return Boolean(tool && p.scopes.includes(tool.scope) && isMutation(tool));
}

/**
 * Every valid message counts against the request bucket, and every mutating call against the
 * credential's and the account's mutation buckets, batched or not. Invalid messages are answered
 * with -32600 without spending the budget.
 */
async function rateLimit(env: Env, p: Principal, messages: JsonRpcMessage[]): Promise<RateLimited | null> {
  for (const m of messages) {
    if (!isMessageObject(m)) continue;
    const limited =
      (await checkMcpRate(env, p, 'request')) ??
      (callsMutation(m, p) ? ((await checkMcpRate(env, p, 'mutation')) ?? (await checkMcpRate(env, p, 'mutation', 'user'))) : null);
    if (limited) return limited;
  }
  return null;
}

export async function handleMcp(request: Request, env: Env, ctx: WaitUntil, principal: Principal): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json(rpcError(null, RPC.SERVER_ERROR, 'This server is stateless: POST JSON-RPC messages; no SSE stream.'), 405, { Allow: 'POST, OPTIONS' });
  if (!principal.userId) return json(rpcError(null, RPC.UNAUTHORIZED, 'Unauthorized', { code: 'unauthorized' }), 401);
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, RPC.PARSE_ERROR, 'Parse error'), 400);
  }
  const era: Era = isModernRequest(request.headers.get('mcp-protocol-version'), payload) ? 'modern' : 'legacy';
  if (era === 'modern') {
    if (Array.isArray(payload) || !payload || typeof payload !== 'object') return json(rpcError(null, RPC.INVALID_REQUEST, 'Send one JSON-RPC message per request; batching is not supported.'), 400);
    const failure = validateModern(request.headers, payload as JsonRpcMessage);
    if (failure) return json(rpcError((payload as JsonRpcMessage).id ?? null, failure.code, failure.message, failure.data), failure.status);
  }
  const batch = Array.isArray(payload);
  if (!batch && !isMessageObject(payload)) return json(rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: a JSON-RPC message must be an object'), 400);
  const messages = (batch ? payload : [payload]) as JsonRpcMessage[];
  if (batch && !batchAllowed(request.headers.get('mcp-protocol-version'))) {
    return json(rpcError(null, RPC.INVALID_REQUEST, 'JSON-RPC batching was removed in protocol version 2025-06-18. Send one message per request.'), 400);
  }
  if (batch && (messages.length === 0 || messages.length > MAX_BATCH)) return json(rpcError(null, RPC.INVALID_REQUEST, `A batch must hold between 1 and ${MAX_BATCH} messages.`), 400);

  const limited = await rateLimit(env, principal, messages);
  if (limited) return rateLimitedResponse(messages, batch, limited);

  // A single call to a tool the OAuth grant lacks (but the role allows) asks the client to step up.
  if (!batch) {
    const msg = messages[0];
    const denied = msg?.method === 'tools/call' ? scopeDenial(String(msg.params?.name ?? ''), principal) : null;
    if (denied?.stepUp) return stepUpResponse(env, msg.id ?? null, denied, principal);
  }

  const requestId = principal.requestId ?? crypto.randomUUID();
  const t: ToolContext = { env, ctx, principal: { ...principal, userId: principal.userId, requestId }, origin: env.PUBLIC_URL };
  const responses = (await Promise.all(messages.map((m) => handleMessage(m, t, era)))).filter(Boolean);
  if (!responses.length) return new Response(null, { status: 202, headers: CORS });
  const status = era === 'modern' && (responses[0] as { error?: { code: number } }).error?.code === RPC.METHOD_NOT_FOUND ? 404 : 200;
  return json(batch ? responses : responses[0], status);
}

/** Tool names, for docs and the OpenAPI description. */
export const MCP_TOOL_NAMES = ALL_TOOLS.map((t) => t.name);

/** Every tool with the scope it needs and its annotations, for docs and authorization tests. */
export const MCP_TOOL_CATALOG = ALL_TOOLS.map((t) => ({ name: t.name, scope: t.scope, annotations: t.annotations ?? {} }));
