/**
 * The URL API: `GET https://anymd.cc/<any-url>` → Markdown. Mounted last, so every other route
 * wins. Only anymd's own option params are stripped from the query; everything else belongs to
 * the target URL (`anymd.cc/example.com/search?q=x&format=json` converts `example.com/search?q=x`).
 */
import { Hono } from 'hono';
import type { AppContext } from '../auth/middleware';
import { isSitePath, siteMarkdown } from '../content/markdown-twins';
import { runConversion } from '../convert/service';
import { ConvertError } from '../convert/types';
import type { AppBindings } from '../env';
import { renderMarkdown } from '../lib/markdown';
import { convertPayload } from '../services';
import { ConvertedPreview } from '../views/pages';
import { clientIp, markdownResponse, originOf, renderMessage, renderPage } from './shared';

export const convertRoutes = new Hono<AppBindings>();

const OPTION_PARAMS = ['format', 'lang', 'selector', 'images', 'frontmatter', 'fresh', 'save'];

convertRoutes.get('/convert', (c) => {
  const url = (c.req.query('url') ?? '').trim();
  if (!url) return c.redirect('/');
  return c.redirect('/' + url.replace(/^\/+/, ''), 302);
});

function notFound(c: AppContext) {
  return renderMessage(c, 404, 'Page not found', 'Nothing lives here. To convert a page, put its URL after anymd.cc/ — for example anymd.cc/example.com.', <a class="btn btn-dark" href="/">Go home</a>);
}

convertRoutes.get('*', async (c) => {
  const reqUrl = new URL(c.req.url);
  // Keep the raw path: decoding would break percent-encoded characters in the target URL.
  const path = reqUrl.pathname;

  // Markdown twins of site pages: /pricing.md, /docs/api.md, /blog/<slug>.md …
  if (path.endsWith('.md') && isSitePath(path)) {
    const md = await siteMarkdown(c.env, originOf(c), path.slice(0, -3));
    return md ? markdownResponse(c, md, originOf(c) + (path === '/index.md' ? '/' : path.slice(0, -3))) : notFound(c);
  }

  const raw = path.slice(1);
  const firstSegment = decodeURIComponent(raw.split('/')[0] ?? '');
  // Only something that looks like a host (or a scheme) is a conversion target.
  if (!raw || !(/^https?:$/i.test(firstSegment) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(firstSegment))) return notFound(c);

  const params = new URLSearchParams(reqUrl.search);
  const opt = (k: string) => params.get(k) ?? undefined;
  const options = { format: opt('format'), lang: opt('lang'), selector: opt('selector'), images: opt('images'), frontmatter: opt('frontmatter'), fresh: opt('fresh'), save: opt('save') };
  for (const k of OPTION_PARAMS) params.delete(k);
  const query = params.toString();
  const target = raw + (query ? `?${query}` : '');

  const accept = c.req.header('accept') ?? '';
  const format = options.format ?? (/application\/json/i.test(accept) && !/text\/html/i.test(accept) ? 'json' : 'markdown');

  try {
    const r = await runConversion(c.env, c.executionCtx, {
      url: target,
      channel: 'url',
      principal: c.get('principal'),
      language: options.lang,
      selector: options.selector,
      removeImages: options.images === '0',
      frontmatter: options.frontmatter !== '0',
      save: options.save !== '0',
      fresh: options.fresh === '1',
      clientIp: clientIp(c),
    });
    c.header('X-Anymd-Credits', String(r.credits));
    c.header('X-Anymd-Cache', r.cached ? 'hit' : 'miss');
    c.header('X-Anymd-Trace', r.traceId);
    c.header('X-Anymd-Kind', r.result.sourceKind);
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Expose-Headers', 'X-Anymd-Credits, X-Anymd-Cache, X-Anymd-Trace, X-Anymd-Kind');
    // Responses can depend on the caller's library/quota, so shared caches must not store them.
    c.header('Cache-Control', 'private, max-age=0');
    c.header('X-Robots-Tag', 'noindex');
    if (format === 'json') return c.json(convertPayload(r));
    if (format === 'html') {
      const { html } = renderMarkdown(r.result.content, { trusted: false });
      const markdownUrl = `/${target}`;
      return renderPage(c, { title: r.result.title || r.result.source, path: `/${target}`, noindex: true, markdownPath: null, variant: 'default' }, <ConvertedPreview title={r.result.title || r.result.domain} source={r.result.source} html={html} markdownUrl={markdownUrl} />);
    }
    return c.body(r.markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  } catch (err) {
    const e = err instanceof ConvertError ? err : new ConvertError('Conversion failed', 500, 'internal');
    if (!(err instanceof ConvertError)) console.error('url conversion', err);
    if (e.status === 429) c.header('Retry-After', '3600');
    c.header('Access-Control-Allow-Origin', '*');
    if (format === 'json') return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
    if (format === 'html') return renderMessage(c, e.status, 'Could not convert this page', e.message);
    return c.body(`# Error ${e.status}\n\n${e.message}\n\ncode: ${e.code}\n`, e.status as 400, { 'Content-Type': 'text/markdown; charset=utf-8' });
  }
});
