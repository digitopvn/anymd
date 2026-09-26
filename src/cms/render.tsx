/**
 * Server rendering for page-builder blocks. Sizes map to spacing and content width; blocks inside
 * a `columns` slot render compact (no section wrapper). Unknown or invalid blocks render nothing on
 * public pages and a visible warning in previews.
 */
import type { Child } from 'hono/jsx';
import { renderMarkdown } from '../lib/markdown';
import { Icon } from '../views/components/icons';
import { Converter, CreditTable, EcosystemGrid, FaqList, FounderCard, PricingCards } from '../views/components/marketing';
import { getBlock, type BlockSize } from './blocks';
import type { BlockNode, PageDocument } from './pages';

const PAD: Record<BlockSize, string> = { small: 'py-10 md:py-14', medium: 'py-14 md:py-20', large: 'py-20 md:py-28' };
const WIDTH: Record<BlockSize, string> = { small: 'max-w-3xl', medium: 'max-w-5xl', large: 'max-w-[1136px]' };

type Link = { label: string; href: string };
type P = Record<string, any>;

interface RenderCtx {
  preview: boolean;
  nested: boolean;
}

function Section({ size, ctx, children, class: cls = '', id }: { size: BlockSize; ctx: RenderCtx; children: Child; class?: string; id?: string }) {
  if (ctx.nested) return <div class={cls}>{children}</div>;
  return (
    <section class={`${PAD[size]} ${cls}`} id={id}>
      <div class={`container-x`}>
        <div class={`mx-auto ${WIDTH[size]}`}>{children}</div>
      </div>
    </section>
  );
}

function Cta({ link, primary }: { link?: Link; primary?: boolean }) {
  if (!link) return null;
  return (
    <a href={link.href} class={`btn ${primary ? 'btn-primary' : 'btn-ghost'} h-12 px-6 text-base`}>
      {link.label}
      {primary ? <Icon name="arrow" size={16} /> : null}
    </a>
  );
}

function Heading({ eyebrow, title, lead, center }: { eyebrow?: string; title?: string; lead?: string; center?: boolean }) {
  if (!eyebrow && !title && !lead) return null;
  return (
    <div class={`mb-10 ${center ? 'text-center' : ''}`}>
      {eyebrow ? <span class="eyebrow">{eyebrow}</span> : null}
      {title ? <h2 class={`section-title mt-3 ${center ? 'mx-auto' : ''} max-w-3xl`}>{title}</h2> : null}
      {lead ? <p class={`section-lead mt-4 ${center ? 'mx-auto' : ''}`}>{lead}</p> : null}
    </div>
  );
}

const RENDERERS: Record<string, (p: P, size: BlockSize, ctx: RenderCtx, node: BlockNode) => Child> = {
  hero: (p, size, ctx) => {
    const center = p.align !== 'left';
    const big = size === 'large' ? 'text-[42px] sm:text-[60px] md:text-[76px]' : size === 'medium' ? 'text-[38px] sm:text-[52px]' : 'text-[32px] sm:text-[42px]';
    return (
      <Section size={size} ctx={ctx} class="relative overflow-hidden">
        <div class={center ? 'text-center' : ''}>
          {p.eyebrow ? <span class="chip chip-accent">{p.eyebrow}</span> : null}
          <h1 class={`mt-5 font-display font-extrabold leading-[1.0] ${big} ${center ? 'mx-auto max-w-4xl' : 'max-w-3xl'}`}>{p.title}</h1>
          {p.subtitle ? <p class={`mt-5 text-[17px] leading-relaxed text-muted sm:text-[20px] ${center ? 'mx-auto max-w-2xl' : 'max-w-2xl'}`}>{p.subtitle}</p> : null}
          {p.primary || p.secondary ? (
            <div class={`mt-8 flex flex-col gap-3 sm:flex-row ${center ? 'justify-center' : ''}`}>
              <Cta link={p.primary} primary />
              <Cta link={p.secondary} />
            </div>
          ) : null}
        </div>
        {p.showConverter ? (
          <div class={`mt-10 ${center ? 'mx-auto' : ''} max-w-3xl text-left`}>
            <Converter />
          </div>
        ) : null}
      </Section>
    );
  },
  'rich-text': (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <div class={`prose-md ${p.width === 'wide' ? '' : 'mx-auto max-w-[720px]'}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(String(p.markdown ?? '')).html }} />
    </Section>
  ),
  'feature-grid': (p, size, ctx) => {
    const cols = p.columns === 2 ? 'sm:grid-cols-2' : p.columns === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2 lg:grid-cols-3';
    return (
      <Section size={size} ctx={ctx}>
        <Heading eyebrow={p.eyebrow} title={p.title} lead={p.lead} />
        <div class={`grid gap-4 ${ctx.nested ? '' : cols}`}>
          {(p.items as P[]).map((it) => (
            <div class="card p-6">
              <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
                <Icon name={it.icon ?? 'sparkles'} size={20} />
              </span>
              <h3 class="mt-4 text-lg font-bold">{it.title}</h3>
              <p class="mt-1.5 text-[15px] leading-relaxed text-muted">{it.body}</p>
            </div>
          ))}
        </div>
      </Section>
    );
  },
  steps: (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <Heading title={p.title} />
      <ol class={`grid gap-4 ${ctx.nested ? '' : 'md:grid-cols-3'}`}>
        {(p.items as P[]).map((it, i) => (
          <li class="card p-6">
            <span class="font-display text-[44px] font-extrabold leading-none text-brand">{i + 1}</span>
            <h3 class="mt-3 text-lg font-bold">{it.title}</h3>
            <p class="mt-1.5 text-[15px] leading-relaxed text-muted">{it.body}</p>
            {it.code ? <code class="mt-3 block overflow-x-auto rounded-lg bg-paper-2 px-3 py-2 font-mono text-[13px]">{it.code}</code> : null}
          </li>
        ))}
      </ol>
    </Section>
  ),
  stats: (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <dl class="grid grid-cols-2 gap-4 md:grid-cols-4">
        {(p.items as P[]).map((it) => (
          <div class="card p-5 text-center">
            <dt class="sr-only">{it.label}</dt>
            <dd class="font-display text-[40px] font-extrabold leading-none">{it.value}</dd>
            <p class="mt-2 text-sm text-muted">{it.label}</p>
          </div>
        ))}
      </dl>
    </Section>
  ),
  'logo-cloud': (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      {p.title ? <p class="mb-6 text-center font-mono text-xs uppercase tracking-widest text-muted">{p.title}</p> : null}
      <div class="flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
        {(p.logos as P[]).map((l) => {
          const img = <img src={l.src} alt={l.alt} loading="lazy" class="h-8 w-auto opacity-80 grayscale transition hover:opacity-100 hover:grayscale-0" />;
          return l.href ? (
            <a href={l.href} rel="noopener" target="_blank">
              {img}
            </a>
          ) : (
            img
          );
        })}
      </div>
    </Section>
  ),
  'code-tabs': (p, size, ctx, node) => (
    <Section size={size} ctx={ctx}>
      <Heading title={p.title} />
      <div class="card-night overflow-hidden shadow-pop" data-tabs>
        <div class="scroll-x flex gap-1 border-b border-night-3 p-2" role="tablist">
          {(p.tabs as P[]).map((t, i) => (
            <button type="button" class="tab" role="tab" aria-selected={i === 0 ? 'true' : 'false'} data-tab={`${node.id}-${i}`}>
              {t.label}
            </button>
          ))}
        </div>
        {(p.tabs as P[]).map((t, i) => (
          <div class={i === 0 ? 'relative' : 'relative hidden'} data-panel={`${node.id}-${i}`} role="tabpanel">
            <pre class="md-output overflow-x-auto p-5 !whitespace-pre">{t.code}</pre>
            <button type="button" class="btn btn-sm absolute right-3 top-3 !min-h-8 bg-night-3 !px-2.5 text-white hover:bg-[#2e3d48]" data-copy={t.code} aria-label="Copy code">
              <Icon name="copy" size={14} />
            </button>
          </div>
        ))}
      </div>
    </Section>
  ),
  pricing: (p, size, ctx) => (
    <Section size="large" ctx={ctx}>
      <Heading title={p.title} lead={p.lead} center />
      <PricingCards />
      {p.showCredits ? (
        <div class="mx-auto mt-10 max-w-2xl">
          <CreditTable />
        </div>
      ) : null}
    </Section>
  ),
  faq: (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <Heading title={p.title} />
      <FaqList items={p.items} />
    </Section>
  ),
  testimonial: (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <figure class="card mx-auto max-w-3xl p-8 text-center sm:p-12">
        <blockquote class="font-display text-[24px] font-extrabold leading-tight sm:text-[32px]">
          <span class="text-accent-ink">“</span>
          {p.quote}
          <span class="text-accent-ink">”</span>
        </blockquote>
        <figcaption class="mt-6 flex items-center justify-center gap-3 text-sm">
          {p.avatar ? <img src={p.avatar} alt="" width="40" height="40" class="h-10 w-10 rounded-full object-cover" loading="lazy" /> : null}
          <span>
            <strong>{p.author}</strong>
            {p.role ? <span class="text-muted"> · {p.role}</span> : null}
          </span>
        </figcaption>
      </figure>
    </Section>
  ),
  cta: (p, size, ctx) => {
    const tone = p.tone === 'dark' ? 'bg-night text-white' : p.tone === 'light' ? 'card' : 'bg-brand text-ink';
    return (
      <Section size={size} ctx={ctx}>
        <div class={`rounded-[28px] px-6 py-14 text-center sm:px-12 ${tone}`}>
          <h2 class="mx-auto max-w-3xl font-display text-[34px] font-extrabold leading-[1.05] md:text-[52px]">{p.title}</h2>
          {p.body ? <p class="mx-auto mt-4 max-w-xl text-lg opacity-80">{p.body}</p> : null}
          <div class="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <a href={p.primary.href} class={`btn h-12 px-6 text-base ${p.tone === 'accent' || !p.tone ? 'btn-dark' : 'btn-primary'}`}>
              {p.primary.label} <Icon name="arrow" size={16} />
            </a>
            {p.secondary ? (
              <a href={p.secondary.href} class={`btn h-12 px-6 text-base ${p.tone === 'dark' ? 'btn-light' : 'btn-ghost'}`}>
                {p.secondary.label}
              </a>
            ) : null}
          </div>
        </div>
      </Section>
    );
  },
  offer: (p, size, ctx) => {
    const ends = Date.parse(p.endsAt);
    const live = Number.isFinite(ends) && ends > Date.now();
    return (
      <Section size={size} ctx={ctx}>
        <div class="flex flex-col items-center gap-4 rounded-2xl border border-line bg-night p-5 text-white sm:flex-row sm:justify-between sm:p-6">
          <div class="flex items-center gap-3">
            <Icon name="gift" size={26} class="shrink-0 text-accent" />
            <p class="font-semibold">
              {p.title}: <span class="text-accent">{p.percent}% off</span> with{' '}
              <button type="button" class="font-mono underline decoration-dotted underline-offset-4" data-copy={p.code}>
                {p.code}
              </button>
            </p>
          </div>
          <div class="flex items-center gap-3">
            {live ? (
              <span class="font-mono text-sm text-[#c5d2d0]" data-countdown={ends}>
                &nbsp;
              </span>
            ) : (
              <span class="text-sm text-[#c5d2d0]">Offer ended</span>
            )}
            <a href={p.href} class="btn btn-primary btn-sm">
              Claim it
            </a>
          </div>
        </div>
      </Section>
    );
  },
  image: (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <figure>
        <img src={p.src} alt={p.alt} loading="lazy" decoding="async" class={`w-full ${p.rounded === false ? '' : 'rounded-2xl border border-line'}`} />
        {p.caption ? <figcaption class="mt-3 text-center text-sm text-muted">{p.caption}</figcaption> : null}
      </figure>
    </Section>
  ),
  comparison: (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <Heading title={p.title} />
      <div class="card scroll-x">
        <table class="table min-w-[520px]">
          <thead>
            <tr>
              <th />
              {(p.columns as string[]).map((c, i) => (
                <th class={i === (p.highlight ?? 0) ? '!text-ink' : ''}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(p.rows as P[]).map((r) => (
              <tr>
                <td class="font-semibold">{r.label}</td>
                {(p.columns as string[]).map((_, i) => (
                  <td class={i === (p.highlight ?? 0) ? 'bg-accent-soft/60 font-semibold' : 'text-muted'}>{r.values?.[i] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  ),
  converter: (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <Heading title={p.title} lead={p.subtitle} center />
      <div class="mx-auto max-w-3xl">
        <Converter />
      </div>
    </Section>
  ),
  ecosystem: (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <Heading title={p.title} lead={p.lead} />
      <EcosystemGrid />
    </Section>
  ),
  founder: (p, size, ctx) => (
    <Section size={size} ctx={ctx}>
      <Heading title={p.title} />
      <FounderCard />
    </Section>
  ),
  columns: (p, size, ctx, node) => {
    const ratio = p.ratio === '2-1' ? 'md:grid-cols-[2fr_1fr]' : p.ratio === '1-2' ? 'md:grid-cols-[1fr_2fr]' : 'md:grid-cols-2';
    const gap = p.gap === 'small' ? 'gap-4' : p.gap === 'large' ? 'gap-12' : 'gap-8';
    const inner = { ...ctx, nested: true };
    return (
      <Section size={size} ctx={ctx}>
        <div class={`grid ${ratio} ${gap} ${p.verticalAlign === 'center' ? 'items-center' : 'items-start'}`}>
          <div class="min-w-0 space-y-6">{(node.slots?.left ?? []).map((b) => renderNode(b, inner))}</div>
          <div class="min-w-0 space-y-6">{(node.slots?.right ?? []).map((b) => renderNode(b, inner))}</div>
        </div>
      </Section>
    );
  },
};

function renderNode(node: BlockNode, ctx: RenderCtx): Child {
  const def = getBlock(node.type);
  const render = RENDERERS[node.type];
  const parsed = def?.schema.safeParse(node.props);
  if (!def || !render || !parsed?.success) {
    return ctx.preview ? (
      <div class="container-x py-4">
        <p class="rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">Block “{node.type}” ({node.id}) is invalid and hidden on the live page.</p>
      </div>
    ) : null;
  }
  return (
    <div data-block-id={node.id} data-block-type={node.type}>
      {render(parsed.data as P, node.size, ctx, node)}
    </div>
  );
}

export function PageBlocks({ doc, preview = false }: { doc: PageDocument; preview?: boolean }) {
  return <>{doc.blocks.map((b) => renderNode(b, { preview, nested: false }))}</>;
}

/** FAQPage JSON-LD from every FAQ block (including ones nested in columns). */
export function pageJsonLd(doc: PageDocument): Record<string, unknown>[] {
  const qs: { q: string; a: string }[] = [];
  const walk = (blocks: BlockNode[]) =>
    blocks.forEach((b) => {
      if (b.type === 'faq' && Array.isArray((b.props as P).items)) qs.push(...((b.props as P).items as { q: string; a: string }[]));
      Object.values(b.slots ?? {}).forEach(walk);
    });
  walk(doc.blocks);
  if (!qs.length) return [];
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: qs.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })),
    },
  ];
}
