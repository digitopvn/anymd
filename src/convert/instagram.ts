import { rapidJson } from './provider-fetch';
import { collectComments, object, publicUrl, requireSocialAccount, socialResult, string, type SocialComment } from './social-common';
import { ConvertError, type SourceAdapter } from './types';

const HOST = 'instagram-pro-and-cheap-api.p.rapidapi.com';
export const instagramAdapter: SourceAdapter = {
  kind: 'instagram',
  matches: (url) => /(^|\.)instagram\.com$/.test(url.hostname),
  async convert(url, ctx) {
    requireSocialAccount(ctx);
    if (!/^\/(p|reel|reels|share)\//.test(url.pathname)) throw new ConvertError('Use an Instagram post or reel URL', 400, 'invalid_url');
    const resolved = object(await rapidJson(HOST, '/v1/post/resolve', { url: url.href }, ctx));
    const shortcode = string(resolved.shortcode);
    if (!shortcode) throw new ConvertError('Instagram post unavailable', 404, 'not_found');
    const post = object(await rapidJson(HOST, '/v1/post', { url: shortcode }, ctx));
    if (string(post.shortcode) !== shortcode) throw new ConvertError('Post data unavailable', 502, 'upstream_schema');
    const photo = post.type === 'photo' && publicUrl(post.display_url);
    const images: string[] = photo ? [photo] : [];
    // `video_url` is the MP4 with sound (`video_hd` is often a silent video-only stream). A carousel
    // lists its videos only on the media endpoint, so that is read for videos even without images.
    const single = post.type !== 'carousel' && publicUrl(post.video_url);
    const videos: string[] = single ? [single] : [];
    if (!photo && (!ctx.removeImages || !single)) {
      try {
        const media = object(await rapidJson(HOST, '/v1/post/media', { url: shortcode }, ctx));
        if (!Array.isArray(media.items)) throw new ConvertError('Post media unavailable', 502, 'upstream_schema');
        for (const value of media.items) {
          const item = object(value);
          images.push(string(object(item.image).url));
          if (!single && item.is_video === true) videos.push(string(object(item.video).url));
        }
      } catch (error) {
        // Without images the call only adds video links, so the post still reads when the provider
        // has no media for it; budget and timeout errors still stop the read.
        const code = error instanceof ConvertError ? error.code : '';
        if (!ctx.removeImages || !(code.startsWith('upstream') || code === 'not_found')) throw error;
      }
    }
    const result = socialResult(url, 'instagram', string(post.caption), string(object(post.owner).username), ctx.removeImages ? [] : images,
      typeof post.taken_at === 'number' ? new Date(post.taken_at * 1000).toISOString() : '', videos);
    const mediaId = string(post.media_id);
    const queue: { path: string; params: Record<string, string> }[] = [
      { path: '/v1/post/comments', params: { media_id: mediaId, sort: 'recent' } },
    ];
    const seen = new Set<string>();
    let pageNumber = 0;
    await collectComments(result, ctx, async () => {
      const job = queue.shift()!;
      let data;
      let complete = true;
      try { data = object(await rapidJson(HOST, job.path, job.params, ctx)); }
      catch (error) {
        // Popular comments are a different, finite subset; expose that limitation explicitly.
        if (job.params.sort !== 'recent' || job.params.cursor) throw error;
        data = object(await rapidJson(HOST, job.path, { ...job.params, sort: 'popular' }, ctx));
        complete = false;
      }
      if (!Array.isArray(data.items)) throw new ConvertError('Comment data unavailable', 502, 'upstream_schema');
      const items: SocialComment[] = [];
      for (const value of data.items) {
        const row = object(value);
        const id = string(row.id);
        if (!id) { complete = false; continue; }
        items.push({ id, parent: string(row.parent_id) || job.params.parent_comment_id, author: string(object(row.user).username), text: string(row.text) });
        // Chronological comments omit reply_count. Probe each parent once so replies are not silently omitted.
        if (!job.params.parent_comment_id && row.reply_count !== 0 && !seen.has(id)) {
          seen.add(id);
          queue.push({ path: '/v1/post/comments/replies', params: { media_id: mediaId, parent_comment_id: id } });
        }
      }
      if (data.has_more === true) {
        const cursor = string(data.next_cursor);
        const key = `${job.params.parent_comment_id ?? 'root'}:${cursor}`;
        if (!cursor || seen.has(key)) complete = false;
        else { seen.add(key); queue.push({ path: job.path, params: { ...job.params, cursor } }); }
      } else if (data.has_more !== false) complete = false;
      return { items, complete, next: queue.length ? String(++pageNumber) : undefined };
    });
    return result;
  },
};
