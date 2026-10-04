import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversionBudget, EnrichmentOptionsSchema } from '../src/convert/enrichment-types';
import { articleImages, enrichImages, renderEnrichment } from '../src/convert/image-enrichment';
import { creditCost, pickAdapter } from '../src/convert/index';
import { instagramAdapter } from '../src/convert/instagram';
import { rapidJson } from '../src/convert/provider-fetch';
import { collectComments, plainMarkdown, quote, socialResult, type SocialComment } from '../src/convert/social-common';
import { shortcodeId, threadsAdapter } from '../src/convert/threads';
import type { ConvertContext, ConvertResult } from '../src/convert/types';
import { fetchTweetData } from '../src/convert/x-twitter';
import { parseTweet, threadMembers } from '../src/convert/x-thread';
import { mergeEnrichment } from '../src/library/enrichment';

describe('enrichment option validation', () => {
  it('accepts bounded integer options and rejects invalid limits and types', () => {
    expect(EnrichmentOptionsSchema.safeParse({
      includeComments: true,
      analyzeImages: false,
      maxComments: 100,
      maxImages: 20,
      maxCredits: 1,
    }).success).toBe(true);

    for (const options of [
      { maxComments: 0 },
      { maxComments: 1001 },
      { maxComments: 1.5 },
      { maxImages: 0 },
      { maxImages: 21 },
      { maxCredits: 0 },
      { maxCredits: 1001 },
      { includeComments: 'yes' },
      { analyzeImages: 1 },
    ]) {
      expect(EnrichmentOptionsSchema.safeParse(options).success, JSON.stringify(options)).toBe(false);
    }
  });
});

describe('article image enrichment', () => {
  it('resolves nested and relative images while rejecting decorative and unsafe targets', () => {
    const markdown = [
      '[![Diagram](../diagram.png)](https://example.com/full)',
      '> ![Chart](https://cdn.example.com/chart.webp)',
      '![avatar](https://cdn.example.com/avatar.png)',
      '![Private](http://127.0.0.1/secret.png)',
      '![Script](javascript:alert(1))',
      '![Data](data:image/png;base64,AAAA)',
    ].join('\n\n');

    expect(articleImages(markdown, 'https://example.com/articles/post')).toEqual([
      { url: 'https://example.com/diagram.png', raw: '![Diagram](../diagram.png)' },
      { url: 'https://cdn.example.com/chart.webp', raw: '![Chart](https://cdn.example.com/chart.webp)' },
    ]);
  });

  it('renders matching analysis, preserves unmatched saved analysis, comments, and partial states', () => {
    const fetchedAt = '2026-10-04T01:02:03.000Z';
    const rendered = renderEnrichment(
      'Intro\n\n![Architecture](./architecture.png)',
      'https://example.com/posts/design',
      {
        images: {
          complete: false,
          count: 2,
          reason: 'image_limit',
          fetchedAt,
          items: [
            { url: 'https://example.com/posts/architecture.png', markdown: '## OCR\nHello' },
            { url: 'https://example.com/old.png', markdown: 'Previously captured' },
          ],
        },
        comments: {
          complete: false,
          count: 1,
          reason: 'comment_limit',
          fetchedAt,
          markdown: '**alice**\n\n> Useful note',
        },
      },
    );

    expect(rendered.includes('![Architecture](./architecture.png)')).toBe(true);
    expect(rendered.includes('> **AI image transcription and description** (2026-10-04T01:02:03.000Z)')).toBe(true);
    expect(rendered.includes('> ## OCR\n> Hello')).toBe(true);
    expect(rendered.includes('### Previously saved image analysis')).toBe(true);
    expect(rendered.includes('[Source image](https://example.com/old.png)')).toBe(true);
    expect(rendered.includes('## Comments')).toBe(true);
    expect(rendered.includes('> **Incomplete images:** 2 items retrieved (image_limit).')).toBe(true);
    expect(rendered.includes('> **Incomplete comments:** 1 items retrieved (comment_limit).')).toBe(true);
  });

  it('renders analysis beside every repeated occurrence of the same image', () => {
    const marker = '> **AI image transcription and description**';
    const rendered = renderEnrichment(
      '![Repeat](./same.png)\n\nBetween\n\n![Repeat](./same.png)',
      'https://example.com/post',
      { images: { complete: true, count: 1, fetchedAt: '2026-10-04T00:00:00.000Z',
        items: [{ url: 'https://example.com/same.png', markdown: 'Same analysis' }] } },
    );
    const [before, after] = rendered.split('Between');
    expect(before.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(after.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });
});

describe('provider redirect handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  const tracer = { span: async (_name: string, fn: () => Promise<unknown>) => fn() };

  it('uses manual redirects for credential-bearing RapidAPI calls and rejects redirect responses', async () => {
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } }));
    vi.stubGlobal('fetch', fetch);
    const ctx = {
      env: { RAPIDAPI_KEY: 'test-placeholder' },
      tracer,
      budget: new ConversionBudget(100),
    } as unknown as ConvertContext;

    await expect(rapidJson('provider.example', '/post', { id: '1' }, ctx))
      .rejects.toMatchObject({ code: 'upstream_error', status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0];
    expect(init).toMatchObject({ redirect: 'manual' });
    expect(init?.headers).toMatchObject({
      'X-RapidAPI-Key': 'test-placeholder',
      'X-RapidAPI-Host': 'provider.example',
    });
  });

  it('uses manual redirects for OpenRouter and does not charge a redirected model response', async () => {
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => String(input).startsWith('https://openrouter.ai/')
      ? new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetch);
    const budget = new ConversionBudget(5);
    const ctx = {
      analyzeImages: true,
      budget,
      tracer,
      env: {
        OPENROUTER_API_KEY: 'test-placeholder',
        DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      },
    } as unknown as ConvertContext;
    const result = {
      title: '', author: '', published: '', description: '', domain: 'example.com',
      content: '![Article](https://example.com/article.png)', articleImageUrls: ['https://example.com/article.png'],
      wordCount: 1, source: 'https://example.com/post', sourceKind: 'web',
    } as ConvertResult;

    await enrichImages(result, ctx);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, openRouterInit] = fetch.mock.calls[1];
    expect(openRouterInit).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(openRouterInit?.headers).toMatchObject({ Authorization: 'Bearer test-placeholder' });
    expect(result.enrichment?.images).toMatchObject({ complete: false, count: 0, reason: 'image_analysis_failed', items: [] });
    expect(budget.breakdown.images).toBe(0);
  });

  it('uses manual redirects for FxTwitter and rejects redirect responses', async () => {
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(null, { status: 301, headers: { location: 'https://attacker.example/' } }));
    vi.stubGlobal('fetch', fetch);

    await expect(fetchTweetData('https://x.com/example/status/123'))
      .rejects.toMatchObject({ code: 'upstream_error', status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });
});

describe('social adapter routing and pricing', () => {
  it.each([
    ['https://www.facebook.com/example/posts/1', 'facebook'],
    ['https://www.instagram.com/p/ABC123/', 'instagram'],
    ['https://www.threads.net/@example/post/ABC123', 'threads'],
    ['https://www.linkedin.com/posts/example_1', 'linkedin'],
  ])('routes %s to %s at the fixed social-post price', (raw, kind) => {
    const adapter = pickAdapter(new URL(raw));
    expect(adapter.kind).toBe(kind);
    expect(creditCost(adapter.kind)).toBe(10);
  });
});

describe('Instagram media selection', () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const context = () => ({
    authenticated: true,
    includeComments: false,
    budget: new ConversionBudget(100),
    env: { RAPIDAPI_KEY: 'test-placeholder' },
    tracer: { span: async (_name: string, fn: () => Promise<unknown>) => fn(), note: () => undefined },
  } as unknown as ConvertContext);

  it('uses a public display_url for an explicit photo without calling the media endpoint', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === '/v1/post/resolve') return json({ shortcode: 'PHOTO1' });
      if (url.pathname === '/v1/post') return json({
        shortcode: 'PHOTO1', type: 'photo', is_video: false,
        display_url: 'https://cdn.example/photo.jpg', caption: 'fixture photo',
        owner: { username: 'fixture_author' }, media_id: 'media-1',
      });
      throw new Error(`unexpected endpoint ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    const result = await instagramAdapter.convert(new URL('https://www.instagram.com/p/PHOTO1/'), context());

    expect(articleImages(result.content, result.source).map((image) => image.url)).toEqual(['https://cdn.example/photo.jpg']);
    expect(calls).toEqual(['/v1/post/resolve', '/v1/post']);
  });

  it('uses the media endpoint for a carousel and keeps every returned image', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === '/v1/post/resolve') return json({ shortcode: 'CAROUSEL1' });
      if (url.pathname === '/v1/post') return json({
        shortcode: 'CAROUSEL1', type: 'carousel', is_video: false,
        display_url: 'https://cdn.example/cover.jpg', caption: 'fixture carousel',
        owner: { username: 'fixture_author' }, media_id: 'media-2',
      });
      if (url.pathname === '/v1/post/media') return json({ items: [
        { image: { url: 'https://cdn.example/first.jpg' } },
        { image: { url: 'https://cdn.example/second.jpg' } },
      ] });
      throw new Error(`unexpected endpoint ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    const result = await instagramAdapter.convert(new URL('https://www.instagram.com/p/CAROUSEL1/'), context());

    expect(articleImages(result.content, result.source).map((image) => image.url)).toEqual([
      'https://cdn.example/first.jpg',
      'https://cdn.example/second.jpg',
    ]);
    expect(calls).toEqual(['/v1/post/resolve', '/v1/post', '/v1/post/media']);
  });
});

describe('untrusted social plaintext', () => {
  it('preserves list, rule, strike, and equals characters as literal plaintext', () => {
    const input = '- first\n+ second\n===\n~~not strike~~\na=b';
    expect(plainMarkdown(input)).toBe('\\- first\n\\+ second\n\\=\\=\\=\n\\~\\~not strike\\~\\~\na\\=b');
  });

  it('does not turn hostile caption or author text into article images or Markdown structure', () => {
    const result = socialResult(
      new URL('https://www.facebook.com/example/posts/1'),
      'facebook',
      '![Injected](https://attacker.example/pixel.png)\n# Heading\n<script>alert(1)</script>',
      '![Author](https://attacker.example/avatar.png)',
      [],
    );

    expect(articleImages(result.content, result.source)).toEqual([]);
    expect(result.content.includes('\\!\\[Injected\\]')).toBe(true);
    expect(result.content.includes('\\# Heading')).toBe(true);
    expect(result.content.includes('\\<script\\>')).toBe(true);
  });

  it('escapes fake images and headings inside quoted comment text', () => {
    const markdown = quote('![Injected](https://attacker.example/pixel.png)\n# Fake heading');
    expect(articleImages(markdown, 'https://example.com/post')).toEqual([]);
    expect(markdown).toBe('> \\!\\[Injected\\](https://attacker\\.example/pixel\\.png)\n> \\# Fake heading');
  });
});

describe('Threads shortcode conversion', () => {
  it('decodes the provider base64 alphabet and rejects malformed shortcodes', () => {
    expect(shortcodeId('AAAAA')).toBe('0');
    expect(shortcodeId('AAAAB')).toBe('1');
    expect(shortcodeId('BAAAA')).toBe('16777216');
    expect(shortcodeId('AAAA-')).not.toBe(shortcodeId('AAAA_'));
    for (const invalid of ['ABCD', 'A'.repeat(21), 'AAAA!', '']) {
      expect(() => shortcodeId(invalid)).toThrowError(expect.objectContaining({ code: 'invalid_url', status: 400 }));
    }
  });
});

describe('Threads API4 adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  const post = (pk: string, options: { replies?: number; text?: string; private?: boolean } = {}) => ({
    pk,
    user: { username: `fixture_${pk}`, text_post_app_is_private: options.private ?? false },
    caption: { text: options.text ?? `fixture post ${pk}` },
    text_post_app_info: { direct_reply_count: options.replies ?? 0, is_reply: pk !== '1' },
  });
  const envelope = (items: unknown[], pageInfo: Record<string, unknown> = { has_next_page: false }) => ({
    data: { data: { edges: items.map((item) => ({ node: { thread_items: [{ post: item }] } })), page_info: pageInfo } },
  });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const context = () => ({
    authenticated: true,
    includeComments: true,
    budget: new ConversionBudget(100),
    env: { RAPIDAPI_KEY: 'test-placeholder' },
    tracer: { span: async (_name: string, fn: () => Promise<unknown>) => fn(), note: () => undefined },
  } as unknown as ConvertContext);

  it('parses the documented envelope, skips the focus post, and drains nested and cursor queues', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      if (url.pathname === '/api/post/detail') return json(envelope([post('1', { text: 'focus' })]));
      if (url.searchParams.get('post_id') === '2') return json(envelope([post('9'), post('2'), post('3')]));
      if (url.searchParams.get('end_cursor') === 'root-next') return json(envelope([post('4')]));
      return json(envelope(
        [post('8'), post('1', { text: 'focus duplicate' }), post('2', { replies: 1 })],
        { has_next_page: true, end_cursor: 'root-next' },
      ));
    });
    vi.stubGlobal('fetch', fetch);
    const ctx = context();

    const result = await threadsAdapter.convert(new URL('https://www.threads.net/@fixture/post/AAAAB'), ctx);

    expect(result.content).toBe('focus');
    expect(result.enrichment?.comments).toMatchObject({ complete: true, count: 3 });
    expect(result.enrichment?.comments?.markdown.includes('focus duplicate')).toBe(false);
    expect(result.enrichment?.comments?.markdown.includes('fixture post 2')).toBe(true);
    expect(result.enrichment?.comments?.markdown.includes('fixture post 3')).toBe(true);
    expect(result.enrichment?.comments?.markdown.includes('fixture post 4')).toBe(true);
    expect(ctx.budget?.breakdown.comments).toBe(10);
    expect(calls).toEqual([
      '/api/post/detail?post_id=1',
      '/api/post/comments?post_id=1',
      '/api/post/comments?post_id=2',
      '/api/post/comments?post_id=1&end_cursor=root-next',
    ]);
  });

  it('marks a page partial when the provider promises another page without a cursor', async () => {
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = new URL(String(input));
      return url.pathname === '/api/post/detail'
        ? json(envelope([post('1', { text: 'focus' })]))
        : json(envelope([post('1'), post('2')], { has_next_page: true, end_cursor: null }));
    });
    vi.stubGlobal('fetch', fetch);
    const ctx = context();

    const result = await threadsAdapter.convert(new URL('https://threads.net/@fixture/post/AAAAB'), ctx);

    expect(result.enrichment?.comments).toMatchObject({ complete: false, count: 1, reason: 'source_incomplete' });
    expect(ctx.budget?.breakdown.comments).toBe(10);
  });

  it('does not charge comments when the comments page fails before returning a valid unit', async () => {
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = new URL(String(input));
      return url.pathname === '/api/post/detail'
        ? json(envelope([post('1', { text: 'focus' })]))
        : json({ error: 'fixture upstream failure' }, 500);
    });
    vi.stubGlobal('fetch', fetch);
    const ctx = context();

    const result = await threadsAdapter.convert(new URL('https://threads.net/@fixture/post/AAAAB'), ctx);

    expect(result.enrichment?.comments).toMatchObject({ complete: false, count: 0, reason: 'upstream_error', markdown: '' });
    expect(ctx.budget?.breakdown.comments).toBe(0);
  });
});

describe('social comment collection', () => {
  const comment = (id: number, parent?: string): SocialComment => ({ id: String(id), parent, author: `author-${id}`, text: `comment ${id}` });
  const result = (): ConvertResult => ({
    title: '', author: '', published: '', description: '', domain: 'example.com', content: 'post',
    wordCount: 1, source: 'https://example.com/post', sourceKind: 'facebook',
  });
  const context = (limit = 100, maxComments = 100): ConvertContext => ({
    includeComments: true,
    maxComments,
    budget: new ConversionBudget(limit),
  } as ConvertContext);

  it.each([
    [20, 10],
    [21, 20],
  ])('charges started batches exactly at the %i-comment boundary', async (count, credits) => {
    const target = result();
    const ctx = context(100);
    await collectComments(target, ctx, async () => ({ items: Array.from({ length: count }, (_, index) => comment(index + 1)) }));
    expect(target.enrichment?.comments?.count).toBe(count);
    expect(ctx.budget?.breakdown.comments).toBe(credits);
  });

  it('deduplicates overlapping pages without charging duplicate comments', async () => {
    const target = result();
    const ctx = context(100);
    await collectComments(target, ctx, async (cursor) => cursor
      ? { items: [comment(2), comment(3)] }
      : { items: [comment(1), comment(2)], next: 'page-2' });
    expect(target.enrichment?.comments).toMatchObject({ complete: true, count: 3 });
    expect(ctx.budget?.breakdown.comments).toBe(10);
  });

  it('preserves accepted and charged comments when a later page fails', async () => {
    const target = result();
    const ctx = context(100);
    await collectComments(target, ctx, async (cursor) => {
      if (cursor) throw new Error('provider failed');
      return { items: [comment(1), comment(2)], next: 'page-2' };
    });
    expect(target.enrichment?.comments).toMatchObject({ complete: false, count: 2, reason: 'source_incomplete' });
    expect(target.enrichment?.comments?.markdown.includes('comment 1')).toBe(true);
    expect(ctx.budget?.breakdown.comments).toBe(10);
  });

  it('stops at maxComments and reports the truncation', async () => {
    const target = result();
    const ctx = context(100, 2);
    await collectComments(target, ctx, async () => ({ items: [comment(1), comment(2), comment(3)] }));
    expect(target.enrichment?.comments).toMatchObject({ complete: false, count: 2, reason: 'comment_limit' });
  });

  it('detects cyclic cursors after retaining unique comments', async () => {
    const target = result();
    const ctx = context(100);
    await collectComments(target, ctx, async (cursor) => cursor
      ? { items: [comment(2)], next: 'cycle' }
      : { items: [comment(1)], next: 'cycle' });
    expect(target.enrichment?.comments).toMatchObject({ complete: false, count: 2, reason: 'source_incomplete' });
  });

  it('continues through an empty nested page when more queued work remains', async () => {
    const target = result();
    const ctx = context(100);
    await collectComments(target, ctx, async (cursor) => {
      if (!cursor) return { items: [comment(1)], next: 'empty-child' };
      if (cursor === 'empty-child') return { items: [], next: 'queued-sibling', complete: false };
      return { items: [comment(2, '1')] };
    });
    expect(target.enrichment?.comments).toMatchObject({ complete: false, count: 2, reason: 'source_incomplete' });
    expect(target.enrichment?.comments?.markdown.includes('comment 2')).toBe(true);
  });
});

describe('library enrichment merging', () => {
  const at = '2026-10-04T00:00:00.000Z';

  it('does not let a plain or partial conversion erase richer saved sections', () => {
    const previous = {
      thread: { complete: true, count: 4, fetchedAt: at },
      comments: { complete: false, count: 10, reason: 'comment_limit', fetchedAt: at, markdown: 'ten' },
      images: { complete: true, count: 1, fetchedAt: at, items: [{ url: 'https://a.example/a.png', markdown: 'A' }] },
    };

    expect(mergeEnrichment(previous, {})).toEqual(previous);
    expect(mergeEnrichment(previous, {
      thread: { complete: false, count: 2, reason: 'credit_limit', fetchedAt: at },
      comments: { complete: false, count: 5, reason: 'credit_limit', fetchedAt: at, markdown: 'five' },
      images: { complete: false, count: 0, reason: 'provider_unavailable', fetchedAt: at, items: [] },
    })).toEqual(previous);
  });

  it('accepts a complete replacement or a larger partial result', () => {
    const previous = {
      comments: { complete: false, count: 2, reason: 'credit_limit', fetchedAt: at, markdown: 'old' },
    };
    const larger = { complete: false, count: 3, reason: 'comment_limit', fetchedAt: at, markdown: 'larger' };
    expect(mergeEnrichment(previous, { comments: larger }).comments).toEqual(larger);

    const complete = { complete: true, count: 1, fetchedAt: at, markdown: 'authoritative' };
    expect(mergeEnrichment(previous, { comments: complete }).comments).toEqual(complete);
  });
});

describe('X thread parsing and membership', () => {
  const tweet = (id: string, parent: string, authorId = 'author-1', conversation = '100') => ({
    id,
    parent,
    conversation,
    authorId,
    handle: 'alice',
    text: `post ${id}`,
  });

  it('parses supported provider shapes and rejects malformed identifiers', () => {
    expect(parseTweet({
      tweet_id: '123',
      in_reply_to_status_id_str: '122',
      conversation_id: '100',
      user_info: { screen_name: 'alice_1', rest_id: 'author-1' },
      text: 'hello',
    })).toEqual({
      id: '123',
      parent: '122',
      conversation: '100',
      authorId: 'author-1',
      handle: 'alice_1',
      text: 'hello',
    });

    for (const row of [
      null,
      { id: 'not-numeric', author: { screen_name: 'alice', rest_id: 'a' } },
      { id: '123', author: { screen_name: 'bad-handle!', rest_id: 'a' } },
      { id: '123', author: { screen_name: 'alice' } },
    ]) expect(parseTweet(row)).toBeNull();
  });

  it('keeps only the rooted same-author relationship chain, ordered and deduplicated', () => {
    const root = tweet('100', '');
    const members = threadMembers(root, [
      tweet('103', '102'),
      tweet('102', '101'),
      tweet('101', '100'),
      tweet('101', '100'),
      tweet('104', '103', 'other-author'),
      tweet('105', '999'),
      tweet('106', '106'),
      tweet('107', '103', 'author-1', 'other-conversation'),
    ]);

    expect(members.map((member) => member.id)).toEqual(['100', '101', '102', '103']);
  });
});

describe('ConversionBudget', () => {
  it('tracks the exact breakdown and refuses spending above the caller limit', () => {
    const budget = new ConversionBudget(7);
    budget.charge('base', 1);
    budget.charge('thread', 2);
    budget.charge('comments', 1);
    budget.charge('images', 3);

    expect(budget.used).toBe(7);
    expect(budget.breakdown).toEqual({ base: 1, thread: 2, comments: 1, images: 3 });
    expect(budget.canSpend(1)).toBe(false);
    expect(() => budget.charge('images', 1)).toThrow('Conversion budget exceeded');
    expect(budget.used).toBe(7);
  });

  it('enforces the provider-call ceiling', () => {
    const budget = new ConversionBudget(100);
    budget.calls = 39;
    expect(budget.canFetch()).toBe(true);
    budget.calls++;
    expect(budget.canFetch()).toBe(false);
  });
});
