import { ENRICHMENT_CREDITS } from '../billing/plans';
import { rapidJson } from './provider-fetch';
import { fetchTweetData } from './x-twitter';
import { ConvertError, type ConvertContext, type ConvertResult } from './types';
import type { Coverage } from './enrichment-types';
import { quote } from './social-common';

interface Tweet {
  id: string;
  parent: string;
  conversation: string;
  authorId: string;
  handle: string;
  text: string;
}
const HOST = 'twitter-api45.p.rapidapi.com';
type RecordData = Record<string, unknown>;
function record(value: unknown): RecordData { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {}; }
function str(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function parseTweet(value: unknown): Tweet | null {
  const data = record(value);
  const author = record(data.author ?? data.user_info);
  const id = str(data.id ?? data.tweet_id);
  const handle = str(author.screen_name ?? data.screen_name);
  const authorId = str(author.rest_id);
  if (!/^\d+$/.test(id) || !/^\w+$/.test(handle) || !authorId) return null;
  return { id, parent: str(data.in_reply_to_status_id_str), conversation: str(data.conversation_id),
    authorId, handle, text: str(data.text) };
}
const tweetUrl = (tweet: Tweet) => `https://x.com/${tweet.handle}/status/${tweet.id}`;
const coverage = (): Coverage => ({ complete: true, count: 1, fetchedAt: new Date().toISOString() });

/** A same-author post belongs only if its parent is already in the rooted chain. */
export function threadMembers(root: Tweet, candidates: Tweet[]): Tweet[] {
  const members = new Map([[root.id, root]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (candidate.authorId === root.authorId && candidate.conversation === root.conversation && members.has(candidate.parent) && !members.has(candidate.id)) {
        members.set(candidate.id, candidate); changed = true;
      }
    }
  }
  return [...members.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
}

async function getTweet(id: string, ctx: ConvertContext): Promise<Tweet> {
  const tweet = parseTweet(await rapidJson(HOST, '/tweet.php', { id }, ctx));
  if (!tweet || tweet.id !== id) throw new ConvertError('Post data unavailable', 502, 'upstream_schema');
  return tweet;
}

export async function enrichX(result: ConvertResult, ctx: ConvertContext): Promise<void> {
  if (!ctx.authenticated || !ctx.budget) return;
  const state = coverage();
  result.enrichment = { thread: state };
  const initialId = result.source.match(/\/status\/(\d+)/)?.[1];
  if (!initialId) return;
  try {
    const initial = await getTweet(initialId, ctx);
    let root = initial;
    const ancestors = [initial];
    const visited = new Set([root.id]);
    while (root.parent) {
      if (!ctx.budget.canSpend(ancestors.length * ENRICHMENT_CREDITS.threadPost)) {
        state.complete = false; state.reason = 'credit_limit'; break;
      }
      if (visited.has(root.parent)) throw new ConvertError('Invalid thread relationship', 502, 'upstream_schema');
      const parent = await getTweet(root.parent, ctx);
      if (parent.authorId !== initial.authorId) break;
      if (parent.conversation !== initial.conversation) throw new ConvertError('Invalid thread conversation', 502, 'upstream_schema');
      visited.add(parent.id); ancestors.push(parent); root = parent;
    }
    const candidates = [...ancestors];
    let cursor = '';
    const cursors = new Set<string>();
    do {
      if (!ctx.budget.canSpend((candidates.length) * ENRICHMENT_CREDITS.threadPost)) { state.complete = false; state.reason = 'credit_limit'; break; }
      const data = record(await rapidJson(HOST, '/search.php', {
        query: `conversation_id:${root.conversation || root.id} from:${root.handle}`, search_type: 'Latest', ...(cursor ? { cursor } : {}),
      }, ctx));
      if (!Array.isArray(data.timeline)) throw new ConvertError('Thread search data unavailable', 502, 'upstream_schema');
      const rows = data.timeline.map(parseTweet).filter((row): row is Tweet => row !== null);
      if (rows.length < data.timeline.length) { state.complete = false; state.reason = 'source_incomplete'; }
      for (const row of rows) if (!candidates.some((item) => item.id === row.id)) candidates.push(row);
      cursor = str(data.next_cursor);
      if (!rows.length) { if (cursor) { state.complete = false; state.reason = 'source_incomplete'; } break; }
      if (cursor && cursors.has(cursor)) { state.complete = false; state.reason = 'source_incomplete'; break; }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const members = threadMembers(root, candidates);
    const parts: string[] = [];
    for (const tweet of members) {
      if (tweet.id !== initial.id && !ctx.budget.canSpend(ENRICHMENT_CREDITS.threadPost)) { state.complete = false; state.reason = 'credit_limit'; break; }
      try {
        if (tweet.id !== initial.id && !ctx.budget.canFetch()) throw new ConvertError('Processing limit', 408, 'processing_limit');
        if (tweet.id !== initial.id) ctx.budget.calls++;
        const post = tweet.id === initial.id ? result : await fetchTweetData(tweetUrl(tweet), ctx.budget.deadline - Date.now());
        result.articleImageUrls = [...new Set([...(result.articleImageUrls ?? []), ...(post.articleImageUrls ?? [])])];
        if (tweet.id !== initial.id) ctx.budget.charge('thread', ENRICHMENT_CREDITS.threadPost);
        parts.push(`### [Post ${parts.length + 1}](${tweetUrl(tweet)})\n\n${post.content}`);
      } catch { state.complete = false; state.reason = 'source_incomplete'; }
    }
    if (parts.length && members.some((tweet) => tweet.id === initial.id)) {
      // Never replace the requested post if a budget exhausted before rendering it.
      if (!parts.some((part) => part.includes(`](${tweetUrl(initial)})`))) parts.push(`### [Requested post](${tweetUrl(initial)})\n\n${result.content}`);
      result.content = parts.join('\n\n---\n\n');
      state.count = parts.length;
    }
    if (ctx.includeComments) await xComments(result, root, new Set(members.map((row) => row.id)), ctx);
  } catch (error) {
    state.complete = false;
    state.reason = error instanceof ConvertError ? error.code : 'source_incomplete';
    if (ctx.includeComments && !result.enrichment.comments) result.enrichment.comments = { ...coverage(), count: 0, complete: false, reason: state.reason, markdown: '' };
  }
}

async function xComments(result: ConvertResult, root: Tweet, threadIds: Set<string>, ctx: ConvertContext): Promise<void> {
  const state = { ...coverage(), count: 0, markdown: '' };
  result.enrichment!.comments = state;
  const candidates = new Map<string, Tweet>();
  let cursor = '';
  const cursors = new Set<string>();
  const limit = ctx.maxComments ?? 100;
  const conversation = root.conversation || root.id;
  try {
    do {
      if (!ctx.budget!.canSpend(ENRICHMENT_CREDITS.commentBatch)) { state.complete = false; state.reason = 'credit_limit'; break; }
      const data = record(await rapidJson(HOST, '/search.php', { query: `conversation_id:${conversation}`, search_type: 'Latest', ...(cursor ? { cursor } : {}) }, ctx));
      if (!Array.isArray(data.timeline)) throw new ConvertError('Comment data unavailable', 502, 'upstream_schema');
      for (const row of data.timeline) {
        const tweet = parseTweet(row);
        if (!tweet) { state.complete = false; state.reason = 'source_incomplete'; continue; }
        if (!threadIds.has(tweet.id) && tweet.conversation === conversation) candidates.set(tweet.id, tweet);
      }
      cursor = str(data.next_cursor);
      if (!data.timeline.length || (cursor && cursors.has(cursor))) { if (cursor) { state.complete = false; state.reason = 'source_incomplete'; } break; }
      if (cursor) cursors.add(cursor);
      // Non-root author threads need parent relationships from later pages, bounded by the processing limit.
      if (candidates.size >= (root.id === conversation ? limit : 4000)) {
        if (cursor) { state.complete = false; state.reason = 'comment_limit'; }
        break;
      }
    } while (cursor);
  } catch (error) { state.complete = false; state.reason = error instanceof ConvertError ? error.code : 'source_incomplete'; }
  const reachable = new Set(threadIds);
  if (root.id === conversation) for (const id of candidates.keys()) reachable.add(id);
  else {
    let changed = true;
    while (changed) {
      changed = false;
      for (const tweet of candidates.values()) if (reachable.has(tweet.parent) && !reachable.has(tweet.id)) {
        reachable.add(tweet.id); changed = true;
      }
    }
    if (!state.complete && candidates.size && reachable.size === threadIds.size) state.reason = 'source_incomplete';
  }
  const comments: Tweet[] = [];
  for (const tweet of candidates.values()) {
    if (!reachable.has(tweet.id)) continue;
    if (comments.length >= limit) { state.complete = false; state.reason = 'comment_limit'; break; }
    if (comments.length % ENRICHMENT_CREDITS.commentsPerBatch === 0) {
      if (!ctx.budget!.canSpend(ENRICHMENT_CREDITS.commentBatch)) { state.complete = false; state.reason = 'credit_limit'; break; }
      ctx.budget!.charge('comments', ENRICHMENT_CREDITS.commentBatch);
    }
    comments.push(tweet);
  }
  state.count = comments.length;
  state.markdown = comments.map((tweet) => `**[@${tweet.handle}](${tweetUrl(tweet)})**${tweet.parent ? ` · Reply to ${tweet.parent}` : ''}\n\n${quote(tweet.text)}`).join('\n\n');
}
