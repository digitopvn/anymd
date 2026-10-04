import { rapidJson } from './provider-fetch';
import { collectComments, object, publicUrl, requireSocialAccount, socialResult, string, type SocialComment } from './social-common';
import { ConvertError, type SourceAdapter } from './types';

const HOST = 'facebook-scraper3.p.rapidapi.com';
export const facebookAdapter: SourceAdapter = {
  kind: 'facebook',
  matches: (url) => /(^|\.)facebook\.com$/.test(url.hostname) || url.hostname === 'fb.watch',
  async convert(url, ctx) {
    requireSocialAccount(ctx);
    const data = object(object(await rapidJson(HOST, '/post', { post_url: url.href }, ctx)).results);
    if (!string(data.post_id)) throw new ConvertError('Public Facebook post is unavailable', 404, 'not_found');
    const images = [string(object(data.image).uri)];
    if (Array.isArray(data.album_preview)) for (const item of data.album_preview) images.push(string(object(object(item).image).uri));
    const result = socialResult(url, 'facebook', string(data.message), string(object(data.author).name), ctx.removeImages ? [] : images,
      typeof data.timestamp === 'number' ? new Date(data.timestamp * 1000).toISOString() : '');
    const video = publicUrl(data.video);
    if (video) result.content += `\n\n[Video](<${video}>)`;
    const postId = string(data.post_id);
    // Each queue item represents a provider cursor, including reply expansions.
    const queue: { path: string; params: Record<string, string> }[] = [{ path: '/post/comments', params: { post_id: postId } }];
    const seen = new Set<string>();
    let pageNumber = 0;
    await collectComments(result, ctx, async () => {
      const job = queue.shift()!;
      const response = object(await rapidJson(HOST, job.path, job.params, ctx));
      if (!Array.isArray(response.results)) throw new ConvertError('Comment data unavailable', 502, 'upstream_schema');
      const items: SocialComment[] = [];
      let complete = true;
      for (const value of response.results) {
        const row = object(value);
        const id = string(row.legacy_comment_id) || string(row.comment_id);
        if (!id) { complete = false; continue; }
        items.push({ id, parent: string(row.parent_comment_id) || job.params.comment_id, author: string(object(row.author).name), text: string(row.message) });
        if (Number(row.replies_count) > 0 && !seen.has(id)) {
          seen.add(id);
          const token = string(row.expansion_token);
          if (token) queue.push({ path: '/post/comments_nested', params: { post_id: postId, comment_id: id, expansion_token: token } });
          else complete = false;
        }
      }
      const cursor = string(response.cursor);
      if (cursor) {
        const key = `${job.path}:${job.params.comment_id ?? ''}:${cursor}`;
        if (seen.has(key)) complete = false;
        else { seen.add(key); queue.push({ path: job.path, params: { ...job.params, cursor } }); }
      }
      return { items, complete, next: queue.length ? String(++pageNumber) : undefined };
    });
    return result;
  },
};
