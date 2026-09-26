/**
 * Usage-based pricing. 1 credit = one web page converted. Heavier sources cost more credits
 * (see `creditCost`). Search, library reads and MCP reads are free — they drive retention.
 */
export type PlanId = 'free' | 'pro' | 'scale' | 'enterprise';

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  monthly: number; // USD per month, billed monthly
  yearly: number; // USD per month, billed yearly
  credits: number; // included credits per month
  overagePer1k: number | null; // USD per 1,000 credits beyond the included amount (null = hard cap)
  libraryLimit: number | null;
  rateLimitPerMin: number;
  features: string[];
  highlight?: boolean;
}

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'For trying it on real work.',
    monthly: 0,
    yearly: 0,
    credits: 500,
    overagePer1k: null,
    libraryLimit: 1000,
    rateLimitPerMin: 20,
    features: [
      '500 credits / month',
      'Library up to 1,000 docs',
      'BM25 + full-text + semantic search',
      'API, CLI, MCP & WebMCP',
      '2 API keys',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For builders and power users.',
    monthly: 9,
    yearly: 7,
    credits: 10_000,
    overagePer1k: null,
    libraryLimit: null,
    rateLimitPerMin: 120,
    highlight: true,
    features: [
      '10,000 credits / month',
      'Unlimited library',
      'Query fan-out + Jev re-ranking',
      'Unlimited API keys & OAuth apps',
      'Move up to Scale any time',
      'Traces & 90-day usage logs',
    ],
  },
  {
    id: 'scale',
    name: 'Scale',
    tagline: 'For teams and agent fleets.',
    monthly: 49,
    yearly: 39,
    credits: 100_000,
    overagePer1k: null,
    libraryLimit: null,
    rateLimitPerMin: 600,
    features: [
      '100,000 credits / month',
      'Everything in Pro',
      'Custom volume on Enterprise',
      'Priority conversion queue',
      'Role-scoped keys for your team',
      'Email support within 1 business day',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Volume, SLAs, private deployments.',
    monthly: -1,
    yearly: -1,
    credits: 1_000_000,
    overagePer1k: 0.4,
    libraryLimit: null,
    rateLimitPerMin: 3000,
    features: ['Custom credit volume', 'SLA & DPA', 'SSO & audit exports', 'Self-host on your Cloudflare account'],
  },
];

export const ANONYMOUS_DAILY_LIMIT = 50;

export function getPlan(id: string | null | undefined): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

/** Credit costs by source kind — mirrored on the pricing page. */
export const CREDIT_TABLE: { kind: string; label: string; credits: number }[] = [
  { kind: 'web', label: 'Web page, GitHub, Reddit, Hacker News, X post', credits: 1 },
  { kind: 'youtube', label: 'YouTube video with transcript', credits: 3 },
  { kind: 'pdf', label: 'PDF, DOCX, XLSX, CSV (per file)', credits: 3 },
  { kind: 'image', label: 'Image → Markdown (vision description)', credits: 5 },
  { kind: 'search', label: 'Library search, reads, MCP reads', credits: 0 },
];

/** Launch offer shown to returning visitors; codes are created in the billing provider with the same name. */
export const LAUNCH_OFFER = {
  code: 'LAUNCH30',
  percent: 30,
  endsAt: Date.UTC(2026, 9, 31, 23, 59, 59), // 31 Oct 2026, end of day UTC
  returnVisitorCode: 'COMEBACK20',
  returnVisitorPercent: 20,
  returnVisitorHours: 48,
};
