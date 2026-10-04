/** Same-origin JSON API client. Errors follow `{ error: { code, message } }` and surface as ApiFailure. */

export class ApiFailure extends Error {
  /** Set when the failing call ran without a signed-in session. */
  anonymous = false;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

async function send(path: string, opts: RequestOptions, accept: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept, ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(path, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiFailure(0, 'network', 'Network error. Check your connection and try again.');
  }
}

async function failure(res: Response): Promise<ApiFailure> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
  const err = body?.error;
  const code = typeof err?.code === 'string' ? err.code : `http_${res.status}`;
  const message = typeof err?.message === 'string' && err.message ? err.message : `Request failed (${res.status}).`;
  return new ApiFailure(res.status, code, message);
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<{ data: T; res: Response }> {
  const res = await send(path, opts, 'application/json');
  if (!res.ok) throw await failure(res);
  const data = (await res.json().catch(() => {
    throw new ApiFailure(res.status, 'bad_response', 'The server sent an unexpected response.');
  })) as T;
  return { data, res };
}

/** Fetch a text resource (e.g. a page's Markdown twin). */
export async function requestText(path: string, accept = 'text/markdown, text/plain;q=0.9'): Promise<string> {
  const res = await send(path, {}, accept);
  if (!res.ok) throw new ApiFailure(res.status, `http_${res.status}`, `Could not load the Markdown (${res.status}).`);
  return res.text();
}

/** Shape of POST /api/v1/convert (and the URL API with `Accept: application/json`). */
export interface ConvertPayload {
  url: string;
  title: string;
  domain: string;
  kind: string;
  word_count: number;
  markdown: string;
  /** Markdown body without frontmatter. */
  content: string;
  document_id: string | null;
  credits: number;
  credit_breakdown?: { base: number; thread: number; comments: number; images: number };
  cached: boolean;
  duration_ms: number;
  /** Size of the fetched HTML, when the server reports it. */
  source_bytes?: number | null;
  [key: string]: unknown;
}

function asPayload(raw: unknown): ConvertPayload {
  const p = raw as Partial<ConvertPayload> | null;
  if (!p || typeof p !== 'object' || typeof p.markdown !== 'string') throw new ApiFailure(500, 'bad_response', 'The server sent an unexpected response.');
  return {
    ...p,
    url: String(p.url ?? ''),
    title: String(p.title ?? ''),
    domain: String(p.domain ?? ''),
    kind: String(p.kind ?? 'web'),
    word_count: Number(p.word_count) || 0,
    markdown: p.markdown,
    content: typeof p.content === 'string' ? p.content : p.markdown,
    document_id: typeof p.document_id === 'string' ? p.document_id : null,
    credits: Number(p.credits) || 0,
    cached: p.cached === true,
    duration_ms: Number(p.duration_ms) || 0,
  };
}

/**
 * Convert a URL. Signed-in callers use POST /api/v1/convert (saved to the library); the REST
 * scope guard rejects anonymous callers, so they fall back to the public URL API.
 */
export interface ConversionOptions {
  includeComments?: boolean;
  analyzeImages?: boolean;
  maxComments?: number;
  maxImages?: number;
  maxCredits?: number;
}

function fallbackQuery(save: boolean | undefined, options: ConversionOptions): string {
  const params = new URLSearchParams();
  for (const key of ['includeComments', 'analyzeImages'] as const) {
    if (options[key] !== undefined) params.set(key, options[key] ? '1' : '0');
  }
  for (const key of ['maxComments', 'maxImages', 'maxCredits'] as const) {
    if (options[key] !== undefined) params.set(key, String(options[key]));
  }
  if (save !== undefined) params.set('save', save ? '1' : '0');
  return params.toString();
}

export async function convertUrl(url: string, save?: boolean, options: ConversionOptions = {}): Promise<{ data: ConvertPayload; headers: Headers }> {
  try {
    const { data, res } = await request<unknown>('/api/v1/convert', { method: 'POST', body: { url, format: 'json', ...options, ...(save === undefined ? {} : { save }) } });
    return { data: asPayload(data), headers: res.headers };
  } catch (err) {
    if (!(err instanceof ApiFailure && err.status === 401)) throw err;
    if (options.includeComments || options.analyzeImages) throw err;
  }
  try {
    const target = url.replace(/#.*$/, '').replace(/^\/+/, '');
    const query = fallbackQuery(save, options);
    const separator = target.indexOf('?');
    const targetPath = separator < 0 ? target : target.slice(0, separator);
    const targetQuery = separator < 0 ? '' : target.slice(separator + 1);
    const combinedQuery = [query, targetQuery].filter(Boolean).join('&');
    const { data, res } = await request<unknown>(`/${targetPath}${combinedQuery ? `?${combinedQuery}` : ''}`);
    return { data: asPayload(data), headers: res.headers };
  } catch (err) {
    if (err instanceof ApiFailure) err.anonymous = true;
    throw err;
  }
}
