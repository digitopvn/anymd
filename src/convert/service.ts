/**
 * One conversion pipeline for every channel (URL, web, API, MCP, CLI, WebMCP): quota check,
 * cache, adapter run, usage + trace recording, library save and background embedding.
 */
import type { Env, Principal, WaitUntil } from '../env';
import { ANONYMOUS_DAILY_LIMIT, getPlan } from '../billing/plans';
import { ingestPolarUsage } from '../billing/polar';
import { embedDocument, saveDocument } from '../library/store';
import { Tracer } from '../lib/tracer';
import { canSpend, recordUsage, type Channel } from '../lib/usage';
import { newId, sha256 } from '../lib/util';
import { convertUrl, creditCost, formatMarkdown, normalizeTargetUrl, pickAdapter } from './index';
import { ConversionBudget, EnrichmentOptionsSchema, type EnrichmentOptions, type CreditBreakdown } from './enrichment-types';
import { normalizeStoredPreferences, resolveReadingOptions, wantsEnrichment, type ResolvedReadingOptions } from './reading-preferences';
import { enrichImages, renderEnrichment } from './image-enrichment';
import { reserveConversion, settleConversion } from '../lib/conversion-budget';
import { findOptout } from './optouts';
import { startVideoDownload, videoDownloadMarkdown, type VideoDownloadState } from './youtube-video';
import { ConvertError, countWords, type ConvertResult } from './types';

export interface ConvertRequest extends EnrichmentOptions {
  url: string;
  channel: Channel;
  principal: Principal;
  language?: string;
  selector?: string;
  removeImages?: boolean;
  frontmatter?: boolean;
  /** Save to the caller's library (signed-in callers only). Default true. */
  save?: boolean;
  /** Skip the shared cache. */
  fresh?: boolean;
  clientIp?: string;
}

/**
 * Why a conversion was not saved to the library: the caller opted out, is anonymous, its credential
 * lacks `library:write` (e.g. a "Convert only" key), or the library is full.
 */
export type NotSavedReason = 'not_requested' | 'anonymous' | 'missing_scope' | 'library_limit';

export interface ConvertResponse {
  creditBreakdown?: CreditBreakdown;
  /** Effective reading options after `request > saved preference > default`, with each value's source. */
  readingOptions: ResolvedReadingOptions;
  result: ConvertResult;
  markdown: string;
  documentId: string | null;
  /** Null when the conversion was saved. */
  notSavedReason: NotSavedReason | null;
  credits: number;
  cached: boolean;
  traceId: string;
  durationMs: number;
  /** The background video download for a YouTube read, when the account's `downloadVideo` preference is on. */
  videoDownload: VideoDownloadState | null;
}

const CACHE_TTL = 3600;
const MAX_DETECTED_DOCUMENT_CREDITS = Math.max(...(['pdf', 'image', 'document'] as const).map((kind) => creditCost(kind)));

/** v4: X threads no longer expand implicitly for accounts, so v3 entries must not be reused. */
/**
 * Only values that can change the output are part of the key: a cap counts only while its
 * enrichment is on (`maxCredits` only while any enrichment is on), so users with different saved
 * caps but enrichment off share the same base-conversion cache entry.
 */
export function cacheKey(url: string, req: Pick<ConvertRequest, 'language' | 'selector' | 'principal'>, o: ResolvedReadingOptions): Promise<string> {
  return sha256(['v4', url, req.language ?? '', req.selector ?? '', o.removeImages ? 1 : 0,
    req.principal.userId ? 'account' : 'anonymous',
    o.expandThread, o.expandThread ? o.maxThreadPosts : 0,
    o.includeComments, o.includeComments ? o.maxComments : 0,
    o.analyzeImages, o.analyzeImages ? o.maxImages : 0,
    wantsEnrichment(o) ? o.maxCredits : 0].join('|')).then((h) => `conv:${h}`);
}

/** Base-only conversions reserve just the base price; only opted-in enrichment reserves up to the cap. */
export function reservationCredits(url: URL, o: Pick<ResolvedReadingOptions, 'expandThread' | 'includeComments' | 'analyzeImages' | 'maxCredits'>): number {
  const adapter = pickAdapter(url);
  if (wantsEnrichment(o)) return o.maxCredits;
  const baseMaximum = adapter.kind === 'web' ? MAX_DETECTED_DOCUMENT_CREDITS : creditCost(adapter.kind);
  return Math.min(o.maxCredits, baseMaximum);
}

async function enforceAnonymousLimit(env: Env, ip: string | undefined): Promise<void> {
  if (!ip) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `anon:${day}:${await sha256(ip)}`;
  const count = Number((await env.CACHE.get(key)) ?? 0);
  if (count >= ANONYMOUS_DAILY_LIMIT) {
    throw new ConvertError(
      `Anonymous limit reached (${ANONYMOUS_DAILY_LIMIT}/day). Create a free account for 500 credits/month: https://anymd.cc/signup`,
      429,
      'anonymous_limit',
    );
  }
  await env.CACHE.put(key, String(count + 1), { expirationTtl: 86400 });
}

export async function runConversion(env: Env, ctx: WaitUntil, req: ConvertRequest): Promise<ConvertResponse> {
  const tracer = new Tracer(newId('trc_'));
  const principal = req.principal;
  let targetForLog = req.url;
  let reserved = false;
  let settled = false;
  let budget: ConversionBudget | undefined;
  let cacheValue: string | undefined;
  let readingOptions: ResolvedReadingOptions | undefined;
  try {
    const validated = EnrichmentOptionsSchema.safeParse(req);
    if (!validated.success) {
      const issue = validated.error.issues[0];
      throw new ConvertError(`Invalid enrichment options${issue ? `: ${issue.path.join('.')} ${issue.message}` : ''}`, 400, 'invalid_options');
    }
    if (req.removeImages && req.analyzeImages) throw new ConvertError('analyzeImages cannot be combined with removeImages', 400, 'invalid_options');
    if (!principal.userId && (req.expandThread || req.includeComments || req.analyzeImages)) throw new ConvertError('Enrichment requires an account', 401, 'authentication_required');
    const url = normalizeTargetUrl(req.url);
    targetForLog = url.href;
    const optout = await tracer.span('optout', () => findOptout(env, url.hostname));
    if (optout) {
      throw new ConvertError(`${optout.domain} has asked not to be converted by anymd. See https://anymd.cc/legal/abuse`, 403, 'site_opted_out');
    }

    let plan = 'free';
    let savedPreferences: string | null = null;
    if (principal.userId) {
      const user = await env.DB.prepare('SELECT u.plan, p.preferences FROM users u LEFT JOIN reading_preferences p ON p.user_id = u.id WHERE u.id = ?')
        .bind(principal.userId).first<{ plan: string; preferences: string | null }>();
      plan = user?.plan ?? 'free';
      savedPreferences = user?.preferences ?? null;
    }
    // Saved preferences apply only to the signed-in owner; they never widen plan or reservation limits.
    const preferences = savedPreferences === null ? null : normalizeStoredPreferences(savedPreferences);
    readingOptions = resolveReadingOptions({ ...validated.data, removeImages: req.removeImages }, preferences);
    const options = readingOptions;
    const key = await cacheKey(url.href, req, options);

    let result: ConvertResult | null = null;
    if (!req.fresh) {
      const hit = await tracer.span('cache.get', () => env.CACHE.get<ConvertResult>(key, 'json'));
      if (hit) result = hit;
    }
    const cached = result !== null;

    if (!result) {
      const adapter = pickAdapter(url);
      const requestedLimit = options.maxCredits;
      if (principal.userId) {
        // Estimate with the cheapest cost; exact cost is charged after the adapter reveals the kind.
        const { ok, state } = await canSpend(env, principal.userId, plan, 1);
        if (!ok) {
          throw new ConvertError(
            `Monthly credits used up (${state.used}/${state.included + state.extra}). Upgrade at https://anymd.cc/pricing`,
            402,
            'quota_exceeded',
          );
        }
        const allowance = await reserveConversion(env, tracer.id, principal.userId, plan, reservationCredits(url, options));
        reserved = true;
        budget = new ConversionBudget(allowance);
        const base = creditCost(adapter.kind);
        if (!budget.canSpend(base)) throw new ConvertError('Budget is too small for this source', 402, 'credit_limit');
        budget.charge('base', base);
      } else {
        budget = new ConversionBudget(requestedLimit);
        const base = creditCost(adapter.kind);
        if (!budget.canSpend(base)) throw new ConvertError('Budget is too small for this source', 402, 'credit_limit');
        await enforceAnonymousLimit(env, req.clientIp);
        budget.charge('base', base);
      }
      const { sources: _sources, ...effective } = options;
      const conversionContext = { env, tracer, ...effective, language: req.language, selector: req.selector, authenticated: !!principal.userId, budget };
      result = await convertUrl(url, conversionContext);
      if (budget) {
        const actualBase = creditCost(result.sourceKind);
        if (!budget.canSpend(actualBase - budget.breakdown.base)) throw new ConvertError('Budget is too small for this source', 402, 'credit_limit');
        budget.breakdown.base = actualBase;
        if (options.includeComments && !result.enrichment?.comments) {
          result.enrichment ??= {};
          result.enrichment.comments = { complete: false, count: 0, fetchedAt: new Date().toISOString(), reason: 'comments_unsupported', markdown: '' };
        }
        await enrichImages(result, conversionContext);
      }
      result.baseContent = result.content;
      result.content = renderEnrichment(result.content, result.source, result.enrichment);
      result.wordCount = countWords(result.content);
      const toCache = { ...result, contentHtml: undefined };
      if (!Object.values(result.enrichment ?? {}).some((part) => !part.complete)) cacheValue = JSON.stringify(toCache);
    }

    let markdown = formatMarkdown(result, { frontmatter: req.frontmatter !== false });
    // Per-account and asynchronous, so it runs after the shared cache and is never cached itself.
    let videoDownload: VideoDownloadState | null = null;
    if (result.sourceKind === 'youtube' && principal.userId && preferences?.downloadVideo) {
      videoDownload = await tracer.span('video.start', () => startVideoDownload(env, principal, plan, req.channel, result!.source));
      if (videoDownload) markdown = `${markdown.trimEnd()}\n\n${videoDownloadMarkdown(videoDownload)}\n`;
    }
    const credits = cached ? 0 : budget?.used ?? creditCost(result.sourceKind);
    const creditBreakdown: CreditBreakdown | undefined = cached ? { base: 0, thread: 0, comments: 0, images: 0 } : budget?.breakdown;

    let documentId: string | null = null;
    let notSavedReason: NotSavedReason | null = req.save === false ? 'not_requested' : !principal.userId ? 'anonymous' : !principal.scopes.includes('library:write') ? 'missing_scope' : null;
    if (!notSavedReason && principal.userId) {
      const saved = await tracer.span('library.save', () => saveDocument(env, principal.userId!, result!, formatMarkdown(result!, { frontmatter: false }), getPlan(plan).libraryLimit));
      documentId = saved?.id ?? null;
      if (!saved) notSavedReason = 'library_limit';
      if (saved?.changed) ctx.waitUntil(embedDocument(env, principal.userId, saved.id).catch(() => 0));
    }

    if (reserved) { await settleConversion(env, tracer.id, credits); settled = true; }
    if (cacheValue) ctx.waitUntil(env.CACHE.put(key, cacheValue, { expirationTtl: CACHE_TTL }));

    const durationMs = tracer.elapsed();
    ctx.waitUntil(
      recordUsage(
        env,
        { principal, channel: req.channel, kind: 'convert', target: url.href, status: cached ? 'cached' : 'ok', httpStatus: 200, credits, durationMs, bytesOut: markdown.length, traceId: tracer.id,
          meta: { credit_breakdown: creditBreakdown, reading_options: options, ...(videoDownload ? { video_download: videoDownload } : {}) } },
        tracer,
      ).catch(() => undefined),
    );
    if (principal.userId && credits > 0) ctx.waitUntil(ingestPolarUsage(env, principal.userId, credits, result.sourceKind, reserved ? tracer.id : undefined).catch(() => undefined));

    return { result, markdown, documentId, notSavedReason, credits, cached, traceId: tracer.id, durationMs, creditBreakdown, readingOptions: options, videoDownload };
  } catch (err) {
    if (reserved && !settled) await settleConversion(env, tracer.id, 0).catch(() => undefined);
    const e = err instanceof ConvertError ? err : new ConvertError(err instanceof Error ? err.message : 'Conversion failed', 500, 'internal');
    ctx.waitUntil(
      recordUsage(
        env,
        { principal, channel: req.channel, kind: 'convert', target: targetForLog, status: 'error', httpStatus: e.status, credits: 0, durationMs: tracer.elapsed(), traceId: tracer.id, error: `${e.code}: ${e.message}`,
          meta: readingOptions ? { reading_options: readingOptions } : undefined },
        tracer,
      ).catch(() => undefined),
    );
    throw e;
  }
}
