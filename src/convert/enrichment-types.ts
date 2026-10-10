import { z } from 'zod';
import { READING_LIMITS, type ReadingLimitKey } from '../lib/reading-options';

const bounded = (key: ReadingLimitKey) => z.number().int().min(READING_LIMITS[key].min).max(READING_LIMITS[key].max);

/**
 * Per-request conversion options shared by REST, MCP and the URL API. Every field is optional:
 * an omitted field falls back to the caller's saved reading preference, then the safe default.
 */
export const enrichmentOptions = {
  expandThread: z.boolean().optional().describe('Expand the rooted same-author X thread (extra credits, account required)'),
  maxThreadPosts: bounded('maxThreadPosts').optional().describe('Maximum thread posts including the requested post (1-100, default 20)'),
  includeComments: z.boolean().optional().describe('Retrieve comments and replies (extra credits, account required)'),
  analyzeImages: z.boolean().optional().describe('OCR and describe article images (extra credits, account required)'),
  maxComments: bounded('maxComments').optional().describe('Maximum comments including replies (1-1000, default 100)'),
  maxImages: bounded('maxImages').optional().describe('Maximum analyzed article images (1-20, default 10)'),
  maxCredits: bounded('maxCredits').optional().describe('Credit cap for this request (1-1000, default 100)'),
  downloadVideo: z.boolean().optional().describe('YouTube: download the lowest-quality video to the anymd CDN in the background (20 credits when ready, account required; not part of maxCredits)'),
  analyzeVideo: z.boolean().optional().describe('YouTube: download and analyze the video with google/gemini-3.8-flash (10 + 20 credits per started minute when ready, up to 60 minutes; implies downloadVideo, account required; not part of maxCredits)'),
};
export const EnrichmentOptionsSchema = z.object(enrichmentOptions);
export type EnrichmentOptions = z.infer<typeof EnrichmentOptionsSchema>;
export interface Coverage {
  complete: boolean;
  count: number;
  reason?: string;
  fetchedAt: string;
}
export interface Enrichment {
  thread?: Coverage;
  comments?: Coverage & { markdown: string };
  images?: Coverage & { items: { url: string; markdown: string }[] };
}
export interface CreditBreakdown {
  base: number;
  thread: number;
  comments: number;
  images: number;
}

/** Only successfully returned units consume the caller's budget. */
export class ConversionBudget {
  readonly breakdown: CreditBreakdown = { base: 0, thread: 0, comments: 0, images: 0 };
  readonly deadline = Date.now() + 55_000;
  calls = 0;
  constructor(readonly limit: number) {}
  get used(): number { return Object.values(this.breakdown).reduce((a, b) => a + b, 0); }
  canSpend(credits: number): boolean { return this.used + credits <= this.limit; }
  charge(kind: keyof CreditBreakdown, credits: number): void {
    if (!this.canSpend(credits)) throw new Error('Conversion budget exceeded');
    this.breakdown[kind] += credits;
  }
  canFetch(): boolean { return Date.now() < this.deadline && this.calls < 40; }
}
