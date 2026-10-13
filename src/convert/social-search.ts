/**
 * Social search for every channel (REST, MCP, CLI, dashboard): validate, reserve the page price,
 * query the platform provider(s), then settle only for platforms that returned results and record usage + trace.
 * `platform: "all"` searches every platform in parallel and merges the results newest first.
 * Results are de-duplicated by exact post identity and, when asked, limited to a UTC time range; a paging session
 * (`social-search-session.ts`) keeps that range and the posts already returned, so later pages never repeat a post.
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
import { searchPlatform, SOCIAL_DATE_FILTER, SOCIAL_PLATFORMS, type SocialPlatform, type SocialSearchPage, type SocialSearchResult } from './social-search-providers';
import { filterPage, mergeNewestFirst, rangeIso, resolveTimeRange, sameRequestedRange, SOCIAL_SEARCH_PERIODS, type TimeRange } from './social-search-results';
import {
  advanceSession, claimSession, createSession, cursorUsed, deleteSession, isSessionCursor, loadSession, parseSessionCursor, queryKey, releaseSession,
  SESSION_MAX_PAGES, SESSION_MAX_SEEN, type ProviderCursors, type SearchSession,
} from './social-search-session';
import { ConvertError } from './types';

export { SOCIAL_PLATFORMS, SOCIAL_SEARCH_PERIODS, type SocialPlatform, type SocialSearchResult };

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
  cursor: z.string().max(16000).optional().describe('next_cursor from the previous page; it keeps the time range of the first page'),
  period: z.enum(SOCIAL_SEARCH_PERIODS).optional().describe('Only posts from the last 24h, 7d or 30d, anchored when the search starts. Not with since/until'),
  since: z.string().max(40).optional().describe('Only posts published at or after this ISO-8601 time (e.g. 2026-10-01T00:00:00Z or 2026-10-01 for UTC midnight)'),
  until: z.string().max(40).optional().describe('Only posts published before this ISO-8601 time (exclusive)'),
};
export const SocialSearchSchema = z.object(socialSearchInput);
export type SocialSearchInput = z.infer<typeof SocialSearchSchema>;

export interface SocialSearchRequest {
  platform: unknown;
  query: unknown;
  cursor?: unknown;
  period?: unknown;
  since?: unknown;
  until?: unknown;
  channel: Channel;
  principal: Principal;
}

/** `none`: no time range asked for; otherwise how this platform applied it (see `SOCIAL_DATE_FILTER`). */
export type DateFilterMode = 'none' | 'native' | 'post_filter';
/**
 * How far a time-filtered page can be trusted to cover the range: `unfiltered` (no range), `native` (every platform
 * filtered at the provider) or `provider_limited` (some platform filtered after fetching, so posts in range may be missing).
 */
export type SocialCoverage = 'unfiltered' | 'native' | 'provider_limited';

/** How one platform fared in this search. `rawCount = count + duplicateCount + outOfRangeCount + missingTimestampCount`. */
export interface SocialPlatformStatus {
  platform: SocialPlatform;
  count: number;
  credits: number;
  error: string | null;
  rawCount: number;
  duplicateCount: number;
  outOfRangeCount: number;
  missingTimestampCount: number;
  filterMode: DateFilterMode;
}

export interface SocialTimeRange {
  period: string | null;
  since: string | null;
  until: string | null;
}

export interface SocialSearchResponse {
  platform: SocialSearchTarget;
  query: string;
  results: SocialSearchResult[];
  nextCursor: string | null;
  /** The most the next page can cost; 0 without a next page. */
  nextPageCredits: number;
  credits: number;
  platforms: SocialPlatformStatus[];
  rawCount: number;
  duplicateCount: number;
  outOfRangeCount: number;
  missingTimestampCount: number;
  timeRange: SocialTimeRange | null;
  coverage: SocialCoverage;
  /** Paging stopped because the search reached its page or remembered-post limit. */
  sessionLimitReached: boolean;
  traceId: string;
  durationMs: number;
}

type Target = { platform: SocialPlatform; cursor: string | undefined };

// Legacy `all` cursor (before paging sessions): base64url(JSON { platform: cursor }). Still accepted as input.
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

const pagePrice = (platforms: Iterable<SocialPlatform>) => [...platforms].reduce((sum, p) => sum + SOCIAL_SEARCH_CREDITS[p], 0);
const optionalString = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : v);

export async function runSocialSearch(env: Env, ctx: WaitUntil, req: SocialSearchRequest): Promise<SocialSearchResponse> {
  const tracer = new Tracer(newId('trc_'));
  const principal = req.principal;
  let target = `${String(req.platform ?? '')}:${String(req.query ?? '')}`;
  let reserved = false;
  let settled = false;
  let claimed: { id: string; version: number } | null = null;
  let completed = false;
  try {
    if (!principal.userId) throw new ConvertError('Social search requires an account. Sign in or send an API key.', 401, 'authentication_required');
    const parsed = SocialSearchSchema.safeParse({
      platform: req.platform, query: req.query, cursor: optionalString(req.cursor), period: optionalString(req.period), since: optionalString(req.since), until: optionalString(req.until),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ConvertError(`Invalid social search${issue ? `: ${issue.path.join('.')} ${issue.message}` : ''}`, 400, 'invalid_request');
    }
    const { platform, query, cursor } = parsed.data;
    const filters = { period: parsed.data.period, since: parsed.data.since, until: parsed.data.until };
    target = `${platform}:${query}`;
    const all = platform === 'all';
    const now = Date.now();

    // Where this page starts: a session cursor (authoritative state), a legacy provider cursor, or a fresh search.
    let session: SearchSession | null = null;
    let range: TimeRange | null;
    let targets: Target[];
    if (cursor && isSessionCursor(cursor)) {
      const handle = parseSessionCursor(cursor);
      session = await loadSession(env, principal.userId, handle.id, now);
      if (session.platform !== platform || session.queryKey !== queryKey(query)) {
        throw new ConvertError('Invalid social search: cursor belongs to a different search (platform or query changed)', 400, 'invalid_request');
      }
      if (!sameRequestedRange(filters, session.range)) {
        throw new ConvertError('Invalid social search: cursor belongs to a search with a different time range; omit period/since/until to keep the original range', 400, 'invalid_request');
      }
      if (handle.version !== session.version) throw cursorUsed();
      range = session.range;
      targets = SOCIAL_PLATFORMS.flatMap((p) => (session!.cursors[p] ? [{ platform: p, cursor: session!.cursors[p] }] : []));
    } else if (cursor) {
      if (filters.period || filters.since || filters.until) {
        throw new ConvertError('Invalid social search: this cursor predates time filters; start a new search to use period/since/until', 400, 'invalid_request');
      }
      range = null;
      targets = all ? decodeAllCursor(cursor) : [{ platform, cursor }];
    } else {
      range = resolveTimeRange(filters, now);
      targets = all ? SOCIAL_PLATFORMS.map((p) => ({ platform: p, cursor: undefined })) : [{ platform: platform as SocialPlatform, cursor: undefined }];
    }
    if (!targets.length) throw new ConvertError('Invalid social search: this search has no more pages', 400, 'invalid_request');
    if (!env.RAPIDAPI_KEY) throw new ConvertError('Social search is not configured on this server', 503, 'provider_unavailable');

    const price = pagePrice(targets.map((t) => t.platform));
    const user = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(principal.userId).first<{ plan: string }>();
    const allowance = await reserveConversion(env, tracer.id, principal.userId, user?.plan ?? 'free', price);
    reserved = true;
    if (allowance < price) throw new ConvertError(`This social search needs ${price} credits; fewer are left this month. Upgrade at https://anymd.cc/pricing`, 402, 'quota_exceeded');
    if (session) {
      await claimSession(env, principal.userId, session.id, session.version, tracer.id, now);
      claimed = { id: session.id, version: session.version };
    }

    const window = range ? { since: range.since, until: range.until } : null;
    const outcomes = await Promise.all(targets.map(async (t) => {
      // Each platform gets its own call/time budget; the page price was reserved above.
      const budget = new ConversionBudget(SOCIAL_SEARCH_CREDITS[t.platform]);
      try {
        return { ...t, page: await searchPlatform(t.platform, query, t.cursor, { env, tracer, budget }, window), error: null as ConvertError | null };
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

    // Exact de-duplication against this page and every earlier page of the search, then the time range.
    const seen = new Set(session?.seen ?? []);
    const filtered = outcomes.map((o) => {
      const f = filterPage(o.page.results, range, seen);
      return { ...o, ...f };
    });
    const platforms: SocialPlatformStatus[] = filtered.map((o) => ({
      platform: o.platform,
      count: o.kept.length,
      // Billing is unchanged by filtering: a platform that returned posts was paid for upstream, even if all were removed.
      credits: o.page.results.length ? SOCIAL_SEARCH_CREDITS[o.platform] : 0,
      error: o.error ? `${o.error.code}: ${o.error.message}` : null,
      rawCount: o.counts.raw,
      duplicateCount: o.counts.duplicates,
      outOfRangeCount: o.counts.outOfRange,
      missingTimestampCount: o.counts.missingTimestamp,
      filterMode: range ? SOCIAL_DATE_FILTER[o.platform] : 'none',
    }));
    const credits = platforms.reduce((sum, p) => sum + p.credits, 0);
    const results = all ? mergeNewestFirst(filtered.map((o) => o.kept)) : filtered[0].kept;

    // A provider keeps paging while it returned posts and a new cursor, even if every post was filtered out.
    // A provider that hands back the cursor it was given would loop forever, so it stops.
    // In "all", a platform that failed mid-search keeps its cursor and is asked again on the next page (failed calls are free),
    // as long as another platform is still paging; a search is never kept alive by failures alone.
    const paging = outcomes.filter((o) => !o.error && o.page.nextCursor && o.page.results.length && o.page.nextCursor !== o.cursor);
    const retrying = paging.length ? outcomes.filter((o) => o.error && o.cursor) : [];
    const nextCursors: ProviderCursors = Object.fromEntries([
      ...paging.map((o): [SocialPlatform, string] => [o.platform, o.page.nextCursor!]),
      ...retrying.map((o): [SocialPlatform, string] => [o.platform, o.cursor!]),
    ]);
    const seenNext = [...seen, ...filtered.flatMap((o) => o.keys)];
    const pages = (session?.pages ?? 0) + 1;
    const hasMore = Object.keys(nextCursors).length > 0;
    const sessionLimitReached = hasMore && (pages >= SESSION_MAX_PAGES || seenNext.length > SESSION_MAX_SEEN);

    // Settle first: a billing failure must leave the cursor the client holds usable (the catch releases the lease).
    await settleConversion(env, tracer.id, credits);
    settled = true;
    let nextCursor: string | null = null;
    if (hasMore && !sessionLimitReached) {
      nextCursor = claimed
        ? await advanceSession(env, claimed.id, claimed.version, tracer.id, { cursors: nextCursors, seen: seenNext, pages }, now)
        : await createSession(env, principal.userId, { platform, queryKey: queryKey(query), range, cursors: nextCursors, seen: seenNext }, now);
    } else if (claimed) {
      await deleteSession(env, claimed.id, tracer.id);
    }
    completed = true;

    const sum = (key: 'rawCount' | 'duplicateCount' | 'outOfRangeCount' | 'missingTimestampCount') => platforms.reduce((n, p) => n + p[key], 0);
    const coverage: SocialCoverage = !range ? 'unfiltered' : platforms.every((p) => p.filterMode === 'native') ? 'native' : 'provider_limited';
    const durationMs = tracer.elapsed();
    const response: SocialSearchResponse = {
      platform, query, results, nextCursor, nextPageCredits: nextCursor ? pagePrice(Object.keys(nextCursors) as SocialPlatform[]) : 0, credits, platforms,
      rawCount: sum('rawCount'), duplicateCount: sum('duplicateCount'), outOfRangeCount: sum('outOfRangeCount'), missingTimestampCount: sum('missingTimestampCount'),
      timeRange: rangeIso(range), coverage, sessionLimitReached, traceId: tracer.id, durationMs,
    };
    // History is a convenience: a failed save never fails the search the user already paid for.
    await saveSocialSearch(env, principal.userId, req.channel, Boolean(cursor), response).catch((e) => console.error('social search history', e));
    ctx.waitUntil(
      recordUsage(env, { principal, channel: req.channel, kind: 'social_search', target, status: 'ok', httpStatus: 200, credits, durationMs, traceId: tracer.id,
        meta: {
          platform, results: results.length, paged: Boolean(cursor), raw_count: response.rawCount, unique_count: response.rawCount - response.duplicateCount,
          duplicate_count: response.duplicateCount, out_of_range_count: response.outOfRangeCount, missing_timestamp_count: response.missingTimestampCount,
          coverage, time_filter: range ? (range.period ?? 'custom') : null, session_limit_reached: sessionLimitReached,
          platforms: platforms.map((p) => ({ platform: p.platform, count: p.count, raw: p.rawCount, filter_mode: p.filterMode, error: p.error ? p.error.split(':')[0] : null })),
        } }, tracer).catch(() => undefined),
    );
    if (credits > 0) ctx.waitUntil(ingestPolarUsage(env, principal.userId, credits, 'social_search', tracer.id).catch(() => undefined));
    return response;
  } catch (err) {
    if (reserved && !settled) await settleConversion(env, tracer.id, 0).catch(() => undefined);
    // Nothing was returned for this cursor, so it stays usable for a retry.
    if (claimed && !completed) await releaseSession(env, claimed.id, tracer.id).catch(() => undefined);
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

/** The most the next page can cost: the page price of every platform still paging. */
export function nextPageCredits(r: Pick<SocialSearchResponse, 'platform' | 'nextCursor'> & { nextPageCredits?: number }): number {
  if (!r.nextCursor) return 0;
  if (typeof r.nextPageCredits === 'number') return r.nextPageCredits;
  if (r.platform !== 'all') return SOCIAL_SEARCH_CREDITS[r.platform];
  if (isSessionCursor(r.nextCursor)) return SOCIAL_SEARCH_ALL_MAX;
  try {
    return pagePrice(decodeAllCursor(r.nextCursor).map((t) => t.platform));
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
  timeRange: SocialTimeRange | null;
  createdAt: number;
}

/** A saved search with its results, as it was answered. */
export type SavedSocialSearch = SocialSearchResponse & { channel: string; paged: boolean; createdAt: number };

/** The filter details of a page, stored as `filters_json`; rows saved before filters existed have none. */
type SavedFilters = Pick<SocialSearchResponse, 'timeRange' | 'coverage' | 'rawCount' | 'duplicateCount' | 'outOfRangeCount' | 'missingTimestampCount' | 'nextPageCredits' | 'sessionLimitReached'>;

function readFilters(json: string | null): Partial<SavedFilters> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<SavedFilters>) : {};
  } catch {
    return {};
  }
}

async function saveSocialSearch(env: Env, userId: string, channel: Channel, paged: boolean, r: SocialSearchResponse): Promise<void> {
  const filters: SavedFilters = {
    timeRange: r.timeRange, coverage: r.coverage, rawCount: r.rawCount, duplicateCount: r.duplicateCount, outOfRangeCount: r.outOfRangeCount,
    missingTimestampCount: r.missingTimestampCount, nextPageCredits: r.nextPageCredits, sessionLimitReached: r.sessionLimitReached,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO social_searches (id, user_id, platform, query, channel, paged, result_count, credits, results_json, platforms_json, next_cursor, duration_ms, created_at, filters_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(r.traceId, userId, r.platform, r.query, channel, paged ? 1 : 0, r.results.length, r.credits, JSON.stringify(r.results), JSON.stringify(r.platforms), r.nextCursor, r.durationMs, Date.now(), JSON.stringify(filters)),
    env.DB.prepare(
      `DELETE FROM social_searches WHERE user_id = ? AND id NOT IN (SELECT id FROM social_searches WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
    ).bind(userId, userId, SOCIAL_SEARCH_HISTORY_LIMIT),
  ]);
}

/** The user's searches, newest first. */
export async function listSocialSearches(env: Env, userId: string, limit = 50): Promise<SocialSearchHistoryItem[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, platform, query, channel, paged, result_count, credits, created_at, filters_json FROM social_searches WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  ).bind(userId, limit).all<{ id: string; platform: SocialSearchTarget; query: string; channel: string; paged: number; result_count: number; credits: number; created_at: number; filters_json: string | null }>();
  return results.map((r) => ({
    id: r.id, platform: r.platform, query: r.query, channel: r.channel, paged: Boolean(r.paged), resultCount: r.result_count, credits: r.credits,
    timeRange: readFilters(r.filters_json).timeRange ?? null, createdAt: r.created_at,
  }));
}

/** One of the user's saved searches with its results; null when it is not theirs or no longer kept. */
export async function getSocialSearch(env: Env, userId: string, id: string): Promise<SavedSocialSearch | null> {
  const row = await env.DB.prepare('SELECT * FROM social_searches WHERE id = ? AND user_id = ?').bind(id, userId).first<{
    id: string; platform: SocialSearchTarget; query: string; channel: string; paged: number; credits: number; results_json: string; platforms_json: string;
    next_cursor: string | null; duration_ms: number; created_at: number; filters_json: string | null;
  }>();
  if (!row) return null;
  const results: SocialSearchResult[] = JSON.parse(row.results_json);
  const f = readFilters(row.filters_json);
  // Older rows carry only platform, count, credits and error; nothing was filtered then.
  const platforms = (JSON.parse(row.platforms_json) as Partial<SocialPlatformStatus>[]).map((p): SocialPlatformStatus => ({
    platform: p.platform!, count: p.count ?? 0, credits: p.credits ?? 0, error: p.error ?? null, rawCount: p.rawCount ?? p.count ?? 0,
    duplicateCount: p.duplicateCount ?? 0, outOfRangeCount: p.outOfRangeCount ?? 0, missingTimestampCount: p.missingTimestampCount ?? 0, filterMode: p.filterMode ?? 'none',
  }));
  const base = { platform: row.platform, nextCursor: row.next_cursor };
  return {
    platform: row.platform, query: row.query, results, nextCursor: row.next_cursor, nextPageCredits: f.nextPageCredits ?? nextPageCredits(base), credits: row.credits, platforms,
    rawCount: f.rawCount ?? results.length, duplicateCount: f.duplicateCount ?? 0, outOfRangeCount: f.outOfRangeCount ?? 0, missingTimestampCount: f.missingTimestampCount ?? 0,
    timeRange: f.timeRange ?? null, coverage: f.coverage ?? 'unfiltered', sessionLimitReached: f.sessionLimitReached ?? false,
    traceId: row.id, durationMs: row.duration_ms, channel: row.channel, paged: Boolean(row.paged), createdAt: row.created_at,
  };
}

/** JSON body shared by REST and MCP. */
export function socialSearchPayload(r: SocialSearchResponse) {
  return {
    platform: r.platform,
    query: r.query,
    count: r.results.length,
    raw_count: r.rawCount,
    duplicate_count: r.duplicateCount,
    out_of_range_count: r.outOfRangeCount,
    missing_timestamp_count: r.missingTimestampCount,
    time_range: r.timeRange,
    coverage: r.coverage,
    results: r.results.map((x) => ({ platform: x.platform, id: x.id, url: x.url, author: x.author, text: x.text, published_at: x.publishedAt, stats: x.stats, media: x.media })),
    next_cursor: r.nextCursor,
    next_page_credits: r.nextPageCredits,
    session_limit_reached: r.sessionLimitReached,
    credits: r.credits,
    platforms: r.platforms.map((p) => ({
      platform: p.platform, count: p.count, credits: p.credits, error: p.error, raw_count: p.rawCount, duplicate_count: p.duplicateCount,
      out_of_range_count: p.outOfRangeCount, missing_timestamp_count: p.missingTimestampCount, filter_mode: p.filterMode,
    })),
    trace_id: r.traceId,
    duration_ms: r.durationMs,
  };
}
