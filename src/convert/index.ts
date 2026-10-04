import { xAdapter } from './x-twitter';
import { youtubeAdapter } from './youtube';
import { hackerNewsAdapter } from './hackernews';
import { webAdapter } from './web';
import { facebookAdapter } from './facebook';
import { instagramAdapter } from './instagram';
import { threadsAdapter } from './threads';
import { linkedinAdapter } from './linkedin';
import { ENRICHMENT_CREDITS } from '../billing/plans';
import { documentCreditCost } from './document';
import { ConvertError, type ConvertContext, type ConvertResult, type SourceAdapter, type SourceKind } from './types';

export * from './types';

/** Order matters: specialised adapters first, the web adapter (Defuddle + its site extractors) last. */
const ADAPTERS: SourceAdapter[] = [xAdapter, facebookAdapter, instagramAdapter, threadsAdapter, linkedinAdapter, youtubeAdapter, hackerNewsAdapter, webAdapter];

const BLOCKED_HOSTNAMES = new Set(['localhost', 'anymd.cc', 'www.anymd.cc', 'staging.anymd.cc', 'metadata.google.internal']);

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(h) || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return h.includes(':');
  return false;
}

/**
 * Normalise user input ("example.com/a", "https://…", "//…") into an absolute http(s) URL and
 * refuse private or self-referential targets.
 */
export function normalizeTargetUrl(raw: string): URL {
  let s = raw.trim();
  if (!s) throw new ConvertError('Missing URL', 400, 'invalid_url');
  s = s.replace(/^\/+/, '');
  // Paths like /https:/example.com (slashes collapsed by some clients)
  s = s.replace(/^(https?):\/(?!\/)/i, '$1://');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ConvertError('Invalid URL. Please provide a valid web address.', 400, 'invalid_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConvertError('Only http(s) URLs are supported', 400, 'invalid_url');
  if (!url.hostname.includes('.') || isPrivateHost(url.hostname)) throw new ConvertError('Cannot convert this URL.', 400, 'blocked_host');
  if (url.username || url.password) throw new ConvertError('URLs with credentials are not allowed', 400, 'invalid_url');
  url.hash = '';
  return url;
}

export function pickAdapter(url: URL): SourceAdapter {
  return ADAPTERS.find((a) => a.matches(url)) ?? webAdapter;
}

export async function convertUrl(url: URL, ctx: ConvertContext): Promise<ConvertResult> {
  const adapter = pickAdapter(url);
  ctx.tracer.note('adapter', { kind: adapter.kind, host: url.hostname });
  return adapter.convert(url, ctx);
}

/** Credits a conversion costs. 1 credit = one web page. */
export function creditCost(kind: SourceKind): number {
  if (kind === 'youtube') return 3;
  if (['facebook', 'instagram', 'threads', 'linkedin'].includes(kind)) return ENRICHMENT_CREDITS.socialPost;
  return documentCreditCost(kind);
}

function yamlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').trim() + '"';
}

/** Markdown with YAML frontmatter — the default response body (same shape as defuddle). */
export function formatMarkdown(result: ConvertResult, options: { frontmatter?: boolean } = {}): string {
  if (options.frontmatter === false) return result.content;
  const fm: string[] = ['---'];
  if (result.title) fm.push(`title: ${yamlString(result.title)}`);
  if (result.author) fm.push(`author: ${yamlString(result.author)}`);
  if (result.published) fm.push(`published: ${yamlString(result.published)}`);
  fm.push(`source: ${yamlString(result.source)}`);
  if (result.domain) fm.push(`domain: ${yamlString(result.domain)}`);
  if (result.site) fm.push(`site: ${yamlString(result.site)}`);
  if (result.language) fm.push(`language: ${yamlString(result.language)}`);
  if (result.description) fm.push(`description: ${yamlString(result.description)}`);
  if (result.image) fm.push(`image: ${yamlString(result.image)}`);
  fm.push(`kind: ${result.sourceKind}`);
  if (result.wordCount) fm.push(`word_count: ${result.wordCount}`);
  if (result.likes != null) fm.push(`likes: ${result.likes}`);
  if (result.retweets != null) fm.push(`retweets: ${result.retweets}`);
  if (result.replies != null) fm.push(`replies: ${result.replies}`);
  if (result.views != null) fm.push(`views: ${result.views}`);
  fm.push('---');
  const title = result.title.replace(/[\\`*_[\]{}<>#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  return fm.join('\n') + '\n\n' + (title && !/^#\s/.test(result.content) ? `# ${title}\n\n` : '') + result.content + '\n';
}
