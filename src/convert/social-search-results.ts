/**
 * Social search result shaping: time ranges, exact post identity, de-duplication and date filtering.
 * Pure functions only; `social-search.ts` orchestrates them with providers, billing and the paging session.
 */
import type { SocialPlatform, SocialSearchResult } from './social-search-providers';
import { ConvertError } from './types';

export const SOCIAL_SEARCH_PERIODS = ['24h', '7d', '30d'] as const;
export type SocialSearchPeriod = (typeof SOCIAL_SEARCH_PERIODS)[number];
const PERIOD_MS: Record<SocialSearchPeriod, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

/** Longest custom range (both ends given). */
export const MAX_RANGE_DAYS = 366;
/** Earliest accepted lower bound; nothing older is searchable on these platforms in practice. */
const MIN_TIME = Date.UTC(2004, 0, 1);

/** A resolved, absolute half-open UTC interval `[since, until)` in milliseconds; null ends are open. */
export interface TimeRange {
  period: SocialSearchPeriod | null;
  since: number | null;
  until: number | null;
}

const invalid = (message: string) => new ConvertError(`Invalid social search: ${message}`, 400, 'invalid_request');

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2})))?$/;

/**
 * Parse an ISO-8601 timestamp with an explicit zone (`Z` or `±HH:MM`), or a bare `YYYY-MM-DD` read as UTC midnight.
 * Rejects calendar dates that do not exist (2026-02-30) and out-of-range offsets instead of letting `Date` roll them over.
 */
export function parseTimestamp(value: string, field: string): number {
  const m = ISO.exec(value.trim());
  if (!m) throw invalid(`${field} must be an ISO-8601 timestamp with a zone, like 2026-10-01T00:00:00Z, or a date like 2026-10-01`);
  const [, y, mo, d, h = '0', mi = '0', s = '0', ms = '0', zone, oh = '0', om = '0'] = m;
  if (m[4] !== undefined && !zone) throw invalid(`${field} needs a zone (Z or ±HH:MM)`);
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)];
  const utc = Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], Number(ms.padEnd(3, '0')));
  const check = new Date(utc);
  const exists = check.getUTCFullYear() === parts[0] && check.getUTCMonth() === parts[1] && check.getUTCDate() === parts[2]
    && check.getUTCHours() === parts[3] && check.getUTCMinutes() === parts[4] && check.getUTCSeconds() === parts[5];
  if (!exists) throw invalid(`${field} is not a real date and time`);
  const offH = Number(oh);
  const offM = Number(om);
  if (offH > 14 || offM > 59 || (offH === 14 && offM > 0)) throw invalid(`${field} has an invalid time zone offset`);
  const offset = zone && zone !== 'Z' ? (zone.startsWith('-') ? -1 : 1) * (offH * 60 + offM) * 60_000 : 0;
  return utc - offset;
}

/**
 * Resolve the request's time filter once, against `now`. A `period` becomes an absolute range here, so paging keeps
 * the same window instead of sliding with each page. Returns null when no filter was asked for.
 */
export function resolveTimeRange(input: { period?: SocialSearchPeriod; since?: string; until?: string }, now: number): TimeRange | null {
  const { period, since, until } = input;
  if (period && (since || until)) throw invalid('use either period or since/until, not both');
  if (period) return { period, since: now - PERIOD_MS[period], until: now };
  if (!since && !until) return null;
  const s = since ? parseTimestamp(since, 'since') : null;
  const u = until ? parseTimestamp(until, 'until') : null;
  if (s !== null && s < MIN_TIME) throw invalid('since is too far in the past');
  if (u !== null && u <= MIN_TIME) throw invalid('until is too far in the past');
  if (s !== null && s >= now) throw invalid('since is in the future');
  if (s !== null && u !== null && s >= u) throw invalid('since must be before until');
  if (s !== null && u !== null && u - s > MAX_RANGE_DAYS * 86_400_000) throw invalid(`the time range can span at most ${MAX_RANGE_DAYS} days`);
  return { period: null, since: s, until: u };
}

/** Whether a request's own filter agrees with the range a cursor was issued for. Omitting the filter inherits it. */
export function sameRequestedRange(input: { period?: SocialSearchPeriod; since?: string; until?: string }, range: TimeRange | null): boolean {
  const { period, since, until } = input;
  if (!period && !since && !until) return true;
  if (!range) return false;
  if (period) return range.period === period && !since && !until;
  if (range.period) return false;
  const s = since ? parseTimestamp(since, 'since') : null;
  const u = until ? parseTimestamp(until, 'until') : null;
  return s === range.since && u === range.until;
}

export const rangeIso = (range: TimeRange | null) =>
  range ? { period: range.period, since: range.since === null ? null : new Date(range.since).toISOString(), until: range.until === null ? null : new Date(range.until).toISOString() } : null;

// ─── Exact identity ────────────────────────────────────────────────────────

/** Query parameters that only track clicks or sharers; they never change which post a URL points at. */
const TRACKING = /^(utm_\w+|fbclid|gclid|igshid|igsh|mibextid|si|s|t|ref|ref_src|ref_url|rcm|__cft__.*|__tn__|_rdr|sharer|share_id|trk|trackingid|lipi)$/i;
const HOST_ALIASES: Record<string, string> = { 'twitter.com': 'x.com', 'threads.com': 'threads.net', 'instagr.am': 'instagram.com', 'fb.com': 'facebook.com', 'lnkd.in': 'linkedin.com' };

/** A conservative canonical form: lower-case host without `www.`/`m.`/`mobile.`, no fragment, no tracking params, sorted params, no trailing slash. */
export function canonicalPostUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  let host = url.hostname.toLowerCase().replace(/^(www|m|mobile|web)\./, '');
  host = HOST_ALIASES[host] ?? host;
  const params = [...url.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `https://${host}${path}${query}`;
}

/** The id a post URL names, for the URL shapes each platform uses for a single post; null for profiles and anything else. */
export function postIdFromUrl(platform: SocialPlatform, raw: string): string | null {
  const canonical = canonicalPostUrl(raw);
  if (!canonical) return null;
  const url = new URL(canonical);
  const path = url.pathname;
  switch (platform) {
    case 'x':
      return url.hostname === 'x.com' ? (/^\/(?:\w+|i\/web|i)\/status(?:es)?\/(\d+)$/.exec(path)?.[1] ?? null) : null;
    case 'instagram':
      return url.hostname === 'instagram.com' ? (/^\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)$/.exec(path)?.[1] ?? null) : null;
    case 'threads':
      return url.hostname === 'threads.net' ? (/^\/@[\w.]+\/post\/([\w-]+)$/.exec(path)?.[1] ?? null) : null;
    case 'linkedin':
      return url.hostname === 'linkedin.com'
        ? (/^\/feed\/update\/urn:li:(?:activity|share|ugcPost):(\d+)$/.exec(path)?.[1] ?? /^\/posts\/[^/]*?-(?:activity|share|ugcpost)-(\d+)-[\w-]+$/i.exec(path)?.[1] ?? null)
        : null;
    case 'facebook':
      return null;
  }
}

/**
 * The exact identity of a post: the platform plus its stable post id where one is known, otherwise its canonical URL.
 * Different platforms never share a key, so the same text cross-posted to X and Threads stays two posts.
 */
export function postKey(r: SocialSearchResult): string {
  const fromUrl = postIdFromUrl(r.platform, r.url);
  switch (r.platform) {
    case 'x':
      // Tweet ids are numeric and identical across twitter.com/x.com/i/web URLs.
      if (/^\d+$/.test(r.id)) return `x:${r.id}`;
      break;
    case 'instagram':
    case 'threads':
      // The shortcode in the URL is the stable public identity; provider ids mix numeric pks and shortcodes.
      if (fromUrl) return `${r.platform}:${fromUrl}`;
      break;
    case 'linkedin': {
      const id = /(\d{6,})/.exec(r.id)?.[1] ?? fromUrl;
      if (id) return `linkedin:${id}`;
      break;
    }
    case 'facebook':
      // Facebook post URLs come in many shapes (pfbid, permalink.php, groups); the provider's post_id is stable.
      if (/^[\w:.-]+$/.test(r.id)) return `facebook:${r.id}`;
      break;
  }
  if (fromUrl) return `${r.platform}:${fromUrl}`;
  return `${r.platform}:url:${boundedKey(canonicalPostUrl(r.url) ?? r.url)}`;
}

/** Keeps URL keys short so a session's remembered posts stay small: long URLs keep a prefix plus a hash of the whole. */
function boundedKey(value: string): string {
  if (value.length <= 160) return value;
  // FNV-1a, twice with different seeds: 64 bits are plenty to tell apart the posts of one search.
  const fnv = (seed: number) => {
    let h = seed;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, '0');
  };
  return `${value.slice(0, 120)}#${fnv(0x811c9dc5)}${fnv(0x01000193)}`;
}

/** How complete a result is; the most complete copy of a duplicate is kept. Engagement counts are never summed. */
function completeness(r: SocialSearchResult): number {
  const stats = Object.values(r.stats).filter((n) => n !== null).length;
  return (r.publishedAt ? 8 : 0) + (r.text ? 4 : 0) + Math.min(r.media.length, 4) + stats + (r.author.name ? 1 : 0) + (r.author.url ? 1 : 0);
}
const better = (a: SocialSearchResult, b: SocialSearchResult) => completeness(a) - completeness(b) || (a.url < b.url ? 1 : a.url > b.url ? -1 : 0);

// ─── Filtering a page ──────────────────────────────────────────────────────

export interface FilterCounts {
  /** Posts the provider returned (after dropping entries without a usable link). */
  raw: number;
  /** Same post as an earlier one on this page or on an earlier page of this search. */
  duplicates: number;
  /** Dated posts outside the time range. */
  outOfRange: number;
  /** Posts without a usable date while a time range is active; they are not treated as recent. */
  missingTimestamp: number;
}

/**
 * Exact de-duplication (within the page and against `seen`), then the UTC half-open `[since, until)` check.
 * Keeps the provider's order and the first position of each post; `raw = kept + duplicates + outOfRange + missingTimestamp`.
 */
export function filterPage(results: SocialSearchResult[], range: TimeRange | null, seen: ReadonlySet<string>): { kept: SocialSearchResult[]; keys: string[]; counts: FilterCounts } {
  const counts: FilterCounts = { raw: results.length, duplicates: 0, outOfRange: 0, missingTimestamp: 0 };
  const firstAt = new Map<string, number>();
  const unique: { key: string; r: SocialSearchResult }[] = [];
  for (const r of results) {
    const key = postKey(r);
    if (seen.has(key)) {
      counts.duplicates++;
      continue;
    }
    const at = firstAt.get(key);
    if (at === undefined) {
      firstAt.set(key, unique.length);
      unique.push({ key, r });
      continue;
    }
    counts.duplicates++;
    if (better(r, unique[at].r) > 0) unique[at] = { key, r };
  }
  const kept: SocialSearchResult[] = [];
  const keys: string[] = [];
  for (const { key, r } of unique) {
    if (range) {
      const time = r.publishedAt ? Date.parse(r.publishedAt) : Number.NaN;
      if (Number.isNaN(time)) {
        counts.missingTimestamp++;
        continue;
      }
      if ((range.since !== null && time < range.since) || (range.until !== null && time >= range.until)) {
        counts.outOfRange++;
        continue;
      }
    }
    kept.push(r);
    keys.push(key);
  }
  return { kept, keys, counts };
}

/** Newest first; posts without a date keep their provider order after the dated ones. */
export function mergeNewestFirst(pages: SocialSearchResult[][]): SocialSearchResult[] {
  const time = (r: SocialSearchResult) => (r.publishedAt ? Date.parse(r.publishedAt) : Number.NEGATIVE_INFINITY);
  return pages.flat().map((r, i) => ({ r, i })).sort((a, b) => time(b.r) - time(a.r) || a.i - b.i).map(({ r }) => r);
}

// ─── Calendar dates in a time zone (dashboard date pickers) ────────────────

/** A valid IANA time zone name, or UTC. */
export function safeTimeZone(tz: string | undefined): string {
  if (!tz || tz.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Milliseconds `timeZone` is ahead of UTC at instant `t`. */
function zoneOffset(t: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).map((p) => [p.type, p.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(t / 1000) * 1000;
}

/**
 * The UTC instant a calendar day (`YYYY-MM-DD`, plus `addDays`) starts in `timeZone`, as ISO-8601; null for a malformed date.
 * Re-checks the offset at the result so days that start inside a DST change land correctly.
 */
export function zonedDayStart(date: string, timeZone: string, addDays = 0): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject days that do not exist (2026-02-30) instead of rolling them over.
  if (Number.isNaN(day) || new Date(day).toISOString().slice(0, 10) !== date) return null;
  const guess = day + addDays * 86_400_000;
  const first = guess - zoneOffset(guess, timeZone);
  return new Date(guess - zoneOffset(first, timeZone)).toISOString();
}
