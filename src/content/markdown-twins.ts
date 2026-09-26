/**
 * Markdown twins of the site's own pages: `/pricing.md`, `/docs/api.md`, `/blog/<slug>.md`,
 * `/p/<slug>.md`, `/index.md`, and any page requested with `Accept: text/markdown`.
 */
import { CREDIT_TABLE, LAUNCH_OFFER, PLANS } from '../billing/plans';
import { findPublishedPost, publishedPosts } from '../cms/posts';
import { getPage, pageToMarkdown, parseDoc } from '../cms/pages';
import type { Env } from '../env';
import { changelogMarkdown, loadChangelog } from '../lib/changelog';
import { DOCS_PAGES, LEGAL_PAGES, type BlogPost, type ContentPage } from './index';
import { ECOSYSTEM, FAQ, FOUNDER, ROADMAP_SOURCES, SITE, SOURCES } from './site';

function frontmatter(fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function faqMarkdown(items: { q: string; a: string }[]): string {
  return items.map((f) => `### ${f.q}\n\n${f.a}`).join('\n\n');
}

function plansMarkdown(): string {
  const rows = PLANS.map((p) => {
    const price = p.id === 'enterprise' ? 'Custom' : p.monthly === 0 ? '$0' : `$${p.monthly}/mo ($${p.yearly}/mo yearly)`;
    const overage = p.overagePer1k === null ? 'hard cap' : `$${p.overagePer1k} per extra 1k`;
    return `| ${p.name} | ${price} | ${p.credits ? p.credits.toLocaleString('en-US') : 'custom'} | ${overage} |`;
  });
  const credits = CREDIT_TABLE.map((r) => `| ${r.label} | ${r.credits} |`);
  return [
    '| Plan | Price | Credits / month | Beyond included |',
    '|---|---|---|---|',
    ...rows,
    '',
    '| Source | Credits |',
    '|---|---|',
    ...credits,
  ].join('\n');
}

export function homeMarkdown(origin: string): string {
  return `${frontmatter({ title: 'anymd — Convert anything on the internet to Markdown', url: origin + '/' })}# anymd

> ${SITE.tagline}

${SITE.description}

## Use it in one second

Prefix any link with \`anymd.cc/\`:

\`\`\`
${origin}/https://stephango.com/saw
\`\`\`

No account needed for up to 50 conversions a day. Sign up for 500 free credits a month and a private, searchable library.

## Why Markdown

- AI agents read Markdown natively; raw HTML wastes tokens on navigation, ads, scripts and styles.
- anymd keeps the article and drops the clutter: headings, links, tables, code and footnotes survive.
- Everything you convert while signed in lands in your library, searchable with BM25, full-text, semantic, query fan-out and Jev re-ranking.

## Sources

${SOURCES.map((s) => `- **${s.label}** — ${s.note}`).join('\n')}

Coming next: ${ROADMAP_SOURCES.join(', ')}.

## Every interface an agent needs

- **URL API:** \`GET ${origin}/<url>\` (Markdown), \`?format=json\` for JSON.
- **REST API:** \`POST ${origin}/api/v1/convert\` with \`Authorization: Bearer amd_…\` — [docs](${origin}/docs/api.md)
- **CLI:** \`npm i -g https://cdn.anymd.cc/cli/anymd-cli-latest.tgz\` — [docs](${origin}/docs/cli.md)
- **MCP:** \`${origin}/mcp\` (Streamable HTTP, OAuth or API key) — [docs](${origin}/docs/mcp.md)
- **WebMCP:** tools exposed to in-browser agents on anymd.cc — [docs](${origin}/docs/webmcp.md)

## Pricing

${plansMarkdown()}

Launch offer: ${LAUNCH_OFFER.percent}% off Pro and Scale with code \`${LAUNCH_OFFER.code}\` until ${new Date(LAUNCH_OFFER.endsAt).toISOString().slice(0, 10)}. Full details: ${origin}/pricing.md

## Built by

${FOUNDER.name} (${FOUNDER.handle}), ${FOUNDER.role}. anymd is open source (MIT): ${SITE.github}

## FAQ

${faqMarkdown(FAQ)}
`;
}

export function pricingMarkdown(origin: string): string {
  return `${frontmatter({ title: 'Pricing', url: origin + '/pricing' })}# Pricing

Usage-based: 1 credit = one web page converted. Heavier sources cost more; search and reads are free.

${plansMarkdown()}

${PLANS.map((p) => `## ${p.name}\n\n${p.tagline}\n\n${p.features.map((f) => `- ${f}`).join('\n')}`).join('\n\n')}

## Offers

- \`${LAUNCH_OFFER.code}\`: ${LAUNCH_OFFER.percent}% off Pro and Scale until ${new Date(LAUNCH_OFFER.endsAt).toISOString().slice(0, 10)}.
- \`${LAUNCH_OFFER.returnVisitorCode}\`: ${LAUNCH_OFFER.returnVisitorPercent}% off for returning visitors, valid ${LAUNCH_OFFER.returnVisitorHours} hours.

Refunds: 14-day money-back on the first payment — ${origin}/legal/refund.md
`;
}

export function ecosystemMarkdown(origin: string): string {
  return `${frontmatter({ title: 'Ecosystem', url: origin + '/ecosystem' })}# The Digitop agent ecosystem

Tools built by ${SITE.owner} that pair well with anymd.

${ECOSYSTEM.map((e) => `## [${e.name}](${e.url})\n\n${e.tagline}`).join('\n\n')}
`;
}

export function blogIndexMarkdown(origin: string, posts: BlogPost[]): string {
  return `${frontmatter({ title: 'Blog', url: origin + '/blog' })}# anymd blog

${posts.map((p) => `- [${p.title}](${origin}/blog/${p.slug}.md) — ${new Date(p.publishedAt).toISOString().slice(0, 10)}. ${p.excerpt}`).join('\n')}
`;
}

export function postMarkdown(origin: string, post: BlogPost): string {
  const body = /^# /m.test(post.markdown) ? post.markdown : `# ${post.title}\n\n${post.markdown}`;
  return `${frontmatter({
    title: post.title,
    description: post.excerpt,
    author: post.authorName,
    published: new Date(post.publishedAt).toISOString().slice(0, 10),
    url: `${origin}/blog/${post.slug}`,
  })}${body}\n`;
}

export function contentPageMarkdown(origin: string, base: string, page: ContentPage): string {
  const path = base === '/docs' && page.slug === 'index' ? '/docs' : `${base}/${page.slug}`;
  const body = /^# /m.test(page.markdown) ? page.markdown : `# ${page.title}\n\n${page.markdown}`;
  return `${frontmatter({ title: page.title, description: page.description, updated: page.updated, url: origin + path })}${body}\n`;
}

/** Resolve a site path (without `.md`) to its Markdown twin, or null when it is not a site page. */
export async function siteMarkdown(env: Env, origin: string, path: string): Promise<string | null> {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/' || p === '/index') return homeMarkdown(origin);
  if (p === '/pricing') return pricingMarkdown(origin);
  if (p === '/ecosystem') return ecosystemMarkdown(origin);
  if (p === '/blog') return blogIndexMarkdown(origin, await publishedPosts(env));
  if (p === '/changelog') return changelogMarkdown(await loadChangelog(env), env.GITHUB_REPO);
  if (p === '/docs') return contentPageMarkdown(origin, '/docs', DOCS_PAGES[0]);
  let m = p.match(/^\/docs\/([a-z0-9-]+)$/);
  if (m) {
    const page = DOCS_PAGES.find((d) => d.slug === m![1] && d.slug !== 'index');
    return page ? contentPageMarkdown(origin, '/docs', page) : null;
  }
  m = p.match(/^\/legal\/([a-z0-9-]+)$/);
  if (m) {
    const page = LEGAL_PAGES.find((d) => d.slug === m![1]);
    return page ? contentPageMarkdown(origin, '/legal', page) : null;
  }
  m = p.match(/^\/blog\/([a-z0-9-]+)$/);
  if (m) {
    const post = await findPublishedPost(env, m[1]);
    return post ? postMarkdown(origin, post) : null;
  }
  m = p.match(/^\/p\/([a-z0-9-]+)$/);
  if (m) {
    const row = await getPage(env, m[1]);
    const doc = row?.status === 'published' ? parseDoc(row.published) : null;
    if (!row || !doc) return null;
    return frontmatter({ title: row.title, description: row.description, url: `${origin}/p/${row.slug}` }) + pageToMarkdown(row.title, row.description, doc);
  }
  return null;
}

/** Paths whose `.md` twin should be tried before treating the request as a URL to convert. */
export function isSitePath(path: string): boolean {
  return /^\/(index|pricing|ecosystem|blog|changelog|docs|legal|p)(\/|$)/.test(path.replace(/\.md$/, '')) || path === '/.md';
}
