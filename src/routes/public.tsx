/** Public marketing pages, blog, docs, legal, changelog, built pages and SEO/agent files. */
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import type { AppContext } from '../auth/middleware';
import { PLANS } from '../billing/plans';
import { billingEnabled } from '../billing/provider';
import { findPublishedPost, publishedPosts } from '../cms/posts';
import { getPage, parseDoc } from '../cms/pages';
import { PageBlocks, pageJsonLd } from '../cms/render';
import { DOCS_PAGES, LEGAL_PAGES } from '../content';
import { homeMarkdown, isSitePath, siteMarkdown } from '../content/markdown-twins';
import { FAQ, SITE } from '../content/site';
import { loadChangelog } from '../lib/changelog';
import { readingMinutes, renderMarkdown } from '../lib/markdown';
import { totalConversions } from '../lib/usage';
import { HomePage } from '../views/home';
import { BlogIndexPage, BlogPostPage, ChangelogPage, DocsPage, EcosystemPage, LegalPage, PreviewBanner, PricingPage } from '../views/pages';
import { markdownResponse, originOf, renderMessage, renderPage, wantsMarkdown } from './shared';

export const publicRoutes = new Hono<AppBindings>();

function faqJsonLd(items: { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
}

function softwareJsonLd(origin: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'anymd',
    url: origin,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web, macOS, Windows, Linux',
    description: SITE.description,
    offers: PLANS.filter((p) => p.id !== 'enterprise').map((p) => ({ '@type': 'Offer', name: p.name, price: p.monthly, priceCurrency: 'USD' })),
    publisher: { '@type': 'Organization', name: SITE.owner, url: SITE.ownerUrl },
  };
}

// `Accept: text/markdown` on any site page returns its Markdown twin.
publicRoutes.use('*', async (c, next) => {
  if (c.req.method === 'GET' && wantsMarkdown(c)) {
    const path = new URL(c.req.url).pathname;
    if (path === '/' || isSitePath(path)) {
      const md = await siteMarkdown(c.env, originOf(c), path);
      if (md) return markdownResponse(c, md, originOf(c) + path);
    }
  }
  await next();
});

publicRoutes.get('/', async (c) => {
  const origin = originOf(c);
  const conversions = await totalConversions(c.env).catch(() => 0);
  return renderPage(
    c,
    {
      title: `anymd — ${SITE.tagline.replace(/\.$/, '')}`,
      description: SITE.description,
      path: '/',
      pageActions: true,
      jsonLd: [softwareJsonLd(origin), faqJsonLd(FAQ)],
    },
    <HomePage conversions={conversions} />,
  );
});

publicRoutes.get('/index.md', (c) => markdownResponse(c, homeMarkdown(originOf(c)), originOf(c) + '/'));

publicRoutes.get('/pricing', (c) =>
  renderPage(
    c,
    {
      title: 'Pricing — pay per page, not per seat',
      description: 'Usage-based pricing for anymd: 500 free credits a month, Pro $9 for 10k credits, Scale $49 for 100k. Search and reads are always free.',
      path: '/pricing',
      pageActions: true,
      jsonLd: [softwareJsonLd(originOf(c))],
    },
    <PricingPage checkoutReady={billingEnabled(c.env)} />,
  ),
);

publicRoutes.get('/ecosystem', (c) =>
  renderPage(
    c,
    { title: 'Ecosystem — tools for AI agents by Digitop', description: 'Dewee, AgentBrain, AgentKit, GoClaw, AgentWiki, UI UX Pro Max and TOSE — the agent toolkit around anymd.', path: '/ecosystem', pageActions: true },
    <EcosystemPage />,
  ),
);

publicRoutes.get('/blog', async (c) => {
  const posts = await publishedPosts(c.env);
  return renderPage(
    c,
    { title: 'Blog — Markdown, agents and the web', description: 'Guides, announcements and deep dives on turning the web into Markdown for AI agents.', path: '/blog', pageActions: true },
    <BlogIndexPage posts={posts} />,
  );
});

publicRoutes.get('/blog/:slug{[a-z0-9-]+}', async (c) => {
  const post = await findPublishedPost(c.env, c.req.param('slug'));
  if (!post) return renderMessage(c, 404, 'Post not found', 'That post does not exist or is not published yet.');
  const origin = originOf(c);
  const { html, toc } = renderMarkdown(post.markdown, { trusted: post.source === 'bundled' });
  const published = new Date(post.publishedAt).toISOString();
  return renderPage(
    c,
    {
      title: post.seoTitle || post.title,
      description: post.seoDescription || post.excerpt,
      path: `/blog/${post.slug}`,
      type: 'article',
      image: post.coverUrl || undefined,
      publishedAt: published,
      pageActions: true,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: post.title,
          description: post.excerpt,
          datePublished: published,
          author: { '@type': 'Person', name: post.authorName, url: 'https://zuey.me' },
          publisher: { '@type': 'Organization', name: SITE.owner, url: SITE.ownerUrl },
          mainEntityOfPage: `${origin}/blog/${post.slug}`,
          image: post.coverUrl || `${origin}/og/share.jpg?v=2`,
          keywords: post.tags.join(', '),
        },
      ],
    },
    <BlogPostPage post={post} html={html} toc={toc} minutes={readingMinutes(post.markdown)} />,
  );
});

publicRoutes.get('/changelog', async (c) => {
  const log = await loadChangelog(c.env);
  return renderPage(
    c,
    { title: 'Changelog — stable and beta releases', description: 'What shipped in anymd: stable releases from main and beta builds from dev, straight from GitHub.', path: '/changelog', pageActions: true },
    <ChangelogPage entries={log.entries} source={log.source} />,
  );
});

publicRoutes.get('/docs/api/reference', (c) => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>API reference · anymd</title><meta name="description" content="Interactive OpenAPI reference for the anymd REST API."><link rel="icon" href="/favicon-32.png"><link rel="alternate" type="application/json" href="/api/v1/openapi.json"></head><body><div id="app"></div><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script><script>Scalar.createApiReference('#app',{url:'/api/v1/openapi.json',hideDownloadButton:false,metaData:{title:'anymd API reference'},customCss:'.scalar-app{--scalar-color-accent:#067a4e}'})</script></body></html>`;
  return c.html(html);
});

function docsRoute(slug: string) {
  return async (c: AppContext) => {
    const page = DOCS_PAGES.find((d) => d.slug === slug);
    if (!page) return renderMessage(c, 404, 'Doc not found', 'That documentation page does not exist.');
    const { html, toc } = renderMarkdown(page.markdown, { trusted: true });
    const path = slug === 'index' ? '/docs' : `/docs/${slug}`;
    return renderPage(c, { title: `${page.title} — anymd docs`, description: page.description, path, pageActions: true }, <DocsPage page={page} html={html} toc={toc} />);
  };
}

publicRoutes.get('/docs', (c) => docsRoute('index')(c));
publicRoutes.get('/docs/:slug{[a-z0-9-]+}', (c) => docsRoute(c.req.param('slug'))(c));

publicRoutes.get('/legal', (c) => c.redirect('/legal/terms'));
for (const [short, slug] of [['terms', 'terms'], ['privacy', 'privacy'], ['refund', 'refund'], ['cookies', 'cookies'], ['gdpr', 'gdpr']]) {
  publicRoutes.get(`/${short}`, (c) => c.redirect(`/legal/${slug}`, 301));
}
publicRoutes.get('/legal/:slug{[a-z0-9-]+}', (c) => {
  const page = LEGAL_PAGES.find((p) => p.slug === c.req.param('slug'));
  if (!page) return renderMessage(c, 404, 'Page not found', 'That policy does not exist.');
  const { html } = renderMarkdown(page.markdown, { trusted: true });
  return renderPage(c, { title: page.title, description: page.description, path: `/legal/${page.slug}`, pageActions: true }, <LegalPage page={page} html={html} all={LEGAL_PAGES} />);
});

// Pages built with the page builder. Drafts are visible with the share-preview token.
publicRoutes.get('/p/:slug{[a-z0-9-]+}', async (c) => {
  const row = await getPage(c.env, c.req.param('slug'));
  const token = c.req.query('preview');
  if (!row || row.status === 'archived' || row.slug !== c.req.param('slug')) return renderMessage(c, 404, 'Page not found', 'This page does not exist or is not published.');
  const preview = Boolean(token && token === row.preview_token);
  const doc = preview ? parseDoc(row.draft) : row.status === 'published' ? parseDoc(row.published) : null;
  if (!doc) return renderMessage(c, 404, 'Page not found', 'This page does not exist or is not published.');
  const variant = doc.layout === 'landing' ? 'landing' : 'default';
  if (preview) c.header('X-Robots-Tag', 'noindex');
  return renderPage(
    c,
    {
      title: doc.seo.title || row.title,
      description: doc.seo.description || row.description,
      path: `/p/${row.slug}`,
      image: doc.seo.image || undefined,
      noindex: preview || doc.seo.noindex,
      variant,
      pageActions: !preview,
      markdownPath: preview ? null : undefined,
      jsonLd: pageJsonLd(doc),
    },
    <>
      {preview ? <PreviewBanner slug={row.slug} revision={row.revision} /> : null}
      <PageBlocks doc={doc} preview={preview} />
    </>,
  );
});

// ─── Agent & crawler files ──────────────────────────────────────────────────

publicRoutes.get('/robots.txt', (c) => {
  const origin = originOf(c);
  if (c.env.ENVIRONMENT !== 'production') return c.text('User-agent: *\nDisallow: /\n');
  return c.text(
    `# anymd.cc — AI agents welcome. Every page has a Markdown twin (append .md) and ${origin}/llms.txt.
User-agent: *
Allow: /
Disallow: /dashboard
Disallow: /admin
Disallow: /api/
Disallow: /oauth/
Disallow: /mcp
Disallow: /http

Sitemap: ${origin}/sitemap.xml
`,
  );
});

publicRoutes.get('/sitemap.xml', async (c) => {
  const origin = originOf(c);
  const posts = await publishedPosts(c.env);
  const { results: pages } = await c.env.DB.prepare("SELECT slug, updated_at FROM pages WHERE status = 'published'").all<{ slug: string; updated_at: number }>();
  const today = new Date().toISOString().slice(0, 10);
  const urls: { loc: string; lastmod: string; priority: string }[] = [
    { loc: '/', lastmod: today, priority: '1.0' },
    { loc: '/pricing', lastmod: today, priority: '0.9' },
    { loc: '/docs', lastmod: today, priority: '0.9' },
    { loc: '/blog', lastmod: today, priority: '0.8' },
    { loc: '/changelog', lastmod: today, priority: '0.6' },
    { loc: '/ecosystem', lastmod: today, priority: '0.6' },
    { loc: '/docs/api/reference', lastmod: today, priority: '0.7' },
    ...DOCS_PAGES.filter((d) => d.slug !== 'index').map((d) => ({ loc: `/docs/${d.slug}`, lastmod: d.updated || today, priority: '0.8' })),
    ...posts.map((p) => ({ loc: `/blog/${p.slug}`, lastmod: new Date(p.publishedAt).toISOString().slice(0, 10), priority: '0.7' })),
    ...pages.map((p) => ({ loc: `/p/${p.slug}`, lastmod: new Date(p.updated_at).toISOString().slice(0, 10), priority: '0.6' })),
    ...LEGAL_PAGES.map((p) => ({ loc: `/legal/${p.slug}`, lastmod: p.updated || today, priority: '0.3' })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${origin}${u.loc}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`;
  return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
});

publicRoutes.get('/llms.txt', async (c) => {
  const origin = originOf(c);
  const posts = await publishedPosts(c.env);
  const txt = `# anymd

> ${SITE.description}

Agents read public web content through anymd as structured Markdown and recall it later from a private library. Quick read: prefix a link, \`${origin}/<url>\` returns \`text/markdown\`; add \`?format=json\` for JSON. MCP: \`${origin}/mcp\` with the \`read_url\` and \`search_library\` tools. Every page on this site has a Markdown twin — append \`.md\` to its URL.

## Docs

${DOCS_PAGES.map((d) => `- [${d.title}](${origin}${d.slug === 'index' ? '/docs' : `/docs/${d.slug}`}.md): ${d.description}`).join('\n')}
- [OpenAPI spec](${origin}/api/v1/openapi.json): machine-readable REST API

## Interfaces

- [URL API](${origin}/docs/url.md): \`GET ${origin}/<url>\`, no key needed
- [MCP server](${origin}/docs/mcp.md): \`${origin}/mcp\` (Streamable HTTP; OAuth 2.1 or \`Authorization: Bearer amd_…\`)
- [CLI](${origin}/docs/cli.md): \`npm i -g https://cdn.anymd.cc/cli/anymd-cli-latest.tgz\`

## Product

- [Home](${origin}/index.md)
- [Pricing](${origin}/pricing.md)
- [Changelog](${origin}/changelog.md)
- [Ecosystem](${origin}/ecosystem.md)

## Blog

${posts.map((p) => `- [${p.title}](${origin}/blog/${p.slug}.md): ${p.excerpt}`).join('\n')}

## Optional

${LEGAL_PAGES.map((p) => `- [${p.title}](${origin}/legal/${p.slug}.md)`).join('\n')}
- [Full text of the docs](${origin}/llms-full.txt)
`;
  return c.text(txt, 200, { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
});

publicRoutes.get('/llms-full.txt', async (c) => {
  const origin = originOf(c);
  const parts = [homeMarkdown(origin)];
  for (const d of DOCS_PAGES) parts.push((await siteMarkdown(c.env, origin, d.slug === 'index' ? '/docs' : `/docs/${d.slug}`)) ?? '');
  parts.push((await siteMarkdown(c.env, origin, '/pricing')) ?? '');
  return c.text(parts.join('\n\n---\n\n'), 200, { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
});

publicRoutes.get('/.well-known/security.txt', (c) =>
  c.text(`Contact: mailto:${SITE.email}\nExpires: 2027-12-31T00:00:00.000Z\nPreferred-Languages: en, vi\nCanonical: ${originOf(c)}/.well-known/security.txt\n`),
);

publicRoutes.get('/status.json', async (c) => {
  const db = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>().catch(() => null);
  return c.json(
    { ok: Boolean(db?.ok), service: 'anymd', environment: c.env.ENVIRONMENT, time: new Date().toISOString() },
    db?.ok ? 200 : 503,
    { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  );
});
