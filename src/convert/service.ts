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
import { convertUrl, creditCost, formatMarkdown, normalizeTargetUrl } from './index';
import { findOptout } from './optouts';
import { ConvertError, type ConvertResult } from './types';

export interface ConvertRequest {
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
  result: ConvertResult;
  markdown: string;
  documentId: string | null;
  credits: number;
  cached: boolean;
  traceId: string;
  durationMs: number;
}

const CACHE_TTL = 3600;

function cacheKey(url: string, req: ConvertRequest): Promise<string> {
  return sha256(['v2', url, req.language ?? '', req.selector ?? '', req.removeImages ? 1 : 0].join('|')).then((h) => `conv:${h}`);
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
  try {
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
      } else {
        await enforceAnonymousLimit(env, req.clientIp);
      }
      result = await convertUrl(url, { env, tracer, language: req.language, selector: req.selector, removeImages: req.removeImages });
      const toCache = { ...result, contentHtml: undefined };
      ctx.waitUntil(env.CACHE.put(key, JSON.stringify(toCache), { expirationTtl: CACHE_TTL }));
    }

    const markdown = formatMarkdown(result, { frontmatter: req.frontmatter !== false });
    const credits = cached ? 0 : creditCost(result.sourceKind);

    let documentId: string | null = null;
    if (principal.userId && req.save !== false && principal.scopes.includes('library:write')) {
      const saved = await tracer.span('library.save', () => saveDocument(env, principal.userId!, result!, formatMarkdown(result!, { frontmatter: false }), getPlan(plan).libraryLimit));
      documentId = saved?.id ?? null;
      if (saved?.changed) ctx.waitUntil(embedDocument(env, principal.userId, saved.id).catch(() => 0));
    }

    const durationMs = tracer.elapsed();
    ctx.waitUntil(
      recordUsage(
        env,
        { principal, channel: req.channel, kind: 'convert', target: url.href, status: cached ? 'cached' : 'ok', httpStatus: 200, credits, durationMs, bytesOut: markdown.length, traceId: tracer.id },
        tracer,
      ).catch(() => undefined),
    );
    if (principal.userId && credits > 0) ctx.waitUntil(ingestPolarUsage(env, principal.userId, credits, result.sourceKind).catch(() => undefined));

    return { result, markdown, documentId, credits, cached, traceId: tracer.id, durationMs };
  } catch (err) {
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
