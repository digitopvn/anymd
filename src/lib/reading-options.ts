/**
 * Reading (deep reading) option bounds, safe defaults and the worst-case credit estimate.
 * Dependency-free apart from the credit table so the browser converter can share it with the
 * Worker: the server validates with zod in `src/convert/reading-preferences.ts`.
 */
import { ENRICHMENT_CREDITS } from '../billing/plans';

/** Inclusive integer bounds and the safe default for every bounded reading option. */
export const READING_LIMITS = {
  maxThreadPosts: { min: 1, max: 100, default: 20 },
  maxComments: { min: 1, max: 1000, default: 100 },
  maxImages: { min: 1, max: 20, default: 10 },
  maxCredits: { min: 1, max: 1000, default: 100 },
} as const;

export type ReadingLimitKey = keyof typeof READING_LIMITS;

/** A user's saved reading defaults. Every credit-consuming enrichment is a separate opt-in. */
export interface ReadingPreferences {
  expandThread: boolean;
  maxThreadPosts: number;
  includeComments: boolean;
  maxComments: number;
  /** Keep image/media references from the source. Zero extra credits; maps to `images=0|1`. */
  keepImages: boolean;
  analyzeImages: boolean;
  maxImages: number;
  maxCredits: number;
  /** Download the lowest-quality YouTube video to the anymd CDN in the background (extra credits, charged when ready). */
  downloadVideo: boolean;
}

/**
 * The safe system default: base conversion only. Authentication alone never turns on an option
 * that can spend enrichment credits.
 */
export const DEFAULT_READING_PREFERENCES: Readonly<ReadingPreferences> = Object.freeze({
  expandThread: false,
  maxThreadPosts: READING_LIMITS.maxThreadPosts.default,
  includeComments: false,
  maxComments: READING_LIMITS.maxComments.default,
  keepImages: true,
  analyzeImages: false,
  maxImages: READING_LIMITS.maxImages.default,
  maxCredits: READING_LIMITS.maxCredits.default,
  downloadVideo: false,
});

/** Options that spend enrichment credits when on. */
export const PAID_READING_TOGGLES = ['expandThread', 'includeComments', 'analyzeImages'] as const;

export type ReadingEstimateInput = Pick<ReadingPreferences, 'expandThread' | 'maxThreadPosts' | 'includeComments' | 'maxComments' | 'analyzeImages' | 'maxImages'>;

/**
 * Worst-case extra credits from enabled enrichment, before the per-request `maxCredits` cap.
 * The requested post itself is the base conversion, so a thread adds at most maxThreadPosts - 1.
 */
export function maxEnrichmentCredits(o: ReadingEstimateInput): { thread: number; comments: number; images: number; total: number } {
  const thread = o.expandThread ? Math.max(0, o.maxThreadPosts - 1) * ENRICHMENT_CREDITS.threadPost : 0;
  const comments = o.includeComments ? Math.ceil(o.maxComments / ENRICHMENT_CREDITS.commentsPerBatch) * ENRICHMENT_CREDITS.commentBatch : 0;
  const images = o.analyzeImages ? o.maxImages * ENRICHMENT_CREDITS.image : 0;
  return { thread, comments, images, total: thread + comments + images };
}

const plural = (n: number) => `${n} credit${n === 1 ? '' : 's'}`;

/** Bounded credit impact shown before submission (server-rendered, refreshed in the browser). */
export function creditEstimateText(v: ReadingEstimateInput & Pick<ReadingPreferences, 'maxCredits'>): string {
  const extra = maxEnrichmentCredits(v).total;
  if (!extra) return `Base conversion only: no extra credits. Each conversion is capped at ${plural(v.maxCredits)}.`;
  return `Deep reading can add up to ${plural(Math.min(extra, v.maxCredits))}; each conversion is capped at ${plural(v.maxCredits)} including the base price.`;
}
