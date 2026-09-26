/** Hacker News adapter — story + top comment threads via the official Firebase API. */
import { countWords, ConvertError, type ConvertContext, type ConvertResult, type SourceAdapter } from './types';
import { htmlFragmentToMarkdown } from './html-to-markdown';

interface HnItem {
  id: number;
  type: 'story' | 'comment' | 'job' | 'poll' | 'pollopt';
  by?: string;
  time?: number;
  text?: string;
  title?: string;
  url?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  deleted?: boolean;
  dead?: boolean;
}

const API = 'https://hacker-news.firebaseio.com/v0/item';
const MAX_TOP_LEVEL = 20;
const MAX_REPLIES = 3;

async function item(id: number): Promise<HnItem | null> {
  const r = await fetch(`${API}/${id}.json`);
  if (!r.ok) return null;
  return (await r.json()) as HnItem | null;
}

function quote(md: string, depth: number): string {
  const prefix = '> '.repeat(depth);
  return md
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

async function renderComment(c: HnItem, depth: number): Promise<string> {
  if (!c || c.deleted || c.dead || !c.text) return '';
  const body = htmlFragmentToMarkdown(c.text);
  let out = quote(`**${c.by ?? 'unknown'}** · ${new Date((c.time ?? 0) * 1000).toISOString().slice(0, 10)}\n\n${body}`, depth);
  if (depth < 3 && c.kids?.length) {
    const replies = await Promise.all(c.kids.slice(0, MAX_REPLIES).map(item));
    for (const r of replies) {
      if (r) {
        const rendered = await renderComment(r, depth + 1);
        if (rendered) out += '\n>\n' + rendered;
      }
    }
  }
  return out;
}

async function convertHn(url: URL, ctx: ConvertContext): Promise<ConvertResult> {
  const id = Number(url.searchParams.get('id'));
  if (!id) throw new ConvertError('Missing Hacker News item id', 400, 'invalid_url');
  const story = await ctx.tracer.span('hn.item', () => item(id));
  if (!story) throw new ConvertError('Hacker News item not found', 404, 'not_found');

  const parts: string[] = [];
  const meta = [`${story.score ?? 0} points`, `by ${story.by}`, `${story.descendants ?? 0} comments`];
  parts.push(`*${meta.join(' · ')}*`);
  if (story.url) parts.push(`**Link:** <${story.url}>`);
  if (story.text) parts.push(htmlFragmentToMarkdown(story.text));

  const kids = (story.kids ?? []).slice(0, MAX_TOP_LEVEL);
  if (kids.length) {
    const comments = await ctx.tracer.span('hn.comments', () => Promise.all(kids.map(item)), { count: kids.length });
    parts.push('## Comments');
    for (const c of comments) {
      if (!c) continue;
      const rendered = await renderComment(c, 1);
      if (rendered) parts.push(rendered);
    }
  }
  const content = parts.join('\n\n');
  const title = story.title ?? (story.text ? 'Hacker News comment' : `HN item ${id}`);
  return {
    title,
    author: story.by ?? '',
    published: story.time ? new Date(story.time * 1000).toISOString() : '',
    description: title,
    domain: 'news.ycombinator.com',
    content,
    wordCount: countWords(content),
    source: url.href,
    sourceKind: 'hackernews',
    site: 'Hacker News',
  };
}

export const hackerNewsAdapter: SourceAdapter = {
  kind: 'hackernews',
  matches: (url) => url.hostname === 'news.ycombinator.com' && url.pathname === '/item' && url.searchParams.has('id'),
  convert: convertHn,
};
