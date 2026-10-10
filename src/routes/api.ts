/** REST API v1 — see plans/260926-1256-anymd-platform/contracts.md and /api/v1/openapi.json. */
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { getUser } from '../auth/identity';
import { apiError, markVia, requireScope, sameOriginWrites, type AppContext } from '../auth/middleware';
import { getPlan, type PlanId } from '../billing/plans';
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
import { runConversion, type NotSavedReason } from '../convert/service';
import { getVideoJob, videoJobPayload } from '../convert/youtube-video';
import { runSocialSearch, socialSearchPayload } from '../convert/social-search';
import { enrichmentOptions } from '../convert/enrichment-types';
import { applyPreferencesPatch, canWriteReadingPreferences, getReadingPreferences, PREFERENCES_WRITE_SCOPE, ReadingPreferencesError, resetReadingPreferences, saveReadingPreferences, type StoredReadingPreferences } from '../convert/reading-preferences';
import { DEFAULT_READING_PREFERENCES, READING_LIMITS } from '../lib/reading-options';
import { ConvertError, countWords, type ConvertResult } from '../convert/types';
import type { AppBindings, Principal } from '../env';
import { embedDocument, getDocument, listDocuments, saveDocument, deleteDocument, updateTags } from '../library/store';
import { editTags, listTags, MAX_TAG_LENGTH, MAX_TAGS, parseStoredTags, parseTagFilter } from '../library/store';
import { Tracer } from '../lib/tracer';
import { canSpend, recordUsage } from '../lib/usage';
import { newId } from '../lib/util';
import { convertPayload, searchForPrincipal, usageSummary } from '../services';
import { buildOpenApi } from '../openapi';
import { createOwnKey, listOwnKeys, revokeOwnKey } from '../services/admin/credentials';
import { getOwnTrace, listOwnTraces } from '../services/admin/observability';
import { AdminError } from '../services/admin/shared';
import { adminControlPlane } from './api-admin-control-plane';
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
  if (err instanceof AdminError) {
    if (err.status === 429) c.header('Retry-After', '60');
    return apiError(c, err.status, err.code, err.message, err.details !== undefined ? { details: err.details } : {});
  }
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

// ─── Reading preferences ───────────────────────────────────────────────────

/** Anonymous callers hold `convert` for the URL API, so account-scoped routes check the user explicitly. */
const requireAccount: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get('principal').userId) return apiError(c, 401, 'unauthorized', 'Reading preferences belong to an account. Sign in or send an API key: Authorization: Bearer amd_…');
  await next();
};

function preferencesBody(stored: StoredReadingPreferences) {
  return { preferences: stored.preferences, saved: stored.saved, updated_at: stored.updatedAt, defaults: DEFAULT_READING_PREFERENCES, limits: READING_LIMITS };
}

api.get('/account/reading-preferences', requireAccount, requireScope('convert'), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(preferencesBody(await getReadingPreferences(c.env, me(c).userId)));
});

/**
 * Changing saved defaults: any signed-in session, or an API key / OAuth grant holding
 * `keys:manage` (see `canWriteReadingPreferences`). Reading them only needs `convert`.
 */
const requirePreferencesWriter: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!canWriteReadingPreferences(c.get('principal'))) {
    return apiError(c, 403, 'forbidden', `Missing scope: ${PREFERENCES_WRITE_SCOPE}`, { required: [PREFERENCES_WRITE_SCOPE] });
  }
  markVia(c, 'api');
  await next();
};

/** Partial update: omitted fields keep their saved value. Out-of-range values are rejected, not clamped. */
api.put('/account/reading-preferences', requireAccount, requirePreferencesWriter, async (c) => {
  const raw = await c.req.json().catch(() => {
    throw Object.assign(new Error('Body must be JSON'), { status: 400, code: 'invalid_json' });
  });
  const current = await getReadingPreferences(c.env, me(c).userId);
  try {
    const next = applyPreferencesPatch(current.preferences, raw);
    c.header('Cache-Control', 'no-store');
    return c.json(preferencesBody(await saveReadingPreferences(c.env, c.get('principal'), current, next)));
  } catch (err) {
    if (err instanceof ReadingPreferencesError) return apiError(c, err.status, err.code, err.message, { details: err.details });
    throw err;
  }
});

api.delete('/account/reading-preferences', requireAccount, requirePreferencesWriter, async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(preferencesBody(await resetReadingPreferences(c.env, c.get('principal'))));
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
    expandThread: b.expandThread, maxThreadPosts: b.maxThreadPosts,
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

/** A background YouTube video download started by a conversion. Poll until `ready` or `failed`. */
api.get('/videos/:id', requireScope('convert'), async (c) => {
  const userId = c.get('principal').userId;
  if (!userId) return apiError(c, 401, 'unauthorized', 'Video downloads belong to an account. Send an API key: Authorization: Bearer amd_…');
  const job = await getVideoJob(c.env, userId, c.req.param('id'));
  if (!job) return apiError(c, 404, 'not_found', 'Video download not found');
  c.header('Cache-Control', 'no-store');
  if (job.status === 'queued' || job.status === 'downloading') c.header('Retry-After', '15');
  return c.json(videoJobPayload(c.env, job));
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
    let notSavedReason: NotSavedReason | null = form.save === '0' ? 'not_requested' : !p.scopes.includes('library:write') ? 'missing_scope' : null;
    if (!notSavedReason) {
      const saved = await saveDocument(c.env, p.userId, result, markdown, getPlan(user?.plan ?? 'free').libraryLimit);
      documentId = saved?.id ?? null;
      if (!saved) notSavedReason = 'library_limit';
      if (saved?.changed) c.executionCtx.waitUntil(embedDocument(c.env, p.userId, saved.id).catch(() => 0));
    }
    c.executionCtx.waitUntil(
      recordUsage(c.env, { principal: p, channel: channelFor(c), kind: 'convert', target: result.source, status: 'ok', httpStatus: 200, credits, durationMs: tracer.elapsed(), bytesOut: markdown.length, traceId: tracer.id }, tracer).catch(() => undefined),
    );
    c.header('X-Anymd-Credits', String(credits));
    c.header('X-Anymd-Trace', tracer.id);
    c.header('X-Anymd-Kind', kind);
    return c.json({ name: file.name, bytes: file.size, kind, title, word_count: result.wordCount, markdown, document_id: documentId, saved: documentId !== null, not_saved_reason: notSavedReason, credits, trace_id: tracer.id, duration_ms: tracer.elapsed() });
  } catch (err) {
    const e = err instanceof ConvertError ? err : new ConvertError('Could not convert this file', 422, 'document_failed');
    c.executionCtx.waitUntil(
      recordUsage(c.env, { principal: p, channel: channelFor(c), kind: 'convert', target: `upload://${file.name}`, status: 'error', httpStatus: e.status, credits: 0, durationMs: tracer.elapsed(), traceId: tracer.id, error: `${e.code}: ${e.message}` }, tracer).catch(() => undefined),
    );
    throw e;
  }
});

// ─── Social search ──────────────────────────────────────────────────────────

/** Search public posts on X, Facebook, Instagram, Threads or LinkedIn. Each non-empty page costs credits. */
api.post('/social/search', requireScope('convert'), async (c) => {
  const b = await body(c, z.object({ platform: z.unknown(), query: z.unknown().optional(), q: z.unknown().optional(), cursor: z.unknown().optional() }));
  const r = await runSocialSearch(c.env, c.executionCtx, { platform: b.platform, query: b.query ?? b.q, cursor: b.cursor, channel: channelFor(c), principal: c.get('principal') });
  c.header('X-Anymd-Credits', String(r.credits));
  c.header('X-Anymd-Trace', r.traceId);
  return c.json(socialSearchPayload(r));
});

// ─── Library & search ───────────────────────────────────────────────────────

api.get('/library', requireScope('library:read'), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);
  // `?tag=a&tag=b` or `?tag=a,b`: documents carrying every tag.
  const tags = parseTagFilter(c.req.queries('tag'));
  const items = await listDocuments(c.env, me(c).userId, { limit, before: Number(c.req.query('before')) || undefined, domain: c.req.query('domain') || undefined, kind: c.req.query('kind') || undefined, tags });
  return c.json({ items, next_cursor: items.length === limit ? items[items.length - 1].created_at : null });
});

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
  const limit = Number(c.req.query('limit')) || 50;
  return c.json(await listOwnTraces(c.env, me(c), { limit: Math.min(Math.max(limit, 1), 200), cursor: c.req.query('cursor') || undefined }));
});

api.get('/traces/:id', requireScope('usage:read'), async (c) => c.json(await getOwnTrace(c.env, me(c), c.req.param('id'))));

// ─── API keys ───────────────────────────────────────────────────────────────

api.get('/keys', requireScope('keys:manage'), async (c) => c.json(await listOwnKeys(c.env, me(c))));

api.post('/keys', requireScope('keys:manage'), async (c) => {
  const b = await body(c, z.object({ name: z.string(), preset: z.string().optional(), scopes: z.array(z.string()).optional(), expires_in_days: z.number().int().optional() }));
  const { expires_in_days, ...rest } = b;
  return c.json(await createOwnKey(c.env, me(c), { ...rest, expiresInDays: expires_in_days }), 201);
});

api.delete('/keys/:id', requireScope('keys:manage'), async (c) => {
  await revokeOwnKey(c.env, me(c), c.req.param('id'));
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
  const token = await rotatePreviewToken(c.env, c.get('principal'), page.id);
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

// ─── Admin: control plane (users, roles, settings, opt-outs, credits, billing, audit, system) ──

admin.route('/', adminControlPlane);

api.route('/admin', admin);
