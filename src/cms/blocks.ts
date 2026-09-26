/**
 * Page-builder block registry. Each block has a stable `type`, a `version`, a zod props schema
 * (exported as JSON Schema to agents), allowed sizes, optional slots, and a Markdown serializer so
 * every built page has a `.md` twin. Rendering lives in `render.tsx`.
 */
import { z } from 'zod';

export const SIZES = ['small', 'medium', 'large'] as const;
export type BlockSize = (typeof SIZES)[number];

const link = z.object({ label: z.string().min(1).max(60), href: z.string().min(1).max(500) });
const ICONS = [
  'globe', 'bolt', 'sparkles', 'lock', 'shield', 'code', 'terminal', 'plug', 'book', 'layers', 'chart', 'key', 'search',
  'clock', 'star', 'gift', 'file', 'image', 'play', 'chat', 'check', 'activity', 'users',
] as const;

export interface BlockDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  type: string;
  version: number;
  label: string;
  description: string;
  category: 'hero' | 'content' | 'conversion' | 'social-proof' | 'layout' | 'product';
  schema: S;
  sizes: readonly BlockSize[];
  defaultSize: BlockSize;
  slots?: string[];
  example: z.infer<S>;
  toMarkdown(props: z.infer<S>): string;
}

function define<S extends z.ZodTypeAny>(def: BlockDefinition<S>): BlockDefinition<S> {
  return def;
}

const md = {
  cta: (l?: { label: string; href: string }) => (l ? `[${l.label}](${l.href})` : ''),
  join: (...parts: (string | false | undefined | null)[]) => parts.filter(Boolean).join('\n\n'),
};

export const BLOCKS = [
  define({
    type: 'hero',
    version: 1,
    label: 'Hero',
    description: 'Page opener: headline, subtitle, up to two CTAs, optional live converter.',
    category: 'hero',
    schema: z.object({
      eyebrow: z.string().max(80).optional(),
      title: z.string().min(1).max(140),
      subtitle: z.string().max(400).optional(),
      primary: link.optional(),
      secondary: link.optional(),
      showConverter: z.boolean().default(false),
      align: z.enum(['center', 'left']).default('center'),
    }),
    sizes: SIZES,
    defaultSize: 'large',
    example: { eyebrow: 'For researchers', title: 'Turn any paper into Markdown', subtitle: 'PDFs, arXiv pages and blogs — clean text for your notes and agents.', primary: { label: 'Start free', href: '/signup' }, showConverter: true, align: 'center' },
    toMarkdown: (p) => md.join(p.eyebrow && `_${p.eyebrow}_`, `# ${p.title}`, p.subtitle, [md.cta(p.primary), md.cta(p.secondary)].filter(Boolean).join(' · ')),
  }),
  define({
    type: 'rich-text',
    version: 1,
    label: 'Rich text',
    description: 'Free-form Markdown content (headings, lists, tables, code, links).',
    category: 'content',
    schema: z.object({ markdown: z.string().min(1).max(40000), width: z.enum(['narrow', 'wide']).default('narrow') }),
    sizes: SIZES,
    defaultSize: 'medium',
    example: { markdown: '## Why Markdown\n\nModels read structure. Markdown keeps it.', width: 'narrow' },
    toMarkdown: (p) => p.markdown,
  }),
  define({
    type: 'feature-grid',
    version: 1,
    label: 'Feature grid',
    description: 'Grid of features with icon, title and body.',
    category: 'content',
    schema: z.object({
      eyebrow: z.string().max(80).optional(),
      title: z.string().max(140).optional(),
      lead: z.string().max(400).optional(),
      columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
      items: z.array(z.object({ icon: z.enum(ICONS).default('sparkles'), title: z.string().min(1).max(80), body: z.string().max(300) })).min(1).max(12),
    }),
    sizes: SIZES,
    defaultSize: 'medium',
    example: { title: 'Why teams pick anymd', columns: 3, items: [{ icon: 'bolt', title: 'Fast', body: 'Edge-cached conversions.' }] },
    toMarkdown: (p) => md.join(p.title && `## ${p.title}`, p.lead, p.items.map((i) => `- **${i.title}** — ${i.body}`).join('\n')),
  }),
  define({
    type: 'steps',
    version: 1,
    label: 'Steps',
    description: 'Numbered how-it-works steps.',
    category: 'content',
    schema: z.object({
      title: z.string().max(140).optional(),
      items: z.array(z.object({ title: z.string().min(1).max(80), body: z.string().max(300), code: z.string().max(120).optional() })).min(1).max(6),
    }),
    sizes: SIZES,
    defaultSize: 'medium',
    example: { title: 'How it works', items: [{ title: 'Paste a link', body: 'Any URL works.' }] },
    toMarkdown: (p) => md.join(p.title && `## ${p.title}`, p.items.map((i, n) => `${n + 1}. **${i.title}** — ${i.body}`).join('\n')),
  }),
  define({
    type: 'stats',
    version: 1,
    label: 'Stats',
    description: 'Row of big numbers with labels.',
    category: 'social-proof',
    schema: z.object({ items: z.array(z.object({ value: z.string().min(1).max(20), label: z.string().min(1).max(80) })).min(1).max(6) }),
    sizes: SIZES,
    defaultSize: 'small',
    example: { items: [{ value: '9', label: 'source types' }] },
    toMarkdown: (p) => p.items.map((i) => `- **${i.value}** ${i.label}`).join('\n'),
  }),
  define({
    type: 'logo-cloud',
    version: 1,
    label: 'Logo cloud',
    description: 'Row of logos (partners, ecosystem, customers).',
    category: 'social-proof',
    schema: z.object({
      title: z.string().max(140).optional(),
      logos: z.array(z.object({ src: z.string().min(1).max(500), alt: z.string().min(1).max(80), href: z.string().max(500).optional() })).min(1).max(16),
    }),
    sizes: SIZES,
    defaultSize: 'small',
    example: { title: 'Part of the Digitop ecosystem', logos: [{ src: '/brand/agentkit.svg', alt: 'AgentKit', href: 'https://agentkit.best' }] },
    toMarkdown: (p) => md.join(p.title && `## ${p.title}`, p.logos.map((l) => (l.href ? `- [${l.alt}](${l.href})` : `- ${l.alt}`)).join('\n')),
  }),
  define({
    type: 'code-tabs',
    version: 1,
    label: 'Code tabs',
    description: 'Tabbed code samples.',
    category: 'product',
    schema: z.object({
      title: z.string().max(140).optional(),
      tabs: z.array(z.object({ label: z.string().min(1).max(30), language: z.string().max(20).default(''), code: z.string().min(1).max(4000) })).min(1).max(8),
    }),
    sizes: SIZES,
    defaultSize: 'medium',
    example: { title: 'Use it anywhere', tabs: [{ label: 'cURL', language: 'bash', code: 'curl https://anymd.cc/example.com' }] },
    toMarkdown: (p) => md.join(p.title && `## ${p.title}`, ...p.tabs.map((t) => `**${t.label}**\n\n\`\`\`${t.language}\n${t.code}\n\`\`\``)),
  }),
  define({
    type: 'pricing',
    version: 1,
    label: 'Pricing table',
    description: 'Live plan cards from the billing catalog (always current prices).',
    category: 'conversion',
    schema: z.object({ title: z.string().max(140).optional(), lead: z.string().max(400).optional(), showCredits: z.boolean().default(false) }),
    sizes: ['medium', 'large'],
    defaultSize: 'large',
    example: { title: 'Simple pricing', showCredits: true },
    toMarkdown: (p) => md.join(p.title && `## ${p.title}`, p.lead, 'Free — 500 credits/mo · Pro $9/mo — 10,000 credits · Scale $49/mo — 100,000 credits · Enterprise — custom. Details: https://anymd.cc/pricing'),
  }),
  define({
    type: 'faq',
    version: 1,
    label: 'FAQ',
    description: 'Accordion of questions and answers (adds FAQPage schema).',
    category: 'content',
    schema: z.object({ title: z.string().max(140).optional(), items: z.array(z.object({ q: z.string().min(1).max(200), a: z.string().min(1).max(1200) })).min(1).max(20) }),
    sizes: SIZES,
    defaultSize: 'medium',
    example: { title: 'FAQ', items: [{ q: 'Is it free?', a: 'Yes, 500 credits every month.' }] },
    toMarkdown: (p) => md.join(p.title && `## ${p.title}`, ...p.items.map((i) => `### ${i.q}\n\n${i.a}`)),
  }),
  define({
    type: 'testimonial',
    version: 1,
    label: 'Quote',
    description: 'A single quote with attribution. Only use real, attributable quotes.',
    category: 'social-proof',
    schema: z.object({ quote: z.string().min(1).max(500), author: z.string().min(1).max(80), role: z.string().max(120).optional(), avatar: z.string().max(500).optional() }),
    sizes: SIZES,
    defaultSize: 'medium',
    example: { quote: 'Agents don’t need prettier websites. They need cleaner text.', author: 'Duy /zuey/', role: 'Founder, Digitop.ai' },
    toMarkdown: (p) => `> ${p.quote}\n>\n> — ${p.author}${p.role ? `, ${p.role}` : ''}`,
  }),
  define({
    type: 'cta',
    version: 1,
    label: 'Call to action',
    description: 'Closing banner with headline and buttons.',
    category: 'conversion',
    schema: z.object({ title: z.string().min(1).max(140), body: z.string().max(300).optional(), primary: link, secondary: link.optional(), tone: z.enum(['accent', 'dark', 'light']).default('accent') }),
    sizes: SIZES,
    defaultSize: 'large',
    example: { title: 'Stop feeding your agent HTML.', primary: { label: 'Start free', href: '/signup' }, tone: 'accent' },
    toMarkdown: (p) => md.join(`## ${p.title}`, p.body, [md.cta(p.primary), md.cta(p.secondary)].filter(Boolean).join(' · ')),
  }),
  define({
    type: 'offer',
    version: 1,
    label: 'Limited offer',
    description: 'Discount banner with a live countdown to a real end date.',
    category: 'conversion',
    schema: z.object({ title: z.string().min(1).max(140), code: z.string().min(2).max(30), percent: z.number().int().min(1).max(90), endsAt: z.string().datetime(), href: z.string().max(500).default('/pricing') }),
    sizes: ['small', 'medium'],
    defaultSize: 'small',
    example: { title: 'Launch week', code: 'LAUNCH30', percent: 30, endsAt: '2026-10-31T23:59:59Z', href: '/pricing' },
    toMarkdown: (p) => `**${p.title}:** ${p.percent}% off with code \`${p.code}\` until ${p.endsAt.slice(0, 10)}. [Claim it](${p.href})`,
  }),
  define({
    type: 'image',
    version: 1,
    label: 'Image',
    description: 'Image with alt text and optional caption (host on cdn.anymd.cc).',
    category: 'content',
    schema: z.object({ src: z.string().min(1).max(500), alt: z.string().min(1).max(200), caption: z.string().max(300).optional(), rounded: z.boolean().default(true) }),
    sizes: SIZES,
    defaultSize: 'medium',
    example: { src: 'https://anymd.cc/og/share.jpg', alt: 'anymd social card', rounded: true },
    toMarkdown: (p) => md.join(`![${p.alt}](${p.src})`, p.caption && `_${p.caption}_`),
  }),
  define({
    type: 'comparison',
    version: 1,
    label: 'Comparison table',
    description: 'Feature comparison across columns (e.g., anymd vs alternatives).',
    category: 'content',
    schema: z.object({
      title: z.string().max(140).optional(),
      columns: z.array(z.string().min(1).max(40)).min(2).max(6),
      rows: z.array(z.object({ label: z.string().min(1).max(80), values: z.array(z.string().max(80)) })).min(1).max(30),
      highlight: z.number().int().min(0).max(5).default(0),
    }),
    sizes: ['medium', 'large'],
    defaultSize: 'medium',
    example: { title: 'Compared', columns: ['anymd', 'Copy & paste'], rows: [{ label: 'Removes clutter', values: ['Yes', 'No'] }], highlight: 0 },
    toMarkdown: (p) =>
      md.join(
        p.title && `## ${p.title}`,
        [`| | ${p.columns.join(' | ')} |`, `|---|${p.columns.map(() => '---').join('|')}|`, ...p.rows.map((r) => `| ${r.label} | ${p.columns.map((_, i) => r.values[i] ?? '').join(' | ')} |`)].join('\n'),
      ),
  }),
  define({
    type: 'converter',
    version: 1,
    label: 'Live converter',
    description: 'The working URL → Markdown converter.',
    category: 'product',
    schema: z.object({ title: z.string().max(140).optional(), subtitle: z.string().max(300).optional() }),
    sizes: ['medium', 'large'],
    defaultSize: 'medium',
    example: { title: 'Try it now' },
    toMarkdown: (p) => md.join(p.title && `## ${p.title}`, p.subtitle, 'Convert any URL: `https://anymd.cc/<url>`'),
  }),
  define({
    type: 'ecosystem',
    version: 1,
    label: 'Ecosystem',
    description: 'Digitop ecosystem product grid.',
    category: 'social-proof',
    schema: z.object({ title: z.string().max(140).optional(), lead: z.string().max(300).optional() }),
    sizes: ['medium', 'large'],
    defaultSize: 'medium',
    example: { title: 'Part of the Digitop ecosystem' },
    toMarkdown: (p) => md.join(p.title && `## ${p.title}`, p.lead, 'See https://anymd.cc/ecosystem'),
  }),
  define({
    type: 'founder',
    version: 1,
    label: 'Founder note',
    description: 'Founder card with rotating quotes.',
    category: 'social-proof',
    schema: z.object({ title: z.string().max(140).optional() }),
    sizes: ['medium', 'large'],
    defaultSize: 'medium',
    example: { title: 'Who builds it' },
    toMarkdown: (p) => md.join(p.title && `## ${p.title}`, 'anymd is built by Duy Nguyen (/zuey/) at [Digitop.ai](https://digitop.ai).'),
  }),
  define({
    type: 'columns',
    version: 1,
    label: 'Columns',
    description: 'Two-column layout with `left` and `right` slots holding other blocks.',
    category: 'layout',
    schema: z.object({ ratio: z.enum(['1-1', '2-1', '1-2']).default('1-1'), gap: z.enum(['small', 'medium', 'large']).default('medium'), verticalAlign: z.enum(['start', 'center']).default('start') }),
    sizes: SIZES,
    defaultSize: 'medium',
    slots: ['left', 'right'],
    example: { ratio: '1-1', gap: 'medium', verticalAlign: 'start' },
    toMarkdown: () => '',
  }),
] as const;

export type BlockType = (typeof BLOCKS)[number]['type'];

export const BLOCK_MAP: Map<string, BlockDefinition> = new Map(BLOCKS.map((b) => [b.type, b as unknown as BlockDefinition]));

export function getBlock(type: string): BlockDefinition | undefined {
  return BLOCK_MAP.get(type);
}

/** Agent-facing catalog: types, JSON Schemas, sizes, slots and examples. */
export function blockCatalog() {
  return BLOCKS.map((b) => ({
    type: b.type,
    version: b.version,
    label: b.label,
    description: b.description,
    category: b.category,
    sizes: b.sizes,
    defaultSize: b.defaultSize,
    slots: 'slots' in b ? b.slots : undefined,
    propsSchema: z.toJSONSchema(b.schema, { io: 'input' }),
    example: b.example,
  }));
}
