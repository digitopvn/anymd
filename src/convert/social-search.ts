/**
 * Social search for every channel (REST, MCP, CLI, dashboard): validate, reserve the page price,
 * query the platform provider(s), then settle only for platforms that returned results and record usage + trace.
 * `platform: "all"` searches every platform in parallel and merges the results newest first.
 * Every successful page is saved to the user's search history for the dashboard.
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
import { searchPlatform, SOCIAL_PLATFORMS, type SocialPlatform, type SocialSearchPage, type SocialSearchResult } from './social-search-providers';
import { ConvertError } from './types';

export { SOCIAL_PLATFORMS, type SocialPlatform, type SocialSearchResult };

/** What a caller may search: one platform, or `all` of them at once. */
export const SOCIAL_SEARCH_TARGETS = ['all', ...SOCIAL_PLATFORMS] as const;
export type SocialSearchTarget = (typeof SOCIAL_SEARCH_TARGETS)[number];

/** Most credits one `all` page can cost: the sum of every platform's page price. */
export const SOCIAL_SEARCH_ALL_MAX = SOCIAL_PLATFORMS.reduce((sum, p) => sum + SOCIAL_SEARCH_CREDITS[p], 0);
/** Searches kept per user; older ones are dropped when a new one is saved. */
export const SOCIAL_SEARCH_HISTORY_LIMIT = 200;

export const socialSearchInput = {
  platform: z.enum(SOCIAL_SEARCH_TARGETS).describe('all, x, facebook, instagram, threads or linkedin'),
  query: z.string().trim().min(1).max(200).describe('Keywords, hashtags or a phrase to search for'),
  cursor: z.string().max(16000).optional().describe('next_cursor from the previous page'),
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

/** How one platform fared in this search. */
export interface SocialPlatformStatus {
  platform: SocialPlatform;
  count: number;
  credits: number;
  error: string | null;
}

export interface SocialSearchResponse {
  platform: SocialSearchTarget;
  query: string;
  results: SocialSearchResult[];
  nextCursor: string | null;
  credits: number;
  platforms: SocialPlatformStatus[];
  traceId: string;
  durationMs: number;
}

type Target = { platform: SocialPlatform; cursor: string | undefined };

// The `all` cursor carries each platform's own cursor: base64url(JSON { platform: cursor }).
function encodeAllCursor(cursors: Partial<Record<SocialPlatform, string>>): string | null {
  if (!Object.keys(cursors).length) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(cursors));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeAllCursor(cursor: string): Target[] {
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const targets = SOCIAL_PLATFORMS.flatMap((platform) => {
        const value = (parsed as Record<string, unknown>)[platform];
        return typeof value === 'string' && value ? [{ platform, cursor: value }] : [];
      });
      if (targets.length) return targets;
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ConvertError('Invalid social search: cursor is not a next_cursor from an "all" search', 400, 'invalid_request');
}

/** Newest first; posts without a date keep their provider order after the dated ones. */
function mergeNewestFirst(pages: SocialSearchResult[][]): SocialSearchResult[] {
  const time = (r: SocialSearchResult) => (r.publishedAt ? Date.parse(r.publishedAt) : Number.NEGATIVE_INFINITY);
  return pages.flat().map((r, i) => ({ r, i })).sort((a, b) => time(b.r) - time(a.r) || a.i - b.i).map(({ r }) => r);
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
    const all = platform === 'all';
    const targets: Target[] = !all ? [{ platform, cursor }] : cursor ? decodeAllCursor(cursor) : SOCIAL_PLATFORMS.map((p) => ({ platform: p, cursor: undefined }));
    if (!env.RAPIDAPI_KEY) throw new ConvertError('Social search is not configured on this server', 503, 'provider_unavailable');

    const price = targets.reduce((sum, t) => sum + SOCIAL_SEARCH_CREDITS[t.platform], 0);
    const user = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(principal.userId).first<{ plan: string }>();
    const allowance = await reserveConversion(env, tracer.id, principal.userId, user?.plan ?? 'free', price);
    reserved = true;
    if (allowance < price) throw new ConvertError(`This social search needs ${price} credits; fewer are left this month. Upgrade at https://anymd.cc/pricing`, 402, 'quota_exceeded');

    const outcomes = await Promise.all(targets.map(async (t) => {
      // Each platform gets its own call/time budget; the page price was reserved above.
      const budget = new ConversionBudget(SOCIAL_SEARCH_CREDITS[t.platform]);
      try {
        return { ...t, page: await searchPlatform(t.platform, query, t.cursor, { env, tracer, budget }), error: null as ConvertError | null };
      } catch (err) {
        // A provider 404 for a search means nothing matched, not a missing post.
        if (err instanceof ConvertError && err.code === 'not_found') return { ...t, page: { results: [], nextCursor: null } as SocialSearchPage, error: null };
        if (!all) throw err;
        return { ...t, page: { results: [], nextCursor: null } as SocialSearchPage, error: err instanceof ConvertError ? err : new ConvertError('Social search failed', 500, 'internal') };
      }
    }));
    // With every platform failing there is nothing to return; surface the first failure.
    const failure = outcomes.find((o) => o.error)?.error;
    if (failure && outcomes.every((o) => o.error)) throw failure;

    const platforms: SocialPlatformStatus[] = outcomes.map((o) => ({
      platform: o.platform, count: o.page.results.length, credits: o.page.results.length ? SOCIAL_SEARCH_CREDITS[o.platform] : 0, error: o.error ? `${o.error.code}: ${o.error.message}` : null,
    }));
    const credits = platforms.reduce((sum, p) => sum + p.credits, 0);
    await settleConversion(env, tracer.id, credits);
    settled = true;

    const results = all ? mergeNewestFirst(outcomes.map((o) => o.page.results)) : outcomes[0].page.results;
    const nextCursor = all
      ? encodeAllCursor(Object.fromEntries(outcomes.filter((o) => o.page.nextCursor && o.page.results.length).map((o) => [o.platform, o.page.nextCursor!])))
      : outcomes[0].page.nextCursor;
    const durationMs = tracer.elapsed();
    const response: SocialSearchResponse = { platform, query, results, nextCursor, credits, platforms, traceId: tracer.id, durationMs };
    // History is a convenience: a failed save never fails the search the user already paid for.
    await saveSocialSearch(env, principal.userId, req.channel, Boolean(cursor), response).catch((e) => console.error('social search history', e));
    ctx.waitUntil(
      recordUsage(env, { principal, channel: req.channel, kind: 'social_search', target, status: 'ok', httpStatus: 200, credits, durationMs, traceId: tracer.id,
        meta: { platform, results: results.length, paged: Boolean(cursor), platforms: platforms.map((p) => ({ platform: p.platform, count: p.count, error: p.error ? p.error.split(':')[0] : null })) } }, tracer).catch(() => undefined),
    );
    if (credits > 0) ctx.waitUntil(ingestPolarUsage(env, principal.userId, credits, 'social_search', tracer.id).catch(() => undefined));
    return response;
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

/** The most the next page can cost: the page price of every platform still in the cursor. */
export function nextPageCredits(r: Pick<SocialSearchResponse, 'platform' | 'nextCursor'>): number {
  if (!r.nextCursor) return 0;
  if (r.platform !== 'all') return SOCIAL_SEARCH_CREDITS[r.platform];
  try {
    return decodeAllCursor(r.nextCursor).reduce((sum, t) => sum + SOCIAL_SEARCH_CREDITS[t.platform], 0);
  } catch {
    return 0;
  }
}

/** A past search as listed in the dashboard history. */
export interface SocialSearchHistoryItem {
  id: string;
  platform: SocialSearchTarget;
  query: string;
  channel: string;
  paged: boolean;
  resultCount: number;
  credits: number;
  createdAt: number;
}

/** A saved search with its results, as it was answered. */
export type SavedSocialSearch = SocialSearchResponse & { channel: string; paged: boolean; createdAt: number };

async function saveSocialSearch(env: Env, userId: string, channel: Channel, paged: boolean, r: SocialSearchResponse): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO social_searches (id, user_id, platform, query, channel, paged, result_count, credits, results_json, platforms_json, next_cursor, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(r.traceId, userId, r.platform, r.query, channel, paged ? 1 : 0, r.results.length, r.credits, JSON.stringify(r.results), JSON.stringify(r.platforms), r.nextCursor, r.durationMs, Date.now()),
    env.DB.prepare(
      `DELETE FROM social_searches WHERE user_id = ? AND id NOT IN (SELECT id FROM social_searches WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
    ).bind(userId, userId, SOCIAL_SEARCH_HISTORY_LIMIT),
  ]);
}

/** The user's searches, newest first. */
export async function listSocialSearches(env: Env, userId: string, limit = 50): Promise<SocialSearchHistoryItem[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, platform, query, channel, paged, result_count, credits, created_at FROM social_searches WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  ).bind(userId, limit).all<{ id: string; platform: SocialSearchTarget; query: string; channel: string; paged: number; result_count: number; credits: number; created_at: number }>();
  return results.map((r) => ({ id: r.id, platform: r.platform, query: r.query, channel: r.channel, paged: Boolean(r.paged), resultCount: r.result_count, credits: r.credits, createdAt: r.created_at }));
}

/** One of the user's saved searches with its results; null when it is not theirs or no longer kept. */
export async function getSocialSearch(env: Env, userId: string, id: string): Promise<SavedSocialSearch | null> {
  const row = await env.DB.prepare('SELECT * FROM social_searches WHERE id = ? AND user_id = ?').bind(id, userId).first<{
    id: string; platform: SocialSearchTarget; query: string; channel: string; paged: number; credits: number; results_json: string; platforms_json: string;
    next_cursor: string | null; duration_ms: number; created_at: number;
  }>();
  if (!row) return null;
  return {
    platform: row.platform, query: row.query, results: JSON.parse(row.results_json), nextCursor: row.next_cursor, credits: row.credits, platforms: JSON.parse(row.platforms_json),
    traceId: row.id, durationMs: row.duration_ms, channel: row.channel, paged: Boolean(row.paged), createdAt: row.created_at,
  };
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
    platforms: r.platforms,
    trace_id: r.traceId,
    duration_ms: r.durationMs,
  };
}
