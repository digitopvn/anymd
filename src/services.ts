/**
 * Operations shared by the REST API, MCP server and dashboard, so every channel returns the same
 * shapes and records usage the same way.
 */
import { getUser } from './auth/identity';
import type { Env, Principal } from './env';
import type { ConvertResponse } from './convert/service';
import { searchLibrary, SEARCH_MODES, type SearchMode, type SearchResponse } from './library/search';
import { quotaState, recordUsage, type Channel } from './lib/usage';
import { Tracer } from './lib/tracer';
import { newId } from './lib/util';

/** JSON body for a conversion (URL API `?format=json`, POST /api/v1/convert, MCP). */
export function convertPayload(r: ConvertResponse) {
  const x = r.result;
  return {
    url: x.source,
    title: x.title,
    author: x.author || null,
    published: x.published || null,
    description: x.description || null,
    domain: x.domain,
    site: x.site ?? null,
    image: x.image ?? null,
    language: x.language ?? null,
    kind: x.sourceKind,
    word_count: x.wordCount,
    source_bytes: x.sourceBytes ?? null,
    markdown: r.markdown,
    content: x.content,
    document_id: r.documentId,
    saved: r.documentId !== null,
    // Why the conversion is not in the library; `missing_scope` means the credential lacks library:write.
    not_saved_reason: r.notSavedReason,
    credits: r.credits,
    credit_breakdown: r.creditBreakdown ?? { base: r.credits, thread: 0, comments: 0, images: 0 },
    enrichment: x.enrichment ?? {},
    reading_options: r.readingOptions,
    cached: r.cached,
    trace_id: r.traceId,
    duration_ms: r.durationMs,
    // Present only for YouTube reads with the downloadVideo preference on: poll check_url until ready or failed.
    ...(r.videoDownload ? { video_download: r.videoDownload } : {}),
    ...(x.sourceKind === 'x' ? { stats: { likes: x.likes ?? null, retweets: x.retweets ?? null, replies: x.replies ?? null, views: x.views ?? null } } : {}),
  };
}

export function parseMode(raw: unknown): SearchMode {
  return SEARCH_MODES.includes(raw as SearchMode) ? (raw as SearchMode) : 'hybrid';
}

const PAID_PLANS = new Set(['pro', 'scale', 'enterprise']);

/**
 * Search the caller's library and log it (0 credits). Query fan-out and Jev tie-breaking are
 * Pro+ features; on Free they are skipped and reported in `gated`.
 */
export async function searchForPrincipal(
  env: Env,
  principal: Principal,
  channel: Channel,
  q: string,
  opts: { mode?: unknown; limit?: unknown; fanout?: boolean; decide?: boolean },
): Promise<SearchResponse & { gated: string[] }> {
  const user = await getUser(env, principal.userId!);
  const paid = PAID_PLANS.has(user?.plan ?? 'free') || principal.role === 'owner' || principal.role === 'admin';
  const gated: string[] = [];
  if (!paid && opts.fanout) gated.push('fanout');
  if (!paid && opts.decide) gated.push('decide');
  const tracer = new Tracer(newId('trc_'));
  const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 50);
  const result = await searchLibrary(env, principal.userId!, q, { mode: parseMode(opts.mode), limit, fanout: paid && Boolean(opts.fanout), decide: paid && Boolean(opts.decide) }, tracer);
  await recordUsage(
    env,
    { principal, channel, kind: 'search', target: q.slice(0, 200), status: 'ok', httpStatus: 200, credits: 0, durationMs: tracer.elapsed(), traceId: tracer.id },
    tracer,
  ).catch(() => undefined);
  return { ...result, gated };
}

export async function usageSummary(env: Env, userId: string, planId: string, days = 30) {
  const since = Date.now() - Math.min(Math.max(days, 1), 90) * 86400_000;
  const [quota, daily, totals, events, byChannel] = await Promise.all([
    quotaState(env, userId, planId),
    env.DB.prepare(
      "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COALESCE(SUM(credits),0) AS credits, COUNT(*) AS n FROM usage_events WHERE user_id = ? AND created_at >= ? GROUP BY day ORDER BY day",
    )
      .bind(userId, since)
      .all<{ day: string; credits: number; n: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS requests, COALESCE(SUM(credits),0) AS credits, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors, SUM(CASE WHEN status='cached' THEN 1 ELSE 0 END) AS cached FROM usage_events WHERE user_id = ? AND created_at >= ?",
    )
      .bind(userId, since)
      .first<{ requests: number; credits: number; errors: number; cached: number }>(),
    env.DB.prepare('SELECT id,channel,kind,target,status,http_status,credits,duration_ms,trace_id,error,created_at FROM usage_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
      .bind(userId)
      .all<{ id: string; channel: string; kind: string; target: string; status: string; http_status: number; credits: number; duration_ms: number; trace_id: string | null; error: string | null; created_at: number }>(),
    env.DB.prepare('SELECT channel, COUNT(*) AS n, COALESCE(SUM(credits),0) AS credits FROM usage_events WHERE user_id = ? AND created_at >= ? GROUP BY channel ORDER BY n DESC')
      .bind(userId, since)
      .all<{ channel: string; n: number; credits: number }>(),
  ]);
  return {
    plan: planId,
    quota,
    totals: { requests: totals?.requests ?? 0, credits: totals?.credits ?? 0, errors: totals?.errors ?? 0, cached: totals?.cached ?? 0 },
    daily: daily.results,
    by_channel: byChannel.results,
    events: events.results,
  };
}
