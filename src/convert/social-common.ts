import { ENRICHMENT_CREDITS } from '../billing/plans';
import { normalizeTargetUrl } from './index';
import { ConvertError, countWords, type ConvertContext, type ConvertResult, type SourceKind } from './types';

export type Data = Record<string, unknown>;
export const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
export const string = (value: unknown): string => typeof value === 'string' ? value : '';
export function publicUrl(value: unknown): string {
  try { return normalizeTargetUrl(string(value)).href; } catch { return ''; }
}
export const plainMarkdown = (value: string) => value.replace(/[\\`*_[\]{}<>#!|~+.=\-]/g, '\\$&');
export const quote = (value: string) => plainMarkdown(value).split('\n').map((line) => `> ${line}`).join('\n');

export function socialResult(url: URL, kind: SourceKind, text: string, author: string, images: string[], published = ''): ConvertResult {
  const content = [plainMarkdown(text), ...[...new Set(images.map(publicUrl).filter(Boolean))].map((image) => `![Post image](<${image}>)`)].filter(Boolean).join('\n\n');
  if (!content) throw new ConvertError('Public post content is unavailable', 404, 'not_found');
  return { title: `${author || kind} post`, author, published, description: text.slice(0, 200), domain: url.hostname,
    content, wordCount: countWords(content), source: url.href, sourceKind: kind, site: kind };
}

export interface SocialComment { id: string; parent?: string; author: string; text: string }
export interface CommentPage { items: SocialComment[]; next?: string; complete?: boolean }

/** Charge only accepted unique comments; a failed page retains earlier successful pages. */
export async function collectComments(result: ConvertResult, ctx: ConvertContext, fetchPage: (cursor: string) => Promise<CommentPage>): Promise<void> {
  if (!ctx.includeComments || !ctx.budget) return;
  const state = { complete: true, count: 0, fetchedAt: new Date().toISOString(), reason: '', markdown: '' };
  result.enrichment ??= {};
  result.enrichment.comments = state;
  const comments = new Map<string, SocialComment>();
  const cursors = new Set<string>();
  let cursor = '';
  try {
    do {
      if (comments.size % ENRICHMENT_CREDITS.commentsPerBatch === 0 && !ctx.budget.canSpend(ENRICHMENT_CREDITS.commentBatch)) {
        state.complete = false; state.reason = 'credit_limit'; break;
      }
      const page = await fetchPage(cursor);
      if (page.complete === false) { state.complete = false; state.reason = 'source_incomplete'; }
      for (const item of page.items) {
        if (!item.id || comments.has(item.id)) continue;
        if (comments.size >= (ctx.maxComments ?? 100)) { state.complete = false; state.reason = 'comment_limit'; break; }
        if (comments.size % ENRICHMENT_CREDITS.commentsPerBatch === 0) {
          if (!ctx.budget.canSpend(ENRICHMENT_CREDITS.commentBatch)) { state.complete = false; state.reason = 'credit_limit'; break; }
          ctx.budget.charge('comments', ENRICHMENT_CREDITS.commentBatch);
        }
        comments.set(item.id, item);
      }
      cursor = page.next ?? '';
      if (!cursor) break;
      if (cursors.has(cursor)) { state.complete = false; state.reason = 'source_incomplete'; break; }
      cursors.add(cursor);
      if (comments.size >= (ctx.maxComments ?? 100)) { state.complete = false; state.reason = 'comment_limit'; break; }
      if (state.reason === 'credit_limit') break;
    } while (cursor);
  } catch (error) { state.complete = false; state.reason = error instanceof ConvertError ? error.code : 'source_incomplete'; }
  state.count = comments.size;
  state.markdown = [...comments.values()].map((comment) => `${quote(comment.author)}${comment.parent ? `\n> Reply to ${comment.parent}` : ''}\n\n${quote(comment.text)}`).join('\n\n');
}

export function requireSocialAccount(ctx: ConvertContext): void {
  if (!ctx.authenticated) throw new ConvertError('Social post conversion requires an account', 401, 'authentication_required');
}
