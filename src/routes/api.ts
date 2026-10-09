/** REST API v1 — see plans/260926-1256-anymd-platform/contracts.md and /api/v1/openapi.json. */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { createApiKey, getUser, type ApiKeyRow } from '../auth/identity';
import { apiError, requireScope, sameOriginWrites, type AppContext } from '../auth/middleware';
import { isRole, KEY_PRESETS, ROLE_TEMPLATES, roleAtLeast } from '../auth/roles';
import { getPlan, PLANS, type PlanId } from '../billing/plans';
import { billingEnabled, createCheckout, customerPortalUrl } from '../billing/provider';
import { blockCatalog } from '../cms/blocks';
import {
  applyPageOps,
  archivePage,
  createPage,
  getPage,
  listPages,
  listRevisions,
  OpsRequestSchema,
  PageError,
  pageToMarkdown,
  pageView,
  parseDoc,
  publishPage,
  rotatePreviewToken,
  TEMPLATES,
  unpublishPage,
} from '../cms/pages';
import { createPost, deletePost, getPostRow, listAllPosts, PostInputSchema, setPostPublished, updatePost } from '../cms/posts';
import { convertBlobToMarkdown, documentCreditCost, mimeFor } from '../convert/document';
import { runConversion } from '../convert/service';
import { enrichmentOptions } from '../convert/enrichment-types';
import { ConvertError, countWords, type ConvertResult } from '../convert/types';
import type { AppBindings, Principal } from '../env';
import { embedDocument, getDocument, listDocuments, saveDocument, deleteDocument, updateTags } from '../library/store';
import { editTags, listTags, MAX_TAG_FILTERS, MAX_TAG_LENGTH, MAX_TAGS, parseStoredTags, TagError } from '../library/store';
import { getSettings, putSettings } from '../lib/settings';
import { Tracer } from '../lib/tracer';
import { canSpend, recordUsage } from '../lib/usage';
import { newId, safeJson } from '../lib/util';
import { convertPayload, searchForPrincipal, usageSummary } from '../services';
import { buildOpenApi } from '../openapi';
import { clientIp, originOf } from './shared';

export const api = new Hono<AppBindings>();

api.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'X-API-Key', 'Idempotency-Key'], allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'], exposeHeaders: ['X-Anymd-Credits', 'X-Anymd-Cache', 'X-Anymd-Trace', 'X-Anymd-Kind', 'Retry-After'], maxAge: 86400 }));
api.use('*', sameOriginWrites);

/** Per-minute rate limit: per user when signed in, per IP otherwise. */
api.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  const p = c.get('principal');
  const { success } = p.userId ? await c.env.RL_AUTH.limit({ key: `u:${p.userId}` }) : await c.env.RL_ANON.limit({ key: `ip:${clientIp(c)}` });
  if (!success) {
    c.header('Retry-After', '60');
    return apiError(c, 429, 'rate_limited', 'Too many requests. Slow down and retry in a minute.');
  }
  await next();
});

api.onError((err, c) => handleApiError(c, err));
api.notFound((c) => apiError(c, 404, 'not_found', `No route for ${c.req.method} ${new URL(c.req.url).pathname}. See /api/v1/openapi.json`));

export function handleApiError(c: AppContext, err: unknown) {
  if (err instanceof PageError) return apiError(c, err.status, err.code, err.message, err.details ? { details: err.details } : {});
  if (err instanceof ConvertError) return apiError(c, err.status, err.code, err.message);
  if (err instanceof z.ZodError) return apiError(c, 422, 'invalid_request', 'Request body failed validation', { details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const e = err as { status?: number; code?: string; message?: string };
  if (typeof e?.status === 'number' && e.status < 500) return apiError(c, e.status, e.code ?? 'invalid_request', e.message ?? 'Bad request');
  console.error('api error', err);
  return apiError(c, 500, 'internal', 'Something went wrong on our side. Try again; if it persists, email hello@digitop.ai.');
}

async function body<T extends z.ZodTypeAny>(c: AppContext, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => {
    throw Object.assign(new Error('Body must be JSON'), { status: 400, code: 'invalid_json' });
  });
  return schema.parse(raw);
}

function me(c: AppContext): Principal & { userId: string } {
  return c.get('principal') as Principal & { userId: string };
}

function channelFor(c: AppContext): 'api' | 'cli' | 'web' {
  const ua = c.req.header('user-agent') ?? '';
  if (/anymd-cli/i.test(ua)) return 'cli';
  return c.get('principal').kind === 'session' ? 'web' : 'api';
}

function convertHeaders(c: AppContext, r: { credits: number; cached: boolean; traceId: string; result: { sourceKind: string } }) {
  c.header('X-Anymd-Credits', String(r.credits));
  c.header('X-Anymd-Cache', r.cached ? 'hit' : 'miss');
  c.header('X-Anymd-Trace', r.traceId);
  c.header('X-Anymd-Kind', r.result.sourceKind);
}

// ─── Meta ───────────────────────────────────────────────────────────────────

api.get('/openapi.json', (c) => c.json(buildOpenApi(originOf(c)), 200, { 'Cache-Control': 'public, max-age=3600' }));

api.get('/me', requireScope(), async (c) => {
  const p = me(c);
  const user = await getUser(c.env, p.userId);
  if (!user) return apiError(c, 401, 'unauthorized', 'Account not found');
  return c.json({ id: user.id, email: user.email, name: user.name, role: user.role, plan: user.plan, scopes: p.scopes, auth: p.kind, created_at: user.created_at });
});

// ─── Convert ────────────────────────────────────────────────────────────────

const ConvertBody = z.object({
  ...enrichmentOptions,
  url: z.string().min(1).max(4000),
  language: z.string().max(20).optional(),
  selector: z.string().max(200).optional(),
  removeImages: z.boolean().optional(),
  frontmatter: z.boolean().optional(),
  save: z.boolean().optional(),
  fresh: z.boolean().optional(),
  format: z.enum(['json', 'markdown']).optional(),
});

api.post('/convert', requireScope('convert'), async (c) => {
  const b = await body(c, ConvertBody);
  const r = await runConversion(c.env, c.executionCtx, {
    includeComments: b.includeComments, analyzeImages: b.analyzeImages,
    maxComments: b.maxComments, maxImages: b.maxImages, maxCredits: b.maxCredits,
    url: b.url,
    channel: channelFor(c),
    principal: c.get('principal'),
    language: b.language,
    selector: b.selector,
    removeImages: b.removeImages,
    frontmatter: b.frontmatter,
    save: b.save,
    fresh: b.fresh,
    clientIp: clientIp(c),
  });
  convertHeaders(c, r);
  if (b.format === 'markdown') return c.body(r.markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  return c.json(convertPayload(r));
});

api.post('/convert/file', requireScope('convert'), async (c) => {
  const p = c.get('principal');
  if (!p.userId) return apiError(c, 401, 'unauthorized', 'File conversion needs an account. Send an API key.');
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return apiError(c, 400, 'missing_file', 'Send multipart/form-data with a `file` field.');
  if (file.size > 20 * 1024 * 1024) return apiError(c, 413, 'file_too_large', 'Files up to 20 MB are supported.');
  const mime = mimeFor(file.type || '', new URL(`file:///${encodeURIComponent(file.name || 'upload')}`));
  if (!mime) return apiError(c, 415, 'unsupported_type', `Unsupported file type: ${file.type || file.name}. Supported: PDF, DOCX, XLSX, XLS, ODS, ODT, CSV, XML, JPG, PNG, WEBP, SVG.`);
  const user = await getUser(c.env, p.userId);
  const tracer = new Tracer(newId('trc_'));
  const { ok, state } = await canSpend(c.env, p.userId, user?.plan ?? 'free', 3);
  if (!ok) return apiError(c, 402, 'quota_exceeded', `Monthly credits used up (${state.used}/${state.included + state.extra}). Upgrade at https://anymd.cc/pricing`);
  try {
    const { markdown, kind } = await convertBlobToMarkdown(file, file.name || 'upload', mime, { env: c.env, tracer });
    const credits = documentCreditCost(kind);
    const title = markdown.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || file.name;
    const result: ConvertResult = { title, author: '', published: '', description: '', domain: 'upload', content: markdown, wordCount: countWords(markdown), source: `upload://${file.name}`, sourceKind: kind };
    let documentId: string | null = null;
    if (form.save !== '0' && p.scopes.includes('library:write')) {
      const saved = await saveDocument(c.env, p.userId, result, markdown, getPlan(user?.plan ?? 'free').libraryLimit);
      documentId = saved?.id ?? null;
      if (saved?.changed) c.executionCtx.waitUntil(embedDocument(c.env, p.userId, saved.id).catch(() => 0));
    }
    c.executionCtx.waitUntil(
      recordUsage(c.env, { principal: p, channel: channelFor(c), kind: 'convert', target: result.source, status: 'ok', httpStatus: 200, credits, durationMs: tracer.elapsed(), bytesOut: markdown.length, traceId: tracer.id }, tracer).catch(() => undefined),
    );
    c.header('X-Anymd-Credits', String(credits));
    c.header('X-Anymd-Trace', tracer.id);
    c.header('X-Anymd-Kind', kind);
    return c.json({ name: file.name, bytes: file.size, kind, title, word_count: result.wordCount, markdown, document_id: documentId, credits, trace_id: tracer.id, duration_ms: tracer.elapsed() });
  } catch (err) {
    const e = err instanceof ConvertError ? err : new ConvertError('Could not convert this file', 422, 'document_failed');
    c.executionCtx.waitUntil(
      recordUsage(c.env, { principal: p, channel: channelFor(c), kind: 'convert', target: `upload://${file.name}`, status: 'error', httpStatus: e.status, credits: 0, durationMs: tracer.elapsed(), traceId: tracer.id, error: `${e.code}: ${e.message}` }, tracer).catch(() => undefined),
    );
    throw e;
  }
});

// ─── Library & search ───────────────────────────────────────────────────────

api.get('/library', requireScope('library:read'), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);
  const tags = tagFilter(c.req.queries('tag'));
  const items = await listDocuments(c.env, me(c).userId, { limit, before: Number(c.req.query('before')) || undefined, domain: c.req.query('domain') || undefined, kind: c.req.query('kind') || undefined, tags });
  return c.json({ items, next_cursor: items.length === limit ? items[items.length - 1].created_at : null });
});

/** `?tag=a&tag=b` or `?tag=a,b`: documents carrying every tag. */
function tagFilter(values: string[] | undefined): string[] | undefined {
  const tags = (values ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  if (!tags.length) return undefined;
  if (tags.length > MAX_TAG_FILTERS) throw new TagError('invalid_request', `Filter by at most ${MAX_TAG_FILTERS} tags.`);
  if (tags.some((t) => t.length > MAX_TAG_LENGTH)) throw new TagError('invalid_request', `Tags can be at most ${MAX_TAG_LENGTH} characters.`);
  return tags;
}

// Registered before /library/:id so "tags" is not taken for a document id.
api.get('/library/tags', requireScope('library:read'), async (c) => {
  return c.json({ items: await listTags(c.env, me(c).userId, Number(c.req.query('limit')) || 100) });
});

const TagList = z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS);
api.post('/library/:id/tags', requireScope('library:write'), async (c) => {
  const b = await body(c, z.object({ add: TagList.optional(), remove: TagList.optional(), set: TagList.optional() }).strict());
  if (b.set && (b.add || b.remove)) return apiError(c, 422, 'invalid_request', 'Use either `set`, or `add` and/or `remove`, not both.');
  if (!b.set && !b.add && !b.remove) return apiError(c, 422, 'invalid_request', 'Pass `add`, `remove` or `set`.');
  const tags = await editTags(c.env, me(c).userId, c.req.param('id'), b);
  if (!tags) return apiError(c, 404, 'not_found', 'Document not found');
  return c.json({ id: c.req.param('id'), tags });
});

api.get('/library/:id', requireScope('library:read'), async (c) => {
  const doc = await getDocument(c.env, me(c).userId, c.req.param('id'));
  if (!doc) return apiError(c, 404, 'not_found', 'Document not found');
  if (c.req.query('format') === 'md') {
    const md = `---\ntitle: ${JSON.stringify(doc.title)}\nsource: ${JSON.stringify(doc.url)}\n---\n\n${doc.markdown}`;
    return c.body(md, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  }
  return c.json({ ...doc, tags: parseStoredTags(doc.tags) });
});

api.patch('/library/:id', requireScope('library:write'), async (c) => {
  const b = await body(c, z.object({ tags: z.array(z.string().max(40)).max(20) }));
  const ok = await updateTags(c.env, me(c).userId, c.req.param('id'), b.tags);
  if (!ok) return apiError(c, 404, 'not_found', 'Document not found');
  return c.json({ ok: true });
});

api.delete('/library/:id', requireScope('library:write'), async (c) => {
  const ok = await deleteDocument(c.env, me(c).userId, c.req.param('id'));
  if (!ok) return apiError(c, 404, 'not_found', 'Document not found');
  return c.json({ ok: true });
});

const flag = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

async function search(c: AppContext, params: Record<string, unknown>) {
  const q = String(params.q ?? params.query ?? '').trim();
  if (!q) return apiError(c, 400, 'missing_query', 'Pass a query in `q`.');
  const res = await searchForPrincipal(c.env, c.get('principal'), channelFor(c), q, { mode: params.mode, limit: params.limit, fanout: flag(params.fanout), decide: flag(params.decide) });
  return c.json(res);
}

api.get('/search', requireScope('library:read'), (c) => search(c, c.req.query()));
api.post('/search', requireScope('library:read'), async (c) => {
  const type = c.req.header('content-type') ?? '';
  const params = type.includes('application/json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody();
  return search(c, params as Record<string, unknown>);
});

// ─── Usage & traces ─────────────────────────────────────────────────────────

api.get('/usage', requireScope('usage:read'), async (c) => {
  const user = await getUser(c.env, me(c).userId);
  return c.json(await usageSummary(c.env, me(c).userId, user?.plan ?? 'free', Number(c.req.query('days')) || 30));
});

api.get('/traces', requireScope('usage:read'), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const { results } = await c.env.DB.prepare('SELECT id,kind,target,status,duration_ms,meta,created_at FROM traces WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').bind(me(c).userId, limit).all<{ meta: string }>();
  return c.json({ items: results.map((r) => ({ ...r, meta: safeJson(r.meta, {}) })) });
});

api.get('/traces/:id', requireScope('usage:read'), async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM traces WHERE id = ? AND user_id = ?').bind(c.req.param('id'), me(c).userId).first<{ spans: string; meta: string }>();
  if (!row) return apiError(c, 404, 'not_found', 'Trace not found');
  return c.json({ ...row, spans: safeJson(row.spans, []), meta: safeJson(row.meta, {}) });
});

// ─── API keys ───────────────────────────────────────────────────────────────

function keyView(k: ApiKeyRow) {
  return { id: k.id, name: k.name, prefix: k.prefix, scopes: safeJson<string[]>(k.scopes, []), created_at: k.created_at, last_used_at: k.last_used_at, expires_at: k.expires_at, revoked_at: k.revoked_at };
}

export async function activeKeyCount(env: AppContext['env'], userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').bind(userId, Date.now()).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Free accounts get 2 active keys; paid plans and staff are unlimited. */
export function keyLimit(plan: string, role: string): number {
  return plan === 'free' && !['owner', 'admin'].includes(role) ? 2 : Infinity;
}

export function scopesForPreset(preset: string | undefined, explicit: string[] | undefined): string[] | null {
  if (explicit?.length) return explicit;
  const p = KEY_PRESETS.find((k) => k.id === preset);
  return p ? p.scopes : null;
}

api.get('/keys', requireScope('keys:manage'), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').bind(me(c).userId).all<ApiKeyRow>();
  return c.json({ items: results.map(keyView), presets: KEY_PRESETS });
});

api.post('/keys', requireScope('keys:manage'), async (c) => {
  const b = await body(c, z.object({ name: z.string().min(1).max(80), preset: z.string().optional(), scopes: z.array(z.string()).optional(), expires_in_days: z.number().int().min(1).max(3650).optional() }));
  const user = await getUser(c.env, me(c).userId);
  if (!user) return apiError(c, 401, 'unauthorized', 'Account not found');
  if ((await activeKeyCount(c.env, user.id)) >= keyLimit(user.plan, user.role)) return apiError(c, 403, 'key_limit', 'Free accounts can have 2 active API keys. Revoke one or upgrade.');
  const requested = scopesForPreset(b.preset, b.scopes) ?? me(c).scopes;
  // A key can never exceed the scopes of the credential that created it.
  const scopes = requested.filter((s) => me(c).scopes.includes(s as never));
  const { key, row } = await createApiKey(c.env, user, { name: b.name, scopes, expiresInDays: b.expires_in_days });
  return c.json({ key, ...keyView(row) }, 201);
});

api.delete('/keys/:id', requireScope('keys:manage'), async (c) => {
  const res = await c.env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(Date.now(), c.req.param('id'), me(c).userId).run();
  if (!res.meta.changes) return apiError(c, 404, 'not_found', 'Key not found or already revoked');
  return c.json({ ok: true });
});

// ─── Billing (browser session only: checkout URLs are for humans) ──────────

api.post('/billing/checkout', requireScope(), async (c) => {
  if (c.get('principal').kind !== 'session') return apiError(c, 403, 'session_required', 'Checkout must be started from a signed-in browser session.');
  if (!billingEnabled(c.env)) return apiError(c, 503, 'billing_unavailable', 'Billing is not configured on this environment yet.');
  const b = await body(c, z.object({ plan: z.enum(['pro', 'scale']), interval: z.enum(['month', 'year']).default('month') }));
  const user = c.get('user')!;
  return c.json({ url: await createCheckout(c.env, user, b.plan as PlanId, b.interval) });
});

api.post('/billing/portal', requireScope(), async (c) => {
  if (c.get('principal').kind !== 'session') return apiError(c, 403, 'session_required', 'The billing portal must be opened from a signed-in browser session.');
  if (!billingEnabled(c.env)) return apiError(c, 503, 'billing_unavailable', 'Billing is not configured on this environment yet.');
  const url = await customerPortalUrl(c.env, me(c).userId).catch(() => null);
  if (!url) return apiError(c, 400, 'no_billing_account', 'No billing account yet. Subscribe to a plan first.');
  return c.json({ url });
});

// ─── Admin: page builder ────────────────────────────────────────────────────

const admin = new Hono<AppBindings>();

admin.get('/blocks', requireScope('pages:read'), (c) => c.json({ items: blockCatalog() }));
admin.get('/templates', requireScope('pages:read'), (c) =>
  c.json({ items: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, description: t.description, layout: t.layout, blocks: t.blocks.map((b) => b.type) })) }),
);

admin.get('/pages', requireScope('pages:read'), async (c) => {
  const origin = originOf(c);
  const rows = await listPages(c.env);
  return c.json({ items: rows.map((r) => ({ ...pageView(r, origin), draft: undefined })) });
});

admin.post('/pages', requireScope('pages:write'), async (c) => {
  const b = await body(c, z.object({ slug: z.string().min(1).max(80), title: z.string().min(1).max(140), description: z.string().max(300).optional(), template: z.string().optional(), layout: z.enum(['default', 'landing', 'article']).optional() }));
  if (b.template && !TEMPLATES[b.template]) return apiError(c, 422, 'unknown_template', `Unknown template. Use one of: ${Object.keys(TEMPLATES).join(', ')}`);
  const row = await createPage(c.env, c.get('principal'), b);
  return c.json({ page: pageView(row, originOf(c)) }, 201);
});

async function pageOr404(c: AppContext) {
  const row = await getPage(c.env, c.req.param('id')!);
  if (!row || row.status === 'archived') throw new PageError('Page not found', 404, 'not_found');
  return row;
}

admin.get('/pages/:id', requireScope('pages:read'), async (c) => c.json({ page: pageView(await pageOr404(c), originOf(c)) }));

admin.post('/pages/:id/ops', requireScope('pages:write'), async (c) => {
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return apiError(c, 400, 'invalid_json', 'Body must be JSON');
  const idem = c.req.header('idempotency-key');
  const req = OpsRequestSchema.parse({ ...raw, idempotencyKey: raw.idempotencyKey ?? idem ?? undefined });
  const page = await pageOr404(c);
  const out = await applyPageOps(c.env, c.get('principal'), page.id, req);
  const fresh = await getPage(c.env, page.id);
  return c.json({ ...out, page: fresh ? pageView(fresh, originOf(c)) : null });
});

admin.post('/pages/:id/publish', requireScope('pages:publish'), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const page = await pageOr404(c);
  const out = await publishPage(c.env, c.get('principal'), page.id, typeof b?.revision === 'number' ? b.revision : undefined);
  return c.json({ ...out, url: `${originOf(c)}/p/${out.slug}` });
});

admin.post('/pages/:id/unpublish', requireScope('pages:publish'), async (c) => c.json(await unpublishPage(c.env, c.get('principal'), (await pageOr404(c)).id)));
admin.delete('/pages/:id', requireScope('pages:write'), async (c) => c.json(await archivePage(c.env, c.get('principal'), (await pageOr404(c)).id)));
admin.get('/pages/:id/revisions', requireScope('pages:read'), async (c) => c.json({ items: await listRevisions(c.env, (await pageOr404(c)).id) }));

admin.post('/pages/:id/preview-token', requireScope('pages:write'), async (c) => {
  const page = await pageOr404(c);
  const token = await rotatePreviewToken(c.env, page.id);
  return c.json({ previewUrl: `${originOf(c)}/p/${page.slug}?preview=${token}` });
});

admin.get('/pages/:id/markdown', requireScope('pages:read'), async (c) => {
  const page = await pageOr404(c);
  return c.body(pageToMarkdown(page.title, page.description, parseDoc(page.draft)!), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

// ─── Admin: posts ───────────────────────────────────────────────────────────

admin.get('/posts', requireScope('content:read'), async (c) => c.json({ items: await listAllPosts(c.env) }));

admin.post('/posts', requireScope('content:write'), async (c) => {
  const b = await body(c, PostInputSchema);
  return c.json({ post: await createPost(c.env, c.get('principal'), b) }, 201);
});

admin.get('/posts/:id', requireScope('content:read'), async (c) => {
  const row = await getPostRow(c.env, c.req.param('id'));
  if (!row) return apiError(c, 404, 'not_found', 'Post not found');
  return c.json({ post: row });
});

admin.patch('/posts/:id', requireScope('content:write'), async (c) => {
  const b = await body(c, PostInputSchema.partial());
  const row = await updatePost(c.env, c.get('principal'), c.req.param('id'), b);
  if (!row) return apiError(c, 404, 'not_found', 'Post not found');
  return c.json({ post: row });
});

admin.delete('/posts/:id', requireScope('content:write'), async (c) => {
  const ok = await deletePost(c.env, c.get('principal'), c.req.param('id'));
  if (!ok) return apiError(c, 404, 'not_found', 'Post not found');
  return c.json({ ok: true });
});

admin.post('/posts/:id/publish', requireScope('content:publish'), async (c) => {
  const b = await body(c, z.object({ publish: z.boolean().default(true) }));
  const row = await setPostPublished(c.env, c.get('principal'), c.req.param('id'), b.publish);
  if (!row) return apiError(c, 404, 'not_found', 'Post not found');
  return c.json({ post: row, url: `${originOf(c)}/blog/${row.slug}` });
});

// ─── Admin: users, roles, settings ──────────────────────────────────────────

admin.get('/users', requireScope('users:read'), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id,email,name,role,plan,created_at,last_login_at FROM users ORDER BY created_at DESC LIMIT 500').all();
  return c.json({ items: results });
});

admin.patch('/users/:id', requireScope('users:write'), async (c) => {
  const b = await body(c, z.object({ role: z.string().optional(), plan: z.enum(PLANS.map((p) => p.id) as [PlanId, ...PlanId[]]).optional() }));
  const actor = c.get('principal');
  const target = await getUser(c.env, c.req.param('id'));
  if (!target) return apiError(c, 404, 'not_found', 'User not found');
  if (target.id === actor.userId) return apiError(c, 403, 'forbidden', 'You cannot change your own role or plan.');
  if (b.role !== undefined) {
    if (!isRole(b.role)) return apiError(c, 422, 'invalid_role', `Role must be one of ${Object.keys(ROLE_TEMPLATES).join(', ')}`);
    // Nobody grants or removes a role at or above their own, except the owner.
    if (actor.role !== 'owner' && (roleAtLeast(b.role, actor.role) || roleAtLeast(target.role, actor.role))) return apiError(c, 403, 'forbidden', 'You can only manage roles below your own.');
  }
  await c.env.DB.prepare('UPDATE users SET role = COALESCE(?, role), plan = COALESCE(?, plan), updated_at = ? WHERE id = ?').bind(b.role ?? null, b.plan ?? null, Date.now(), target.id).run();
  await c.env.DB.prepare('INSERT INTO audit_log (id,actor,action,target,meta,created_at) VALUES (?,?,?,?,?,?)').bind(newId('aud_'), `${actor.kind}:${actor.userId}`, 'user.update', target.id, JSON.stringify(b), Date.now()).run();
  return c.json({ ok: true, user: { ...(await getUser(c.env, target.id)), password_hash: undefined } });
});

admin.get('/roles', requireScope(), (c) => c.json({ roles: ROLE_TEMPLATES, presets: KEY_PRESETS, plans: PLANS.map((p) => ({ id: p.id, name: p.name, credits: p.credits })) }));

admin.get('/settings', requireScope('settings:write'), async (c) => c.json({ settings: await getSettings(c.env) }));
admin.put('/settings', requireScope('settings:write'), async (c) => {
  const b = await body(c, z.record(z.string().regex(/^[a-z_]{1,40}$/), z.string().max(1000)));
  await putSettings(c.env, b);
  return c.json({ settings: await getSettings(c.env) });
});

api.route('/admin', admin);
