/**
 * Generic web adapter — the defuddle pipeline: fetch → linkedom → Defuddle (site extractors,
 * clutter removal, standardization) → Markdown. Inherits GoClaw Fetch's bot-UA retry, which the
 * original never actually ran (its parse result was not awaited); here it does.
 */
import './polyfill';
import { parseHTML } from 'linkedom';
import Defuddle from 'defuddle/full';
import { robotsVerdict } from './robots';
import {
  BOT_USER_AGENT,
  ConvertError,
  USER_AGENT,
  countWords,
  type ConvertContext,
  type ConvertResult,
  type SourceAdapter,
} from './types';
import { convertDocumentResponse, isDocumentContentType } from './document';
import { findOptout } from './optouts';
import { readBounded } from './provider-fetch';
import { fetchFailure, fetchPublic, timedOut } from './safe-fetch';

const MAX_HTML_BYTES = 5 * 1024 * 1024;

/** Domains that serve better (server-rendered) content to bot user agents. */
const BOT_UA_DOMAINS = ['github.com', 'gist.github.com'];

function initialUserAgent(url: URL): string {
  return BOT_UA_DOMAINS.some((d) => url.hostname === d || url.hostname.endsWith('.' + d)) ? BOT_USER_AGENT : USER_AGENT;
}

type Fetched = { kind: 'html'; html: string; finalUrl: string } | { kind: 'result'; result: ConvertResult };

/** Per fetch, inside the conversion's own deadline when it has one. */
const FETCH_TIMEOUT_MS = 20_000;

/** The bare media type, bounded, so an error never echoes a header the remote server wrote at length. */
export function mediaType(contentType: string): string {
  return contentType.split(';')[0].trim().replace(/[^a-z0-9!#$&^_.+\-/]/gi, '').slice(0, 100) || 'unknown';
}

const tooLargeHtml = () => new ConvertError('Page too large (max 5 MB of HTML)', 413, 'too_large');

/** A redirect may land on another site: it gets the same opt-out, rate-limit and robots.txt checks. */
async function vetRedirect(next: URL, from: URL, ctx: ConvertContext): Promise<void> {
  const optout = await findOptout(ctx.env, next.hostname);
  if (optout) throw new ConvertError(`${optout.domain} has asked not to be converted by anymd. See https://anymd.cc/legal/abuse`, 403, 'site_opted_out');
  if (next.hostname.replace(/^www\./, '') !== from.hostname.replace(/^www\./, '')) await checkSitePolicy(next, ctx);
}

async function fetchPage(url: URL, userAgent: string, ctx: ConvertContext): Promise<Fetched> {
  const headers: Record<string, string> = {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/markdown;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  };
  if (ctx.language) headers['Accept-Language'] = ctx.language;
  const timeoutMs = Math.max(1, Math.min(FETCH_TIMEOUT_MS, (ctx.budget?.deadline ?? Date.now() + FETCH_TIMEOUT_MS) - Date.now()));
  const { response, url: finalUrl } = await fetchPublic(url, { headers, timeoutMs, beforeRedirect: (next) => vetRedirect(next, url, ctx) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    // The status text is the remote server's own words; only the number is echoed back.
    throw new ConvertError(`${finalUrl.hostname} responded ${response.status}`, response.status === 404 ? 404 : 502, 'upstream_status');
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  try {
    if (isDocumentContentType(contentType, url)) {
      return { kind: 'result', result: await convertDocumentResponse(response, url, contentType, ctx) };
    }
    if (contentType.startsWith('text/markdown') || contentType.startsWith('text/plain') || contentType.includes('json')) {
      const text = new TextDecoder().decode(await readBounded(response, MAX_HTML_BYTES, tooLargeHtml));
      const isJson = contentType.includes('json');
      const content = isJson ? '```json\n' + text + '\n```' : text;
      return {
        kind: 'result',
        result: {
          title: url.pathname.split('/').pop() || url.hostname,
          author: '',
          published: '',
          description: '',
          domain: url.hostname.replace(/^www\./, ''),
          content,
          wordCount: countWords(content),
          source: url.href,
          sourceKind: 'text',
        },
      };
    }
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && contentType !== '') {
      await response.body?.cancel().catch(() => undefined);
      throw new ConvertError(`Unsupported content type: ${mediaType(contentType)}`, 415, 'unsupported_type');
    }
    const html = new TextDecoder().decode(await readBounded(response, MAX_HTML_BYTES, tooLargeHtml));
    return { kind: 'html', html, finalUrl: finalUrl.href };
  } catch (err) {
    // The deadline also covers reading the body; anything else (a converter failure) keeps its own error.
    throw timedOut(err) ? fetchFailure(finalUrl, err) : err;
  }
}

async function parseHtml(html: string, pageUrl: string, ctx: ConvertContext): Promise<ConvertResult> {
  const { document } = parseHTML(html);
  const doc = document as unknown as { styleSheets?: unknown[]; defaultView?: { getComputedStyle?: unknown } };
  if (!doc.styleSheets) doc.styleSheets = [];
  if (doc.defaultView && !doc.defaultView.getComputedStyle) doc.defaultView.getComputedStyle = () => ({ display: '' });

  const defuddle = new Defuddle(document as unknown as Document, {
    url: pageUrl,
    separateMarkdown: true,
    language: ctx.language,
    contentSelector: ctx.selector,
    removeImages: ctx.removeImages ?? false,
  });
  const result = await defuddle.parseAsync();
  const markdown = (result.contentMarkdown || '').trim();
  const url = new URL(pageUrl);
  return {
    title: result.title || '',
    author: result.author || '',
    published: result.published || '',
    description: result.description || '',
    domain: result.domain || url.hostname.replace(/^www\./, ''),
    content: markdown,
    contentHtml: result.content || '',
    wordCount: result.wordCount || countWords(markdown),
    source: pageUrl,
    sourceKind: /(^|\.)github\.com$/.test(url.hostname) ? 'github' : /(^|\.)reddit\.com$/.test(url.hostname) ? 'reddit' : 'web',
    language: result.language,
    favicon: result.favicon,
    image: result.image,
    site: result.site,
  };
}

/** Politeness gate for pages we fetch ourselves: a per-site request budget, then the site's robots.txt. */
async function checkSitePolicy(url: URL, ctx: ConvertContext): Promise<void> {
  const site = url.hostname.replace(/^www\./, '');
  const { success } = await ctx.env.RL_DOMAIN.limit({ key: site });
  if (!success) throw new ConvertError(`Too many requests to ${site} right now. Try again in a minute.`, 429, 'domain_rate_limited');
  const verdict = await ctx.tracer.span('robots', () => robotsVerdict(ctx.env, url));
  if (verdict === 'disallowed') {
    throw new ConvertError(`${site} asks automated tools not to fetch this page (robots.txt), so anymd will not convert it.`, 403, 'robots_disallowed');
  }
  if (verdict === 'unreachable') {
    throw new ConvertError(`Could not read ${site}/robots.txt, so anymd will not fetch the page. Try again later.`, 503, 'robots_unreachable');
  }
}

async function convertWeb(url: URL, ctx: ConvertContext): Promise<ConvertResult> {
  await checkSitePolicy(url, ctx);
  const ua = initialUserAgent(url);
  const first = await ctx.tracer.span('fetch', () => fetchPage(url, ua, ctx), { ua: ua === BOT_USER_AGENT ? 'bot' : 'default' });
  if (first.kind === 'result') return first.result;

  let result = await ctx.tracer.span('extract', () => parseHtml(first.html, first.finalUrl, ctx), { bytes: first.html.length });

  // Some sites (client-rendered SPAs, Obsidian Publish) serve server-rendered HTML to bots. The retry
  // still identifies as anymd; we never present a browser user agent.
  if (result.wordCount < 5 && ua !== BOT_USER_AGENT) {
    try {
      const retry = await ctx.tracer.span('fetch.retry', () => fetchPage(url, BOT_USER_AGENT, ctx), { ua: 'bot' });
      if (retry.kind === 'result') return retry.result;
      const parsed = await ctx.tracer.span('extract.retry', () => parseHtml(retry.html, retry.finalUrl, ctx));
      if (parsed.wordCount > result.wordCount) result = parsed;
    } catch {
      // A blocked retry keeps the first result.
    }
  }
  if (!result.content) throw new ConvertError('No readable content found on this page', 422, 'empty_content');
  return { ...result, sourceBytes: first.html.length };
}

export const webAdapter: SourceAdapter = {
  kind: 'web',
  matches: () => true,
  convert: convertWeb,
};
