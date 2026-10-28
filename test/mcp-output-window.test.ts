import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal, RoleName } from '../src/env';
import { DEFAULT_WINDOW_CHARS, windowMarkdown } from '../src/mcp/markdown-window';
import { callTool } from './helpers/mcp-client';
import { createTestEnv, seedUser, type TestEnv } from './helpers/sqlite-env';

describe('windowMarkdown', () => {
  const lines = (n: number, width = 99) => Array.from({ length: n }, (_, i) => `${String(i).padStart(4, '0')}${'x'.repeat(width - 4)}`).join('\n');

  it('returns a short page whole', () => {
    expect(windowMarkdown('# Title\n\nBody')).toEqual({ markdown: '# Title\n\nBody', total_chars: 13, offset: 0, truncated: false, next_offset: null });
  });

  it('defaults to DEFAULT_WINDOW_CHARS and ends at a line break near the window end', () => {
    const md = lines(1000); // 100 chars per line with its newline
    const w = windowMarkdown(md);
    expect(w.truncated).toBe(true);
    expect(w.markdown.length).toBeLessThanOrEqual(DEFAULT_WINDOW_CHARS);
    expect(w.markdown.length).toBeGreaterThan(DEFAULT_WINDOW_CHARS * 0.9);
    expect(w.markdown.endsWith('\n')).toBe(true);
    expect(w.next_offset).toBe(w.markdown.length);
  });

  it('pages through the whole text without gaps or overlap, the last page untruncated', () => {
    const md = lines(250, 37);
    const parts: string[] = [];
    let offset: number | null = 0;
    let last = windowMarkdown(md, { offset: 0, maxChars: 1000 });
    while (offset !== null) {
      last = windowMarkdown(md, { offset, maxChars: 1000 });
      expect(last.offset).toBe(offset);
      expect(last.total_chars).toBe(md.length);
      parts.push(last.markdown);
      offset = last.next_offset;
    }
    expect(parts.join('')).toBe(md);
    expect(parts.length).toBeGreaterThan(2);
    expect(last).toMatchObject({ truncated: false, next_offset: null });
  });

  it('cuts at exactly maxChars when no line break is in the last 10%', () => {
    const md = 'a'.repeat(5000);
    expect(windowMarkdown(md, { offset: 100, maxChars: 1000 })).toEqual({ markdown: 'a'.repeat(1000), total_chars: 5000, offset: 100, truncated: true, next_offset: 1100 });
  });

  it('does not split a surrogate pair at a hard cut', () => {
    const md = `${'a'.repeat(999)}😀${'b'.repeat(2000)}`;
    const w = windowMarkdown(md, { maxChars: 1000 });
    expect(w.markdown).toBe('a'.repeat(999));
    expect(w.next_offset).toBe(999);
  });

  it('returns an empty, untruncated window for an offset at or past the end', () => {
    expect(windowMarkdown('short', { offset: 5 })).toEqual({ markdown: '', total_chars: 5, offset: 5, truncated: false, next_offset: null });
    expect(windowMarkdown('short', { offset: 999 })).toEqual({ markdown: '', total_chars: 5, offset: 999, truncated: false, next_offset: null });
  });
});

// ─── MCP tools end to end over SQLite ─────────────────────────────────────────

const PAGE_URL = 'https://docs.example.com/long-spec';
const PARAGRAPHS = 1200;
const html = (paragraphs: number) => `<!doctype html><html><head><title>Long spec</title></head><body><article><h1>Long spec</h1>${
  Array.from({ length: paragraphs }, (_, i) => `<p>Paragraph ${i}: the quick brown fox jumps over the lazy dog, again and again, until the page is long.</p>`).join('')
}</article></body></html>`;

let t: TestEnv;
let principal: Principal;
let fetches: string[];

function stubPage(paragraphs: number) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    fetches.push(String(input instanceof Request ? input.url : input));
    return new Response(html(paragraphs), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }));
}

beforeEach(async () => {
  t = createTestEnv();
  const user = await seedUser(t, 'user', { plan: 'pro' });
  principal = { kind: 'api_key', userId: user.id, role: user.role as RoleName, scopes: ['convert', 'library:read', 'library:write'] };
  fetches = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  t.close();
});

describe('MCP read_url output window', () => {
  it('windows a long page, keeps text and structuredContent in step, and pages from cache for free', async () => {
    stubPage(PARAGRAPHS);
    const first = await callTool(t.env, principal, 'read_url', { url: PAGE_URL });
    expect(first.result.isError).toBeUndefined();
    const s1 = first.result.structuredContent;
    expect(s1.cached).toBe(false);
    expect(s1.credits).toBeGreaterThan(0);
    expect(s1.saved).toBe(true);
    expect(s1.total_chars).toBeGreaterThan(DEFAULT_WINDOW_CHARS);
    expect(s1).toMatchObject({ offset: 0, truncated: true });
    expect(s1.markdown.length).toBeLessThanOrEqual(DEFAULT_WINDOW_CHARS);
    expect(s1.next_offset).toBe(s1.markdown.length);
    // The text block is the same window as the structured copy, and the metadata block carries the paging fields.
    expect(first.result.content[0].text).toBe(s1.markdown);
    expect(JSON.parse(first.result.content[1].text)).toMatchObject({ total_chars: s1.total_chars, offset: 0, truncated: true, next_offset: s1.next_offset });

    const parts = [s1.markdown];
    let next: number | null = s1.next_offset;
    let last = s1;
    while (next !== null) {
      const page = await callTool(t.env, principal, 'convert_url', { url: PAGE_URL, offset: next, maxChars: 20_000 });
      last = page.result.structuredContent;
      expect(last).toMatchObject({ cached: true, credits: 0, offset: next, total_chars: s1.total_chars, document_id: s1.document_id });
      expect(page.result.content[0].text).toBe(last.markdown);
      parts.push(last.markdown);
      next = last.next_offset;
    }
    expect(last).toMatchObject({ truncated: false, next_offset: null });
    expect(parts.length).toBeGreaterThan(2);

    // One upstream fetch, one library row, and the saved copy holds the full Markdown.
    expect(fetches.filter((u) => u === PAGE_URL).length).toBe(1);
    const rows = t.db.prepare('SELECT markdown FROM documents WHERE user_id = ?').all(principal.userId) as { markdown: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.markdown.length).toBeGreaterThanOrEqual(parts.join('').length - 1000);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE status = 'cached'").get()).toEqual({ n: parts.length - 1 });
  });

  it('returns a short page whole', async () => {
    stubPage(3);
    const { result } = await callTool(t.env, principal, 'read_url', { url: PAGE_URL, save: false });
    const s = result.structuredContent;
    expect(s).toMatchObject({ offset: 0, truncated: false, next_offset: null });
    expect(s.total_chars).toBe(s.markdown.length);
    expect(result.content[0].text).toBe(s.markdown);
  });

  it('returns an empty window past the end', async () => {
    stubPage(3);
    const { result } = await callTool(t.env, principal, 'read_url', { url: PAGE_URL, save: false, offset: 1_000_000 });
    expect(result.structuredContent).toMatchObject({ markdown: '', offset: 1_000_000, truncated: false, next_offset: null });
  });

  it('rejects out-of-range window arguments', async () => {
    for (const args of [{ offset: -1 }, { maxChars: 10 }, { maxChars: 500_000 }, { offset: 1.5 }]) {
      const { result } = await callTool(t.env, principal, 'read_url', { url: PAGE_URL, ...args });
      expect(result.isError).toBe(true);
      expect(result.content[0].text.startsWith('Invalid arguments')).toBe(true);
    }
    expect(fetches).toEqual([]);
  });
});

describe('MCP get_document output window', () => {
  it('windows a long library document', async () => {
    stubPage(PARAGRAPHS);
    const read = await callTool(t.env, principal, 'read_url', { url: PAGE_URL });
    const id = read.result.structuredContent.document_id as string;
    const full = (t.db.prepare('SELECT markdown FROM documents WHERE id = ?').get(id) as { markdown: string }).markdown;

    const first = (await callTool(t.env, principal, 'get_document', { id, maxChars: 30_000 })).result;
    expect(first.structuredContent).toMatchObject({ id, offset: 0, truncated: true, total_chars: full.length });
    expect(full.startsWith(first.structuredContent.markdown)).toBe(true);
    expect(JSON.parse(first.content[0].text).markdown).toBe(first.structuredContent.markdown);

    const rest = (await callTool(t.env, principal, 'get_document', { id, offset: first.structuredContent.next_offset, maxChars: 200_000 })).result.structuredContent;
    expect(rest).toMatchObject({ truncated: false, next_offset: null });
    expect(first.structuredContent.markdown + rest.markdown).toBe(full);

    const past = (await callTool(t.env, principal, 'get_document', { id, offset: full.length })).result.structuredContent;
    expect(past).toMatchObject({ markdown: '', truncated: false, next_offset: null });
  });
});
