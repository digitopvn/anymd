/**
 * Social search for every channel (REST, MCP, CLI, dashboard): validate, reserve the page price,
 * query the platform provider, then settle only when results came back and record usage + trace.
 */
import { z } from 'zod';
import type { Env, Principal, WaitUntil } from '../env';
import { SOCIAL_SEARCH_CREDITS } from '../billing/plans';
import { ingestPolarUsage } from '../billing/polar';
import { reserveConversion, settleConversion } from '../lib/conversion-budget';
import { Tracer } from '../lib/tracer';
import { recordUsage, type Channel } from '../lib/usage';
import { newId } from '../lib/util';
import { ConversionBudget } from './enrichment-types';
import { searchPlatform, SOCIAL_PLATFORMS, type SocialPlatform, type SocialSearchResult } from './social-search-providers';
import { ConvertError } from './types';

export { SOCIAL_PLATFORMS, type SocialPlatform, type SocialSearchResult };

export const socialSearchInput = {
  platform: z.enum(SOCIAL_PLATFORMS).describe('x, facebook, instagram, threads or linkedin'),
  query: z.string().trim().min(1).max(200).describe('Keywords, hashtags or a phrase to search for'),
  cursor: z.string().max(8000).optional().describe('next_cursor from the previous page'),
};
export const SocialSearchSchema = z.object(socialSearchInput);
export type SocialSearchInput = z.infer<typeof SocialSearchSchema>;

export interface SocialSearchRequest {
  platform: unknown;
  query: unknown;
  cursor?: unknown;
  channel: Channel;
  principal: Principal;
}

export interface SocialSearchResponse {
  platform: SocialPlatform;
  query: string;
  results: SocialSearchResult[];
  nextCursor: string | null;
  credits: number;
  traceId: string;
  durationMs: number;
}

export async function runSocialSearch(env: Env, ctx: WaitUntil, req: SocialSearchRequest): Promise<SocialSearchResponse> {
  const tracer = new Tracer(newId('trc_'));
  const principal = req.principal;
  let target = `${String(req.platform ?? '')}:${String(req.query ?? '')}`;
  let reserved = false;
  let settled = false;
  try {
    if (!principal.userId) throw new ConvertError('Social search requires an account. Sign in or send an API key.', 401, 'authentication_required');
    const parsed = SocialSearchSchema.safeParse({ platform: req.platform, query: req.query, cursor: req.cursor || undefined });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ConvertError(`Invalid social search${issue ? `: ${issue.path.join('.')} ${issue.message}` : ''}`, 400, 'invalid_request');
    }
    const { platform, query, cursor } = parsed.data;
    target = `${platform}:${query}`;
    if (!env.RAPIDAPI_KEY) throw new ConvertError('Social search is not configured on this server', 503, 'provider_unavailable');

    const user = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(principal.userId).first<{ plan: string }>();
    const allowance = await reserveConversion(env, tracer.id, principal.userId, user?.plan ?? 'free', SOCIAL_SEARCH_CREDITS);
    reserved = true;
    if (allowance < SOCIAL_SEARCH_CREDITS) throw new ConvertError(`Social search needs ${SOCIAL_SEARCH_CREDITS} credits; fewer are left this month. Upgrade at https://anymd.cc/pricing`, 402, 'quota_exceeded');
    // The budget bounds provider calls and time; the page price was reserved above.
    const budget = new ConversionBudget(SOCIAL_SEARCH_CREDITS);
    const page = await searchPlatform(platform, query, cursor, { env, tracer, budget }).catch((err) => {
      // A provider 404 for a search means nothing matched, not a missing post.
      if (err instanceof ConvertError && err.code === 'not_found') return { results: [], nextCursor: null };
      throw err;
    });
    const credits = page.results.length ? SOCIAL_SEARCH_CREDITS : 0;
    await settleConversion(env, tracer.id, credits);
    settled = true;

    const durationMs = tracer.elapsed();
    ctx.waitUntil(
      recordUsage(env, { principal, channel: req.channel, kind: 'social_search', target, status: 'ok', httpStatus: 200, credits, durationMs, traceId: tracer.id,
        meta: { platform, results: page.results.length, paged: Boolean(cursor) } }, tracer).catch(() => undefined),
    );
    if (credits > 0) ctx.waitUntil(ingestPolarUsage(env, principal.userId, credits, 'social_search', tracer.id).catch(() => undefined));
    return { platform, query, results: page.results, nextCursor: page.nextCursor, credits, traceId: tracer.id, durationMs };
  } catch (err) {
    if (reserved && !settled) await settleConversion(env, tracer.id, 0).catch(() => undefined);
    const e = err instanceof ConvertError ? err : new ConvertError('Social search failed', 500, 'internal');
    if (principal.userId) {
      ctx.waitUntil(
        recordUsage(env, { principal, channel: req.channel, kind: 'social_search', target, status: 'error', httpStatus: e.status, credits: 0, durationMs: tracer.elapsed(), traceId: tracer.id, error: `${e.code}: ${e.message}` }, tracer)
          .catch(() => undefined),
      );
    }
    throw e;
  }
}

/** JSON body shared by REST and MCP. */
export function socialSearchPayload(r: SocialSearchResponse) {
  return {
    platform: r.platform,
    query: r.query,
    count: r.results.length,
    results: r.results.map((x) => ({ platform: x.platform, id: x.id, url: x.url, author: x.author, text: x.text, published_at: x.publishedAt, stats: x.stats, media: x.media })),
    next_cursor: r.nextCursor,
    credits: r.credits,
    trace_id: r.traceId,
    duration_ms: r.durationMs,
  };
}
