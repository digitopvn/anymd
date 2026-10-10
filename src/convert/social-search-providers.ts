/**
 * Social search providers: one RapidAPI listing per platform, normalized to one result shape.
 * Hosts, paths and parameter names are fixed here; callers only choose the platform, query and cursor.
 */
import { rapidJson } from './provider-fetch';
import { object, publicUrl, string, type Data } from './social-common';
import type { ConvertContext } from './types';

export const SOCIAL_PLATFORMS = ['x', 'facebook', 'instagram', 'threads', 'linkedin'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface SocialSearchResult {
  platform: SocialPlatform;
  id: string;
  url: string;
  author: { name: string | null; handle: string | null; url: string | null };
  text: string;
  publishedAt: string | null;
  stats: { likes: number | null; replies: number | null; reposts: number | null; views: number | null };
  media: string[];
}
export interface SocialSearchPage {
  results: SocialSearchResult[];
  nextCursor: string | null;
}
type SearchContext = Pick<ConvertContext, 'env' | 'tracer' | 'budget'>;

const MAX_TEXT = 5000;
const MAX_MEDIA = 4;
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.map(object) : []);
const count = (value: unknown): number | null => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const nonEmpty = (value: unknown): string | null => string(value).trim() || null;
function isoDate(value: unknown): string | null {
  const date = typeof value === 'number' ? new Date(value * 1000) : typeof value === 'string' && value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}
const media = (urls: unknown[]): string[] => [...new Set(urls.map(publicUrl).filter(Boolean))].slice(0, MAX_MEDIA);
const stats = (likes: unknown, replies: unknown, reposts: unknown, views: unknown) => ({ likes: count(likes), replies: count(replies), reposts: count(reposts), views: count(views) });
/** Keep only results with a public link and an id; the rest cannot be opened or converted. */
const usable = (r: SocialSearchResult) => Boolean(r.id && r.url);

// ─── X (twitter-api45) ─────────────────────────────────────────────────────

export function parseXSearch(response: unknown): SocialSearchPage {
  const data = object(response);
  const results = list(data.timeline).filter((item) => !item.type || item.type === 'tweet').map((tweet): SocialSearchResult => {
    const user = object(tweet.user_info);
    const handle = string(tweet.screen_name) || string(user.screen_name);
    const id = /^\d+$/.test(string(tweet.tweet_id)) ? string(tweet.tweet_id) : '';
    const photos = list(object(tweet.media).photo).map((photo) => photo.media_url_https);
    return {
      platform: 'x', id, url: id && /^\w+$/.test(handle) ? `https://x.com/${handle}/status/${id}` : '',
      author: { name: nonEmpty(user.name), handle: handle || null, url: /^\w+$/.test(handle) ? `https://x.com/${handle}` : null },
      text: string(tweet.text).slice(0, MAX_TEXT), publishedAt: isoDate(tweet.created_at),
      stats: stats(tweet.favorites, tweet.replies, tweet.retweets, tweet.views), media: media(photos),
    };
  }).filter(usable);
  return { results, nextCursor: results.length ? nonEmpty(data.next_cursor) : null };
}

// ─── Facebook (facebook-scraper3) ──────────────────────────────────────────

export function parseFacebookSearch(response: unknown): SocialSearchPage {
  const data = object(response);
  const results = list(data.results).map((post): SocialSearchResult => {
    const author = object(post.author);
    return {
      platform: 'facebook', id: string(post.post_id), url: publicUrl(post.url),
      author: { name: nonEmpty(author.name), handle: null, url: publicUrl(author.url) || null },
      text: string(post.message).slice(0, MAX_TEXT), publishedAt: isoDate(post.timestamp),
      stats: stats(post.reactions_count, post.comments_count, post.reshare_count, post.video_view_count),
      media: media([object(post.image).uri, object(post.video_thumbnail).uri]),
    };
  }).filter(usable);
  return { results, nextCursor: results.length ? nonEmpty(data.cursor) : null };
}

// ─── Instagram (instagram-pro-and-cheap-api) ───────────────────────────────

export function parseInstagramSearch(response: unknown): SocialSearchPage {
  const data = object(response);
  const results = list(data.items).map((item): SocialSearchResult => {
    const owner = object(item.owner);
    const username = string(owner.username);
    return {
      platform: 'instagram', id: string(item.shortcode), url: publicUrl(item.url),
      author: { name: nonEmpty(owner.full_name), handle: username || null, url: /^[\w.]+$/.test(username) ? `https://www.instagram.com/${username}/` : null },
      text: string(item.caption).slice(0, MAX_TEXT), publishedAt: isoDate(item.taken_at),
      stats: stats(item.like_count, item.comment_count, null, item.view_count ?? item.play_count),
      media: media([item.thumbnail_url ?? item.display_url]),
    };
  }).filter(usable);
  return { results, nextCursor: results.length && data.has_more !== false ? nonEmpty(data.next_cursor) : null };
}

// ─── Threads (threads-api4) ────────────────────────────────────────────────

export function parseThreadsSearch(response: unknown): SocialSearchPage {
  const search = object(object(object(response).data).searchResults);
  const results = list(search.edges).map((edge): SocialSearchResult => {
    const post = object(list(object(object(edge.node).thread).thread_items)[0]?.post);
    const user = object(post.user);
    const username = string(user.username);
    const code = string(post.code);
    const info = object(post.text_post_app_info);
    const candidates = list(object(post.image_versions2).candidates);
    const ok = /^[\w.]+$/.test(username) && /^[\w-]+$/.test(code) && user.text_post_app_is_private !== true;
    return {
      platform: 'threads', id: string(post.pk) || code, url: ok ? `https://www.threads.net/@${username}/post/${code}` : '',
      author: { name: nonEmpty(user.full_name), handle: username || null, url: /^[\w.]+$/.test(username) ? `https://www.threads.net/@${username}` : null },
      text: string(object(post.caption).text).slice(0, MAX_TEXT), publishedAt: isoDate(post.taken_at),
      stats: stats(post.like_count, info.direct_reply_count, info.repost_count, null), media: media([candidates[0]?.url]),
    };
  }).filter(usable);
  // The provider answers one page per query (page_info never offers a next page).
  return { results, nextCursor: null };
}

// ─── LinkedIn (fresh-linkedin-profile-data) ────────────────────────────────

export function parseLinkedInSearch(response: unknown): SocialSearchPage {
  const results = list(object(response).data).map((post): SocialSearchResult => ({
    platform: 'linkedin', id: string(post.urn) || string(post.share_urn), url: publicUrl(post.post_url),
    author: { name: nonEmpty(post.poster_name), handle: null, url: publicUrl(post.poster_linkedin_url) || null },
    // The provider reports UTC timestamps without a zone.
    text: string(post.text).slice(0, MAX_TEXT), publishedAt: isoDate(string(post.posted) ? `${string(post.posted).replace(' ', 'T')}Z` : ''),
    stats: stats(post.num_likes, post.num_comments, post.num_shares, null),
    media: media(list(post.images).map((image) => image.url)),
  })).filter(usable);
  // The endpoint dropped `page` for a result `limit`, so there is no next page to ask for.
  return { results, nextCursor: null };
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

const THREADS_HOST = 'threads-api4.p.rapidapi.com';
/** Providers that answer a single page per query; a cursor for them is an empty, free page. */
const SINGLE_PAGE: ReadonlySet<SocialPlatform> = new Set(['threads', 'linkedin']);

async function searchThreads(query: string, ctx: SearchContext): Promise<SocialSearchPage> {
  const recent = parseThreadsSearch(await rapidJson(THREADS_HOST, '/api/search/recent', { query }, ctx, { allowEmpty: true }));
  // The recent tab is often empty for a query the top tab answers; fall back once.
  if (recent.results.length) return recent;
  return parseThreadsSearch(await rapidJson(THREADS_HOST, '/api/search/top', { query }, ctx, { allowEmpty: true }));
}

export async function searchPlatform(platform: SocialPlatform, query: string, cursor: string | undefined, ctx: SearchContext): Promise<SocialSearchPage> {
  if (cursor && SINGLE_PAGE.has(platform)) return { results: [], nextCursor: null };
  switch (platform) {
    case 'x':
      return parseXSearch(await rapidJson('twitter-api45.p.rapidapi.com', '/search.php', { query, search_type: 'Latest', ...(cursor ? { cursor } : {}) }, ctx, { allowEmpty: true }));
    case 'facebook':
      return parseFacebookSearch(await rapidJson('facebook-scraper3.p.rapidapi.com', '/search/posts', { query, ...(cursor ? { cursor } : {}) }, ctx, { allowEmpty: true }));
    case 'instagram':
      return parseInstagramSearch(await rapidJson('instagram-pro-and-cheap-api.p.rapidapi.com', '/v1/search/posts', { query, ...(cursor ? { cursor } : {}) }, ctx, { allowEmpty: true }));
    case 'threads':
      return searchThreads(query, ctx);
    case 'linkedin': {
      const body = { search_keywords: query, sort_by: 'Latest', date_posted: '', content_type: '', from_member: [], from_company: [], mentioning_member: [], mentioning_company: [], author_company: [], author_industry: [], author_keyword: '' };
      return parseLinkedInSearch(await rapidJson('fresh-linkedin-profile-data.p.rapidapi.com', '/search-posts', {}, ctx, { body, allowEmpty: true }));
    }
  }
}
