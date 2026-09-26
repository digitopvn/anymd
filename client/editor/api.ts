/** Typed client for the admin page-builder API (same-origin, session cookie). */

export type BlockSize = 'small' | 'medium' | 'large';
export type Layout = 'default' | 'landing' | 'article';

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
  layout: Layout;
  seo: PageSeo;
  blocks: BlockNode[];
}

export interface PageView {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  revision: number;
  publishedRevision: number | null;
  url: string;
  markdownUrl: string;
  previewUrl: string;
  draft: PageDocument | null;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  description?: string;
}

export interface CatalogItem {
  type: string;
  label: string;
  description: string;
  category?: string;
  sizes: BlockSize[];
  defaultSize: BlockSize;
  slots?: string[];
  propsSchema: JsonSchema;
  example: Record<string, unknown>;
}

type Target = { parentId?: string; slot?: string };
export type PageOp =
  | ({ op: 'insert'; block: { type: string; props: Record<string, unknown>; size?: BlockSize }; index?: number } & Target)
  | { op: 'update'; id: string; props?: Record<string, unknown>; size?: BlockSize }
  | { op: 'replace_props'; id: string; props: Record<string, unknown> }
  | ({ op: 'move'; id: string; index: number } & Target)
  | { op: 'remove'; id: string }
  | { op: 'duplicate'; id: string }
  | { op: 'set_seo'; seo: PageSeo }
  | { op: 'set_layout'; layout: Layout }
  | { op: 'set_meta'; title?: string; description?: string; slug?: string };

export interface OpsResult {
  pageId: string;
  revision: number;
  createdBlockIds: string[];
  slug: string;
  replayed: boolean;
  page: PageView | null;
}

export interface Issue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
  }

  /** Field issues from `invalid_props` responses. */
  get issues(): Issue[] {
    return Array.isArray(this.details)
      ? this.details.filter((d): d is Issue => !!d && typeof (d as Issue).path === 'string' && typeof (d as Issue).message === 'string')
      : [];
  }
}

const BASE = '/api/v1/admin';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Network error. Check your connection and try again.', 0, 'network');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = isObj(data) && isObj(data.error) ? data.error : null;
    const message = err && typeof err.message === 'string' ? err.message : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, err && typeof err.code === 'string' ? err.code : 'http_error', err?.details);
  }
  if (data === null) throw new ApiError('Unexpected response from server', res.status, 'bad_response');
  return data;
}

function asPage(v: unknown): PageView {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.revision !== 'number' || typeof v.slug !== 'string' || typeof v.previewUrl !== 'string') {
    throw new ApiError('Malformed page payload', 200, 'bad_response');
  }
  const draft = isObj(v.draft) && Array.isArray(v.draft.blocks) ? (v.draft as unknown as PageDocument) : null;
  if (draft && !isObj(draft.seo)) draft.seo = {};
  return { ...(v as unknown as PageView), draft };
}

export async function getPage(id: string): Promise<PageView> {
  const data = await request('GET', `/pages/${encodeURIComponent(id)}`);
  return asPage(isObj(data) ? data.page : null);
}

export async function getCatalog(): Promise<CatalogItem[]> {
  const data = await request('GET', '/blocks');
  if (!isObj(data) || !Array.isArray(data.items)) throw new ApiError('Malformed block catalog', 200, 'bad_response');
  return data.items.filter((i): i is CatalogItem => isObj(i) && typeof i.type === 'string' && Array.isArray(i.sizes) && isObj(i.propsSchema));
}

export function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Applies an op batch. Retries once on network failure with the same idempotency key. */
export async function postOps(pageId: string, baseRevision: number, ops: PageOp[], idempotencyKey = newKey()): Promise<OpsResult> {
  const payload = { baseRevision, ops, idempotencyKey };
  const path = `/pages/${encodeURIComponent(pageId)}/ops`;
  let data: unknown;
  try {
    data = await request('POST', path, payload);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'network') throw e;
    await new Promise((r) => setTimeout(r, 800));
    data = await request('POST', path, payload);
  }
  if (!isObj(data) || typeof data.revision !== 'number') throw new ApiError('Malformed ops response', 200, 'bad_response');
  return {
    pageId: String(data.pageId),
    revision: data.revision,
    createdBlockIds: Array.isArray(data.createdBlockIds) ? data.createdBlockIds.map(String) : [],
    slug: String(data.slug),
    replayed: data.replayed === true,
    page: data.page ? asPage(data.page) : null,
  };
}

export async function publish(pageId: string, revision?: number): Promise<void> {
  await request('POST', `/pages/${encodeURIComponent(pageId)}/publish`, revision ? { revision } : {});
}

export async function unpublish(pageId: string): Promise<void> {
  await request('POST', `/pages/${encodeURIComponent(pageId)}/unpublish`, {});
}
