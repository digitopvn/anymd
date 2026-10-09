import { z } from 'zod';

export const enrichmentOptions = {
  includeComments: z.boolean().optional(),
  analyzeImages: z.boolean().optional(),
  maxComments: z.number().int().min(1).max(1000).optional(),
  maxImages: z.number().int().min(1).max(20).optional(),
  maxCredits: z.number().int().min(1).max(1000).optional(),
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
