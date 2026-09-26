/**
 * Bundled Markdown content (blog seed posts, legal pages, docs). Wrangler imports `*.md` as text.
 * Blog posts created through the admin API live in D1 and override bundled posts with the same slug.
 */
import { fmList, fmString, parseFrontmatter } from '../lib/markdown';

import blogIntroducing from './blog/introducing-anymd.md';
import blogWhyMarkdown from './blog/why-markdown-is-the-language-of-ai-agents.md';
import blogConvertUrl from './blog/convert-any-url-to-markdown.md';
import blogMcpMemory from './blog/give-your-agent-a-markdown-memory-with-mcp.md';
import blogHybridSearch from './blog/hybrid-search-bm25-semantic-query-fanout.md';
import blogFormats from './blog/youtube-x-pdf-to-markdown.md';

import legalTerms from './legal/terms.md';
import legalPrivacy from './legal/privacy.md';
import legalRefund from './legal/refund.md';
import legalCookies from './legal/cookies.md';
import legalGdpr from './legal/gdpr.md';

import docsIndex from './docs/index.md';
import docsQuickstart from './docs/quickstart.md';
import docsUrl from './docs/url.md';
import docsApi from './docs/api.md';
import docsCli from './docs/cli.md';
import docsMcp from './docs/mcp.md';
import docsWebmcp from './docs/webmcp.md';
import docsLibrary from './docs/library-search.md';
import docsSources from './docs/sources.md';
import docsKeys from './docs/api-keys-roles.md';
import docsPages from './docs/page-builder.md';
import docsBilling from './docs/billing.md';
import docsSelfHost from './docs/self-host.md';

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  tags: string[];
  publishedAt: number;
  seoTitle: string;
  seoDescription: string;
  coverUrl: string;
  authorName: string;
  markdown: string;
  source: 'bundled' | 'db';
}

function bundledPost(raw: string): BlogPost {
  const { data, body } = parseFrontmatter(raw);
  return {
    slug: fmString(data, 'slug'),
    title: fmString(data, 'title'),
    excerpt: fmString(data, 'excerpt'),
    category: fmString(data, 'category', 'article'),
    tags: fmList(data, 'tags'),
    publishedAt: Date.parse(fmString(data, 'published_at')) || 0,
    seoTitle: fmString(data, 'seo_title'),
    seoDescription: fmString(data, 'seo_description'),
    coverUrl: fmString(data, 'cover_url'),
    authorName: fmString(data, 'author', 'Duy /zuey/'),
    markdown: body.trim(),
    source: 'bundled',
  };
}

export const BUNDLED_POSTS: BlogPost[] = [blogIntroducing, blogWhyMarkdown, blogConvertUrl, blogMcpMemory, blogHybridSearch, blogFormats]
  .map(bundledPost)
  .sort((a, b) => b.publishedAt - a.publishedAt);

export interface ContentPage {
  slug: string;
  title: string;
  description: string;
  updated: string;
  markdown: string;
}

function contentPage(slug: string, raw: string): ContentPage {
  const { data, body } = parseFrontmatter(raw);
  return {
    slug,
    title: fmString(data, 'title', slug),
    description: fmString(data, 'description'),
    updated: fmString(data, 'updated'),
    markdown: body.trim(),
  };
}

export const LEGAL_PAGES: ContentPage[] = [
  contentPage('terms', legalTerms),
  contentPage('privacy', legalPrivacy),
  contentPage('refund', legalRefund),
  contentPage('cookies', legalCookies),
  contentPage('gdpr', legalGdpr),
];

/** Docs in navigation order. `index` renders at /docs. */
export const DOCS_PAGES: ContentPage[] = [
  contentPage('index', docsIndex),
  contentPage('quickstart', docsQuickstart),
  contentPage('url', docsUrl),
  contentPage('api', docsApi),
  contentPage('cli', docsCli),
  contentPage('mcp', docsMcp),
  contentPage('webmcp', docsWebmcp),
  contentPage('library-search', docsLibrary),
  contentPage('sources', docsSources),
  contentPage('api-keys-roles', docsKeys),
  contentPage('page-builder', docsPages),
  contentPage('billing', docsBilling),
  contentPage('self-host', docsSelfHost),
];
