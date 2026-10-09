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
import { enrichImages, renderEnrichment } from './image-enrichment';
import { reserveConversion, settleConversion } from '../lib/conversion-budget';
import { findOptout } from './optouts';
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

export interface ConvertResponse {
  creditBreakdown?: CreditBreakdown;
  result: ConvertResult;
  markdown: string;
  documentId: string | null;
  credits: number;
  cached: boolean;
  traceId: string;
  durationMs: number;
}

const CACHE_TTL = 3600;
const MAX_DETECTED_DOCUMENT_CREDITS = Math.max(...(['pdf', 'image', 'document'] as const).map((kind) => creditCost(kind)));

function cacheKey(url: string, req: ConvertRequest): Promise<string> {
  return sha256(['v3', url, req.language ?? '', req.selector ?? '', req.removeImages ? 1 : 0,
    req.principal.userId ? 'account' : 'anonymous', !!req.includeComments, !!req.analyzeImages,
    req.maxComments ?? 100, req.maxImages ?? 10, req.maxCredits ?? 100].join('|')).then((h) => `conv:${h}`);
}

function reservationCredits(url: URL, req: EnrichmentOptions): number {
  const limit = req.maxCredits ?? 100;
  const adapter = pickAdapter(url);
  if (adapter.kind === 'x' || req.includeComments || req.analyzeImages) return limit;
  const baseMaximum = adapter.kind === 'web' ? MAX_DETECTED_DOCUMENT_CREDITS : creditCost(adapter.kind);
  return Math.min(limit, baseMaximum);
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
  try {
    const validated = EnrichmentOptionsSchema.safeParse(req);
    if (!validated.success) throw new ConvertError('Invalid enrichment options', 400, 'invalid_options');
    if (req.removeImages && req.analyzeImages) throw new ConvertError('analyzeImages cannot be combined with removeImages', 400, 'invalid_options');
    if (!principal.userId && (req.includeComments || req.analyzeImages)) throw new ConvertError('Enrichment requires an account', 401, 'authentication_required');
    const url = normalizeTargetUrl(req.url);
    targetForLog = url.href;
    const optout = await tracer.span('optout', () => findOptout(env, url.hostname));
    if (optout) {
      throw new ConvertError(`${optout.domain} has asked not to be converted by anymd. See https://anymd.cc/legal/abuse`, 403, 'site_opted_out');
    }
    const key = await cacheKey(url.href, req);

    let plan = 'free';
    if (principal.userId) {
      const user = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(principal.userId).first<{ plan: string }>();
      plan = user?.plan ?? 'free';
    }

    let result: ConvertResult | null = null;
    if (!req.fresh) {
      const hit = await tracer.span('cache.get', () => env.CACHE.get<ConvertResult>(key, 'json'));
      if (hit) result = hit;
    }
    const cached = result !== null;

    if (!result) {
      const adapter = pickAdapter(url);
      const requestedLimit = validated.data.maxCredits ?? 100;
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
        const allowance = await reserveConversion(env, tracer.id, principal.userId, plan, reservationCredits(url, validated.data));
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
      const conversionContext = { env, tracer, ...validated.data, language: req.language, selector: req.selector, removeImages: req.removeImages, authenticated: !!principal.userId, budget };
      result = await convertUrl(url, conversionContext);
      if (budget) {
        const actualBase = creditCost(result.sourceKind);
        if (!budget.canSpend(actualBase - budget.breakdown.base)) throw new ConvertError('Budget is too small for this source', 402, 'credit_limit');
        budget.breakdown.base = actualBase;
        if (req.includeComments && !result.enrichment?.comments) {
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

    const markdown = formatMarkdown(result, { frontmatter: req.frontmatter !== false });
    const credits = cached ? 0 : budget?.used ?? creditCost(result.sourceKind);

    let documentId: string | null = null;
    if (principal.userId && req.save !== false && principal.scopes.includes('library:write')) {
      const saved = await tracer.span('library.save', () => saveDocument(env, principal.userId!, result!, formatMarkdown(result!, { frontmatter: false }), getPlan(plan).libraryLimit));
      documentId = saved?.id ?? null;
      if (saved?.changed) ctx.waitUntil(embedDocument(env, principal.userId, saved.id).catch(() => 0));
    }

    if (reserved) { await settleConversion(env, tracer.id, credits); settled = true; }
    if (cacheValue) ctx.waitUntil(env.CACHE.put(key, cacheValue, { expirationTtl: CACHE_TTL }));

    const durationMs = tracer.elapsed();
    ctx.waitUntil(
      recordUsage(
        env,
        { principal, channel: req.channel, kind: 'convert', target: url.href, status: cached ? 'cached' : 'ok', httpStatus: 200, credits, durationMs, bytesOut: markdown.length, traceId: tracer.id },
        tracer,
      ).catch(() => undefined),
    );
    if (principal.userId && credits > 0) ctx.waitUntil(ingestPolarUsage(env, principal.userId, credits, result.sourceKind).catch(() => undefined));

    return { result, markdown, documentId, credits, cached, traceId: tracer.id, durationMs,
      creditBreakdown: cached ? { base: 0, thread: 0, comments: 0, images: 0 } : budget?.breakdown };
  } catch (err) {
    if (reserved && !settled) await settleConversion(env, tracer.id, 0).catch(() => undefined);
    const e = err instanceof ConvertError ? err : new ConvertError(err instanceof Error ? err.message : 'Conversion failed', 500, 'internal');
    ctx.waitUntil(
      recordUsage(
        env,
        { principal, channel: req.channel, kind: 'convert', target: targetForLog, status: 'error', httpStatus: e.status, credits: 0, durationMs: tracer.elapsed(), traceId: tracer.id, error: `${e.code}: ${e.message}` },
        tracer,
      ).catch(() => undefined),
    );
    throw e;
  }
}
