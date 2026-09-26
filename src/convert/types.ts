import type { Env } from '../env';
import type { Tracer } from '../lib/tracer';

export type SourceKind =
  | 'web'
  | 'x'
  | 'youtube'
  | 'github'
  | 'hackernews'
  | 'reddit'
  | 'pdf'
  | 'image'
  | 'document'
  | 'text';

export interface ConvertResult {
  title: string;
  author: string;
  published: string;
  description: string;
  domain: string;
  content: string; // Markdown body
  contentHtml?: string;
  wordCount: number;
  source: string;
  sourceKind: SourceKind;
  language?: string;
  favicon?: string;
  image?: string;
  site?: string;
  /** Size of the fetched HTML, for the "smaller than HTML" ratio. */
  sourceBytes?: number;
  // Engagement stats (X/Twitter only)
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number | null;
}

export interface ConvertContext {
  env: Env;
  tracer: Tracer;
  language?: string;
  /** Extra CSS selector to treat as main content (advanced). */
  selector?: string;
  removeImages?: boolean;
}

export interface SourceAdapter {
  kind: SourceKind;
  /** Cheap URL test. Adapters are tried in order; the web adapter is the fallback. */
  matches(url: URL): boolean;
  convert(url: URL, ctx: ConvertContext): Promise<ConvertResult>;
}

export class ConvertError extends Error {
  constructor(
    message: string,
    public status = 502,
    public code = 'convert_failed',
  ) {
    super(message);
  }
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export const USER_AGENT = 'Mozilla/5.0 (compatible; anymd/1.0; +https://anymd.cc)';
export const BOT_USER_AGENT = USER_AGENT + ' bot';
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
