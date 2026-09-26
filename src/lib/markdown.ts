import { Marked, type Tokens } from 'marked';
import { escapeHtml, slugify } from './util';

export type Frontmatter = Record<string, string | string[]>;

/** Tiny YAML-frontmatter reader: `key: value`, quoted strings and `[a, b]` lists. */
export function parseFrontmatter(source: string): { data: Frontmatter; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: source };
  const data: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      data[m[1]] = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    data[m[1]] = value;
  }
  return { data, body: source.slice(match[0].length) };
}

export function fmString(data: Frontmatter, key: string, fallback = ''): string {
  const v = data[key];
  return Array.isArray(v) ? v.join(', ') : (v ?? fallback);
}

export function fmList(data: Frontmatter, key: string): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v;
  return v ? v.split(/[,\s]+/).filter(Boolean) : [];
}

export interface TocItem {
  depth: number;
  text: string;
  id: string;
}

/** Render trusted Markdown (our own content) to HTML with heading anchors; collects a TOC. */
export function renderMarkdown(markdown: string, options: { trusted?: boolean } = {}): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const seen = new Map<string, number>();
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const text = this.parser.parseInline(token.tokens);
        const plain = text.replace(/<[^>]+>/g, '');
        let id = slugify(plain) || 'section';
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (token.depth >= 2 && token.depth <= 3) toc.push({ depth: token.depth, text: plain, id });
        return `<h${token.depth} id="${id}"><a href="#${id}" class="no-underline">${text}</a></h${token.depth}>\n`;
      },
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        const href = token.href || '';
        if (/^\s*javascript:/i.test(href)) return text;
        const external = /^https?:\/\//.test(href) && !href.includes('anymd.cc');
        return `<a href="${escapeHtml(href)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}${external ? ' rel="noopener" target="_blank"' : ''}>${text}</a>`;
      },
      html(token: Tokens.HTML | Tokens.Tag) {
        // Untrusted Markdown (user documents) never gets raw HTML through.
        return options.trusted ? token.text : escapeHtml(token.text);
      },
      image(token: Tokens.Image) {
        const href = token.href || '';
        if (!/^(https?:)?\/\//.test(href) && !href.startsWith('/')) return escapeHtml(token.text);
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text)}" loading="lazy" decoding="async">`;
      },
    },
  });
  const html = marked.parse(markdown, { async: false }) as string;
  return { html, toc };
}

export function readingMinutes(markdown: string): number {
  return Math.max(1, Math.round(markdown.split(/\s+/).length / 230));
}
