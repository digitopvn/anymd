/**
 * Converted Markdown reaches agents and Markdown renderers we don't control, so links and images
 * whose scheme could run code or read local data (`javascript:`, `vbscript:`, `data:`, `file:`, …)
 * are replaced with an inert anchor. http(s), mailto and relative links are kept as they are.
 */
import { marked } from 'marked';
import type { Enrichment } from './enrichment-types';

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);
const SUSPECT = /(?:javascript|vbscript|data|file|blob|filesystem)\s*:/i;
export const UNSAFE_LINK_ANCHOR = '#unsafe-link-removed';

export function isSafeHref(href: string): boolean {
  // Browsers ignore control characters and whitespace inside a scheme (`java\tscript:`).
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(href.replace(/[\u0000- ]/g, '').toLowerCase())?.[1];
  return !scheme || SAFE_SCHEMES.has(scheme);
}

export function neutralizeUnsafeLinks(markdown: string): string {
  // Lexing is the expensive part; most pages never contain a suspect scheme.
  if (!SUSPECT.test(markdown.replace(/[\u0000- ]/g, ''))) return markdown;
  const replacements = new Map<string, string>();
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if ((token.type !== 'link' && token.type !== 'image') || isSafeHref(token.href)) return;
    // An autolink's text is the URL itself, so it is dropped with the link.
    const text = token.raw.startsWith('<') ? 'unsafe link removed' : token.text.replace(/[[\]]/g, '\\$&');
    replacements.set(token.raw, `${token.type === 'image' ? '!' : ''}[${text}](${UNSAFE_LINK_ANCHOR})`);
  });
  let out = markdown;
  for (const [raw, safe] of replacements) out = out.split(raw).join(safe);
  return out;
}

/** Comments and image analyses are appended after the page body, so they are cleaned on their own. */
export function neutralizeEnrichmentLinks(enrichment?: Enrichment): void {
  if (enrichment?.comments) enrichment.comments.markdown = neutralizeUnsafeLinks(enrichment.comments.markdown);
  for (const item of enrichment?.images?.items ?? []) item.markdown = neutralizeUnsafeLinks(item.markdown);
}
