import { rapidJson } from './provider-fetch';
import { collectComments, object, requireSocialAccount, socialResult, string, type Data, type SocialComment } from './social-common';
import { ConvertError, type SourceAdapter } from './types';

const HOST = 'threads-api4.p.rapidapi.com';
export function shortcodeId(code: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  if (!/^[A-Za-z0-9_-]{5,20}$/.test(code)) throw new ConvertError('Invalid post shortcode', 400, 'invalid_url');
  return [...code].reduce((id, char) => id * 64n + BigInt(alphabet.indexOf(char)), 0n).toString();
}
function posts(node: Data): Data[] {
  return Array.isArray(node.thread_items) ? node.thread_items.map((item) => object(object(item).post)) : [];
}
function image(post: Data): string {
  const candidates = object(post.image_versions2).candidates;
  return Array.isArray(candidates) ? string(object(candidates[0]).url) : '';
}
function dataOf(response: unknown): Data {
  const envelope = object(response);
  const data = object(object(envelope.data).data);
  if (envelope.error || !Array.isArray(data.edges)) throw new ConvertError('Threads provider could not retrieve this post', 502, 'upstream_error');
  return data;
}
export const threadsAdapter: SourceAdapter = {
  kind: 'threads',
  matches: (url) => /(^|\.)threads\.(net|com)$/.test(url.hostname),
  async convert(url, ctx) {
    requireSocialAccount(ctx);
    const code = url.pathname.match(/^\/@[^/]+\/post\/([\w-]+)/)?.[1];
    if (!code) throw new ConvertError('Use a Threads post URL', 400, 'invalid_url');
    const id = shortcodeId(code);
    const data = dataOf(await rapidJson(HOST, '/api/post/detail', { post_id: id }, ctx));
    const members = (data.edges as unknown[]).flatMap((edge) => posts(object(object(edge).node)));
    const post = members.find((item) => string(item.pk) === id);
    if (!post || object(post.user).text_post_app_is_private === true) throw new ConvertError('Public Threads post unavailable', 404, 'not_found');
    const media = Array.isArray(post.carousel_media) ? post.carousel_media.map(object) : [post];
    const result = socialResult(url, 'threads', string(object(post.caption).text), string(object(post.user).username), ctx.removeImages ? [] : media.map(image),
      typeof post.taken_at === 'number' ? new Date(post.taken_at * 1000).toISOString() : '');
    const queue: { id: string; cursor: string }[] = [{ id, cursor: '' }];
    const expanded = new Set([id]);
    const seenCursors = new Set<string>();
    let pageNumber = 0;
    await collectComments(result, ctx, async () => {
      const job = queue.shift()!;
      const page = dataOf(await rapidJson(HOST, '/api/post/comments', { post_id: job.id, ...(job.cursor ? { end_cursor: job.cursor } : {}) }, ctx));
      if (!Array.isArray(page.edges)) throw new ConvertError('Comment data unavailable', 502, 'upstream_schema');
      const items: SocialComment[] = [];
      let complete = page.show_unavailable_replies_disclaimer !== true;
      const replies = page.edges.flatMap((edge) => posts(object(object(edge).node)));
      const focus = replies.findIndex((reply) => string(reply.pk) === job.id);
      if (!job.cursor && focus < 0) throw new ConvertError('Comment context unavailable', 502, 'upstream_schema');
      // First pages include ancestors and the focused post before its replies.
      for (const reply of replies.slice(focus + 1)) {
        const replyId = string(reply.pk);
        if (!replyId) { complete = false; continue; }
        if (replyId === job.id || replyId === id) continue;
        if (object(reply.text_post_app_info).is_reply !== true) { complete = false; continue; }
        if (object(reply.user).text_post_app_is_private === true) { complete = false; continue; }
        items.push({ id: replyId, parent: job.id, author: string(object(reply.user).username), text: string(object(reply.caption).text) });
        if (Number(object(reply.text_post_app_info).direct_reply_count) > 0 && !expanded.has(replyId)) {
          expanded.add(replyId); queue.push({ id: replyId, cursor: '' });
        }
      }
      const pageInfo = object(page.page_info);
      if (pageInfo.has_next_page === true) {
        const cursor = string(pageInfo.end_cursor);
        const key = `${job.id}:${cursor}`;
        if (!cursor || seenCursors.has(key)) complete = false;
        else { seenCursors.add(key); queue.push({ id: job.id, cursor }); }
      } else if (pageInfo.has_next_page !== false) complete = false;
      return { items, complete, next: queue.length ? String(++pageNumber) : undefined };
    });
    return result;
  },
};
