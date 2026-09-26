/**
 * WebMCP tools added by the page editor (see /docs/webmcp): get_page, list_blocks, apply_page_ops,
 * publish_page. They run with the page's session and go through the same ops API as the UI.
 */
import { ApiError, type PageOp } from './api';

export interface EditorToolHost {
  pageId: string;
  canPublish: boolean;
  getPage(): Promise<unknown>;
  listBlocks(): unknown;
  applyOps(baseRevision: number, ops: PageOp[], idempotencyKey?: string): Promise<unknown>;
  publish(revision?: number): Promise<unknown>;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown): Promise<ToolResult>;
}

interface ModelContext {
  registerTool?(tool: WebMcpTool): unknown;
  provideContext?(ctx: { tools: WebMcpTool[] }): unknown;
}

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (code: string, message: string, details?: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: { code, message, details } }) }], isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof ApiError) return fail(e.code, e.message, e.details);
    return fail('client_error', e instanceof Error ? e.message : String(e));
  }
}

export function registerEditorTools(host: EditorToolHost): void {
  const mc = (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
  if (!mc) return;
  const empty = { type: 'object', properties: {} };
  const tools: WebMcpTool[] = [
    {
      name: 'get_page',
      description: 'Read the page open in this editor: revision, draft block tree, preview URL and publish status.',
      inputSchema: empty,
      execute: () => run(() => host.getPage()),
    },
    {
      name: 'list_blocks',
      description: 'The page-builder block catalog: types, JSON Schemas for props, sizes, slots and examples.',
      inputSchema: empty,
      execute: () => run(async () => ({ items: host.listBlocks() })),
    },
    {
      name: 'apply_page_ops',
      description:
        'Apply a batch of ops to the open page against baseRevision (optimistic concurrency; 409 revision_conflict means re-read with get_page). Ops: insert, update, replace_props, move, remove, duplicate, set_seo, set_layout, set_meta.',
      inputSchema: {
        type: 'object',
        properties: {
          baseRevision: { type: 'integer', minimum: 1 },
          ops: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] } },
          idempotencyKey: { type: 'string', minLength: 8, maxLength: 100 },
          pageId: { type: 'string', description: 'Optional; must match the open page.' },
        },
        required: ['baseRevision', 'ops'],
      },
      execute: (input) => {
        if (!isObj(input)) return Promise.resolve(fail('invalid_request', 'Input must be an object'));
        const { baseRevision, ops, idempotencyKey, pageId } = input;
        if (pageId !== undefined && pageId !== host.pageId) return Promise.resolve(fail('invalid_request', `This editor has page ${host.pageId} open`));
        if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 1) return Promise.resolve(fail('invalid_request', 'baseRevision must be a positive integer'));
        if (!Array.isArray(ops) || !ops.length || ops.length > 100 || !ops.every((o) => isObj(o) && typeof o.op === 'string')) {
          return Promise.resolve(fail('invalid_request', 'ops must be an array of 1–100 op objects'));
        }
        if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') return Promise.resolve(fail('invalid_request', 'idempotencyKey must be a string'));
        return run(() => host.applyOps(baseRevision, ops as PageOp[], idempotencyKey));
      },
    },
  ];
  if (host.canPublish) {
    tools.push({
      name: 'publish_page',
      description: 'Publish the open page’s current draft, or a given earlier revision.',
      inputSchema: { type: 'object', properties: { revision: { type: 'integer', minimum: 1 } } },
      execute: (input) => {
        const revision = isObj(input) ? input.revision : undefined;
        if (revision !== undefined && (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1)) return Promise.resolve(fail('invalid_request', 'revision must be a positive integer'));
        return run(() => host.publish(revision as number | undefined));
      },
    });
  }
  try {
    if (typeof mc.registerTool === 'function') {
      for (const tool of tools) mc.registerTool(tool);
    } else if (typeof mc.provideContext === 'function') {
      // provideContext replaces the whole tool set, and site.js also calls it (after an async sign-in
      // check). Wrap it so later calls keep the editor tools, then publish ours next to any known ones.
      const original = mc.provideContext.bind(mc);
      const names = new Set(tools.map((t) => t.name));
      let others: WebMcpTool[] = [];
      mc.provideContext = (ctx: { tools: WebMcpTool[] }) => {
        others = (Array.isArray(ctx?.tools) ? ctx.tools : []).filter((t) => !names.has(t.name));
        return original({ tools: [...others, ...tools] });
      };
      original({ tools: [...others, ...tools] });
    }
  } catch (e) {
    console.warn('WebMCP registration failed', e);
  }
}
