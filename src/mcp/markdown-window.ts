/**
 * Character windows over long Markdown for MCP tool results. Clients cap how much one tool result
 * may carry, so read_url, convert_url and get_document return at most `maxChars` characters from
 * `offset` and say where the next window starts. Only the MCP result is windowed: the conversion,
 * its cache entry and the library row always hold the full Markdown.
 */
import { z } from 'zod';

export const MIN_WINDOW_CHARS = 1_000;
export const MAX_WINDOW_CHARS = 200_000;
/** About 10k tokens of English prose: fits client tool-result budgets even with the structured copy. */
export const DEFAULT_WINDOW_CHARS = 40_000;
/**
 * The default window also stops at this many cost units, where an ASCII character costs 1 and any
 * other UTF-16 unit costs 4. A tokenizer packs about four ASCII characters into a token but closer
 * to one CJK or accented character, so non-Latin pages get proportionally shorter default windows.
 */
export const DEFAULT_WINDOW_UNITS = 40_000;
const NON_ASCII_UNITS = 4;
/** A window may end early at a line break found within this last share of it. */
const LINE_BREAK_SLACK = 0.1;

export const markdownWindowInput = {
  offset: z.number().int().min(0).optional().describe('Character offset into the Markdown to start from (default 0); pass next_offset to read on'),
  maxChars: z.number().int().min(MIN_WINDOW_CHARS).max(MAX_WINDOW_CHARS).optional()
    .describe(`Most Markdown characters to return (${MIN_WINDOW_CHARS}-${MAX_WINDOW_CHARS}; by default up to ${DEFAULT_WINDOW_CHARS}, fewer for non-Latin text)`),
};

export interface MarkdownWindowArgs {
  offset?: number;
  maxChars?: number;
}

export interface MarkdownWindow {
  markdown: string;
  total_chars: number;
  offset: number;
  /** True when Markdown remains after this window. */
  truncated: boolean;
  /** Where the next window starts, or null when this window reaches the end. */
  next_offset: number | null;
}

/**
 * Slice `markdown` to `[offset, offset + maxChars)`, ending early at the last line break in the
 * window's final 10% so lines (and code-block rows) stay whole. Without `maxChars` the window is
 * also capped at DEFAULT_WINDOW_UNITS. An offset at or past the end gives an empty window with
 * `truncated: false` and `next_offset: null`.
 */
export function windowMarkdown(markdown: string, { offset = 0, maxChars }: MarkdownWindowArgs = {}): MarkdownWindow {
  const total = markdown.length;
  if (offset >= total) return { markdown: '', total_chars: total, offset, truncated: false, next_offset: null };
  // At least two units, so a window always advances past a surrogate pair.
  const size = Math.max(2, maxChars ?? defaultWindowChars(markdown, offset));
  let end = offset + size;
  if (end >= total) return { markdown: markdown.slice(offset), total_chars: total, offset, truncated: false, next_offset: null };
  const lineBreak = markdown.lastIndexOf('\n', end - 1);
  if (lineBreak >= end - Math.floor(size * LINE_BREAK_SLACK) && lineBreak >= offset) {
    end = lineBreak + 1;
  } else if (isHighSurrogate(markdown.charCodeAt(end - 1))) {
    // Never split a surrogate pair (emoji and other astral characters).
    end -= 1;
  }
  return { markdown: markdown.slice(offset, end), total_chars: total, offset, truncated: true, next_offset: end };
}

/** How many UTF-16 units from `offset` fit in DEFAULT_WINDOW_UNITS, at most DEFAULT_WINDOW_CHARS. */
function defaultWindowChars(markdown: string, offset: number): number {
  const stop = Math.min(markdown.length, offset + DEFAULT_WINDOW_CHARS);
  let units = 0;
  let i = offset;
  for (; i < stop; i++) {
    units += markdown.charCodeAt(i) < 0x80 ? 1 : NON_ASCII_UNITS;
    if (units > DEFAULT_WINDOW_UNITS) break;
  }
  return i < stop ? i - offset : DEFAULT_WINDOW_CHARS;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
