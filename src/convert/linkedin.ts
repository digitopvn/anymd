import { rapidJson } from './provider-fetch';
import { collectComments, object, requireSocialAccount, socialResult, string, type SocialComment } from './social-common';
import { ConvertError, type SourceAdapter } from './types';

const HOST = 'fresh-linkedin-profile-data.p.rapidapi.com';
export const linkedinAdapter: SourceAdapter = {
  kind: 'linkedin',
  matches: (url) => /(^|\.)linkedin\.com$/.test(url.hostname),
  async convert(url, ctx) {
    requireSocialAccount(ctx);
    const urn = decodeURIComponent(url.pathname).match(/(?:activity[:\-]|ugcPost:|share:)(\d{10,})/)?.[1];
    if (!urn) throw new ConvertError('Use a LinkedIn post URL containing its activity ID', 400, 'invalid_url');
    const response = object(await rapidJson(HOST, '/get-post-details', { urn }, ctx));
    const post = object(response.data);
    if (!string(post.text) && !Array.isArray(post.images)) throw new ConvertError('Public LinkedIn post unavailable', 404, 'not_found');
    const author = object(post.poster);
    const images = Array.isArray(post.images) ? post.images.map((item) => string(object(item).url)) : [];
    const result = socialResult(url, 'linkedin', string(post.text), [string(author.first), string(author.last)].filter(Boolean).join(' '), ctx.removeImages ? [] : images, string(post.time));
    let rootCount = 0;
    await collectComments(result, ctx, async (cursor) => {
      const page = Number(cursor || 1);
      const data = object(await rapidJson(HOST, '/get-post-comments', { urn, page: String(page), sort_by: 'Most recent' }, ctx));
      if (!Array.isArray(data.data)) throw new ConvertError('Comment data unavailable', 502, 'upstream_schema');
      const items: SocialComment[] = [];
      let complete = true;
      const queue = data.data.map((value) => ({ value, parent: '' }));
      const seen = new Set<string>();
      for (let index = 0; index < queue.length && index < 2000; index++) {
        const { value, parent } = queue[index];
        const row = object(value);
        const id = string(row.permalink);
        if (!id) { complete = false; continue; }
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, parent, author: string(object(row.commenter).name), text: string(row.text) });
        if (Array.isArray(row.replies)) for (const reply of row.replies) queue.push({ value: reply, parent: id });
        else complete = false;
      }
      if (queue.length > 2000) complete = false;
      rootCount += data.data.length;
      const total = typeof data.total === 'number' ? data.total : undefined;
      if (total === undefined) complete = false;
      if (!data.data.length && total !== undefined && rootCount < total) complete = false;
      return { items, complete, next: data.data.length && (total === undefined || rootCount < total) ? String(page + 1) : undefined };
    });
    return result;
  },
};
