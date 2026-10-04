/**
 * WebMCP: expose site tools to in-browser agents through `navigator.modelContext`.
 * Contract: src/content/docs/webmcp.md. Tools run with the page's own session.
 */
import { convertUrl, request, requestText } from './api';

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown): Promise<ToolResult>;
}

interface ModelContext {
  provideContext?(context: { tools: Tool[] }): unknown;
  registerTool?(tool: Tool): unknown;
}

type Input = Record<string, unknown>;

const SEARCH_MODES = ['hybrid', 'bm25', 'fulltext', 'semantic'];

function tool(name: string, description: string, inputSchema: Input, run: (input: Input) => Promise<string>): Tool {
  return {
    name,
    description,
    inputSchema,
    async execute(input) {
      try {
        const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Input) : {};
        return { content: [{ type: 'text', text: await run(args) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : 'Tool failed.' }], isError: true };
      }
    },
  };
}

function requiredString(input: Input, key: string, max: number): string {
  const v = input[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`\`${key}\` is required.`);
  if (v.length > max) throw new Error(`\`${key}\` is too long (max ${max} characters).`);
  return v.trim();
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v ?? fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

const readUrlSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The public URL to read, with or without https://' },
    save: { type: 'boolean', description: 'Save to the library when signed in (default true)' },
    includeComments: { type: 'boolean', description: 'Read raw comments and replies (extra credits)' },
    analyzeImages: { type: 'boolean', description: 'OCR and describe article images (extra credits)' },
    maxComments: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
    maxImages: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
    maxCredits: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
  },
  required: ['url'],
};

async function readUrl(input: Input): Promise<string> {
  const save = typeof input.save === 'boolean' ? input.save : undefined;
  const options: Record<string, unknown> = {};
  for (const key of ['includeComments', 'analyzeImages', 'maxComments', 'maxImages', 'maxCredits']) if (input[key] !== undefined) options[key] = input[key];
  const { data } = await convertUrl(requiredString(input, 'url', 4000), save, options);
  return data.markdown;
}

const readTool = tool(
  'read_url',
  'Read a public URL (web page, GitHub, YouTube, PDF…) with anymd and return it as structured Markdown. Signed-in reads are saved to the library.',
  readUrlSchema,
  readUrl,
);

// The original name, kept so agents built against it keep working.
const convertTool = tool('convert_url', 'Same as read_url, under its original name: convert a URL to clean Markdown with anymd.', readUrlSchema, readUrl);

const pageMarkdownTool = tool('get_page_markdown', 'Return the current anymd.cc page as Markdown (its .md twin).', { type: 'object', properties: {} }, async () => {
  const twin = document.querySelector<HTMLLinkElement>('link[rel="alternate"][type="text/markdown"]')?.href;
  return requestText(twin || location.href);
});

const searchTool = tool(
  'search_library',
  "Search the signed-in user's anymd library. Free: never costs credits.",
  {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for' },
      mode: { type: 'string', enum: SEARCH_MODES, description: 'Search mode (default hybrid)' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10)' },
    },
    required: ['query'],
  },
  async (input) => {
    const params = new URLSearchParams({ q: requiredString(input, 'query', 500), limit: String(clampInt(input.limit, 1, 50, 10)) });
    if (typeof input.mode === 'string' && SEARCH_MODES.includes(input.mode)) params.set('mode', input.mode);
    return json((await request(`/api/v1/search?${params}`)).data);
  },
);

const listTool = tool(
  'list_documents',
  "List the most recent documents in the signed-in user's anymd library.",
  {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max documents (default 20)' },
      domain: { type: 'string', description: 'Only documents from this domain' },
    },
  },
  async (input) => {
    const params = new URLSearchParams({ limit: String(clampInt(input.limit, 1, 100, 20)) });
    if (typeof input.domain === 'string' && input.domain.trim()) params.set('domain', input.domain.trim().slice(0, 253));
    return json((await request(`/api/v1/library?${params}`)).data);
  },
);

async function signedIn(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return res.ok;
  } catch {
    return false;
  }
}

export async function initWebMcp(): Promise<void> {
  const mc = (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
  if (!mc || (typeof mc.registerTool !== 'function' && typeof mc.provideContext !== 'function')) return;
  const tools = [readTool, convertTool, pageMarkdownTool];
  if (await signedIn()) tools.push(searchTool, listTool);
  // registerTool adds to what other scripts (the page editor) register; provideContext replaces it.
  if (typeof mc.registerTool === 'function') {
    for (const t of tools) {
      try {
        await Promise.resolve(mc.registerTool(t));
      } catch (err) {
        console.warn(`[anymd] WebMCP: could not register ${t.name}`, err);
      }
    }
    return;
  }
  try {
    await Promise.resolve(mc.provideContext?.({ tools }));
  } catch (err) {
    console.warn('[anymd] WebMCP: provideContext failed', err);
  }
}
