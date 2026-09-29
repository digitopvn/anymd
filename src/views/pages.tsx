/** Public content pages: pricing, ecosystem, blog, changelog, docs, legal, built pages, errors. */
import type { Child } from 'hono/jsx';
import { LAUNCH_OFFER, PLANS } from '../billing/plans';
import type { BlogPost, ContentPage } from '../content';
import { DOCS_PAGES } from '../content';
import { ECOSYSTEM, SITE } from '../content/site';
import { humanDate } from '../lib/util';
import type { TocItem } from '../lib/markdown';
import { Icon } from './components/icons';
import { BrandLink, CreditTable, EcosystemGrid, FaqList, FounderCard, OfferBar, PricingCards, SectionHeader } from './components/marketing';

function PageHero({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead?: Child; children?: Child }) {
  return (
    <section class="relative overflow-hidden border-b border-line">
      <div class="grid-bg pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
      <div class="container-x relative py-14 text-center md:py-20">
        <span class="eyebrow">{eyebrow}</span>
        <h1 class="mx-auto mt-4 max-w-3xl font-display text-[40px] font-extrabold leading-[1.02] md:text-[60px]">{title}</h1>
        {lead ? <p class="section-lead mx-auto mt-5">{lead}</p> : null}
        {children}
      </div>
    </section>
  );
}

const PRICING_FAQ = [
  { q: 'What is a credit?', a: 'One web page = 1 credit. YouTube = 3, PDFs and office files = 3, images = 5. Searching your library and cached results are free.' },
  { q: 'What happens when I run out?', a: 'Free accounts pause until next month. Pro and Scale keep going and pay a small per-1k overage, so your agents never hit a wall mid-task.' },
  { q: 'Can I cancel anytime?', a: 'Yes. Cancel from the billing portal; you keep your plan until the end of the period. See the refund policy for details.' },
  { q: 'Do unused credits roll over?', a: 'Included credits reset on the 1st of each month (UTC). On Pro and Scale, work past the allowance is billed as small per-1,000 overage, so nothing stops mid-job.' },
  { q: 'Is there a discount?', a: `Launch week: ${LAUNCH_OFFER.percent}% off with ${LAUNCH_OFFER.code}. Nonprofits, students and open-source maintainers: email hello@digitop.ai.` },
];

export function PricingPage({ checkoutReady }: { checkoutReady: boolean }) {
  const pro = PLANS.find((p) => p.id === 'pro')!;
  return (
    <>
      <OfferBar />
      <PageHero eyebrow="Pricing" title="Pay when your agents learn something new." lead="Reusing what they already know is free. Start with 500 credits a month, upgrade when your agents get hungry. Usage-based, predictable, cancel anytime." />
      <section class="section !pt-12">
        <div class="container-x">
          <PricingCards />
          {checkoutReady ? null : (
            <p class="mx-auto mt-6 max-w-2xl text-center text-sm text-muted">
              Paid checkout opens with our billing launch. Sign up free now — your account upgrades in one click when it does.
            </p>
          )}
        </div>
      </section>
      <section class="section bg-paper-2/60">
        <div class="container-x grid gap-12 lg:grid-cols-2">
          <div>
            <SectionHeader eyebrow="Credits" title="Simple math." lead="Processing a new source costs a fixed number of credits by its complexity. Cached reads and library search are free." />
            <div class="reveal mt-8">
              <CreditTable />
            </div>
          </div>
          <div>
            <SectionHeader eyebrow="ROI" title="Cheaper than the tokens it saves." lead="Markdown is typically 5–10× smaller than the HTML it came from. At Pro, a page costs $0.0009." />
            <div class="reveal card mt-8 p-6">
              <dl class="space-y-4 text-[15px]">
                {[
                  ['Raw HTML article', '~60,000 tokens', 'text-muted'],
                  ['Same article via anymd', '~6,000 tokens', 'text-accent-ink font-bold'],
                  ['Model cost saved per 1k pages*', '≈ $160', 'font-bold'],
                  [`anymd cost for 1k pages on ${pro.name}`, '$0.90', 'font-bold'],
                ].map(([k, v, cls]) => (
                  <div class="flex items-center justify-between gap-4 border-b border-line pb-3 last:border-0 last:pb-0">
                    <dt>{k}</dt>
                    <dd class={cls}>{v}</dd>
                  </div>
                ))}
              </dl>
              <p class="mt-4 text-xs text-muted">* Illustrative: 54k tokens × 1,000 pages at $3 per million input tokens. Your mileage varies by page and model.</p>
            </div>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="container-x max-w-3xl">
          <SectionHeader eyebrow="FAQ" title="Billing questions." />
          <div class="reveal mt-8">
            <FaqList items={PRICING_FAQ} />
          </div>
        </div>
      </section>
    </>
  );
}

export function EcosystemPage() {
  return (
    <>
      <PageHero eyebrow="Ecosystem" title="Tools that play well together." lead={
          <>
            anymd is part of a family of open, agent-first products built by <BrandLink to="owner" /> and <BrandLink to="partner" />. Each one does one job well and speaks MCP.
          </>
        }
      />
      <section class="section !pt-12">
        <div class="container-x">
          <EcosystemGrid />
        </div>
      </section>
      <section class="section bg-paper-2/60">
        <div class="container-x">
          <FounderCard />
        </div>
      </section>
    </>
  );
}


export function BlogIndexPage({ posts }: { posts: BlogPost[] }) {
  const [first, ...rest] = posts;
  return (
    <>
      <PageHero eyebrow="Blog" title="Notes on agents, Markdown and the web." lead="Guides, announcements and deep dives from the team building anymd." />
      <section class="section !pt-12">
        <div class="container-x">
          {first ? (
            <a href={`/blog/${first.slug}`} class="card group grid gap-6 p-6 transition hover:shadow-pop md:grid-cols-[1.2fr_1fr] md:p-10">
              <div>
                <span class="chip chip-accent capitalize">{first.category}</span>
                <h2 class="mt-4 font-display text-[30px] font-extrabold leading-tight group-hover:underline md:text-[40px]">{first.title}</h2>
                <p class="mt-3 text-muted">{first.excerpt}</p>
                <p class="mt-5 text-sm text-muted">
                  {first.authorName} · {humanDate(first.publishedAt)}
                </p>
              </div>
              <div class="hidden items-center justify-center rounded-2xl bg-night p-8 md:flex">
                <pre class="md-output text-sm">{`---\ntitle: "${first.title.slice(0, 32)}…"\n---\n\n# ${first.title.split(' ').slice(0, 4).join(' ')}`}</pre>
              </div>
            </a>
          ) : null}
          <div class="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {rest.map((p) => (
              <a href={`/blog/${p.slug}`} class="card group flex flex-col p-6 transition hover:-translate-y-0.5 hover:shadow-pop">
                <span class="chip w-fit capitalize">{p.category}</span>
                <h2 class="mt-4 text-xl font-extrabold leading-snug group-hover:underline">{p.title}</h2>
                <p class="mt-2 line-clamp-3 text-[15px] text-muted">{p.excerpt}</p>
                <p class="mt-auto pt-5 text-sm text-muted">{humanDate(p.publishedAt)}</p>
              </a>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function Toc({ toc }: { toc: TocItem[] }) {
  if (toc.length < 2) return null;
  return (
    <nav aria-label="On this page" class="text-sm">
      <p class="font-mono text-xs uppercase tracking-widest text-muted">On this page</p>
      <ul class="mt-3 space-y-2 border-l border-line">
        {toc.map((t) => (
          <li>
            <a href={`#${t.id}`} class={`-ml-px block border-l border-transparent pl-3 text-muted hover:border-ink hover:text-ink ${t.depth === 3 ? 'pl-6' : ''}`}>
              {t.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function BlogPostPage({ post, html, toc, minutes }: { post: BlogPost; html: string; toc: TocItem[]; minutes: number }) {
  return (
    <article class="container-x py-12 md:py-16">
      <div class="mx-auto max-w-[720px]">
        <a href="/blog" class="text-sm font-semibold text-muted hover:text-ink">
          ← All posts
        </a>
        <div class="mt-6 flex flex-wrap items-center gap-2">
          <span class="chip chip-accent capitalize">{post.category}</span>
          {post.tags.slice(0, 4).map((t) => (
            <span class="chip">#{t}</span>
          ))}
        </div>
        <h1 class="mt-5 font-display text-[36px] font-extrabold leading-[1.05] md:text-[52px]">{post.title}</h1>
        {post.excerpt ? <p class="mt-4 text-lg text-muted">{post.excerpt}</p> : null}
        <div class="mt-6 flex items-center gap-3 border-b border-line pb-6 text-sm text-muted">
          <img src="https://cdn.zuey.me/avatar.png" alt="" width="36" height="36" class="h-9 w-9 rounded-full" loading="lazy" />
          <span>
            <strong class="text-ink">{post.authorName}</strong> · {humanDate(post.publishedAt)} · {minutes} min read
          </span>
        </div>
      </div>
      <div class="mx-auto mt-10 grid max-w-[1080px] gap-10 xl:grid-cols-[720px_1fr] xl:justify-center">
        <div class="prose-md mx-auto w-full max-w-[720px]" dangerouslySetInnerHTML={{ __html: html }} />
        <aside class="hidden xl:block">
          <div class="sticky top-24">
            <Toc toc={toc} />
          </div>
        </aside>
      </div>
      <div class="mx-auto mt-14 max-w-[720px] rounded-2xl bg-brand p-8 text-center">
        <p class="font-display text-2xl font-extrabold">Give your agent clean Markdown.</p>
        <p class="mt-2 text-ink/75">500 free credits every month. No card.</p>
        <a href="/signup" class="btn btn-dark mt-5">
          Start free <Icon name="arrow" size={16} />
        </a>
      </div>
    </article>
  );
}

export interface ChangeEntry {
  channel: 'stable' | 'beta';
  title: string;
  version: string;
  url: string;
  date: number;
  html: string;
}

export function ChangelogPage({ entries, source }: { entries: ChangeEntry[]; source: 'releases' | 'commits' | 'none' }) {
  return (
    <>
      <PageHero eyebrow="Changelog" title="What shipped, and when." lead="Pulled live from GitHub. Stable releases ship to anymd.cc; beta builds run on staging first.">
        <div class="mt-6 flex justify-center gap-2" data-filter-group>
          {[
            ['all', 'All'],
            ['stable', 'Stable'],
            ['beta', 'Beta'],
          ].map(([id, label], i) => (
            <button type="button" class="chip aria-pressed:!bg-ink aria-pressed:!text-paper" aria-pressed={i === 0 ? 'true' : 'false'} data-filter={id}>
              {label}
            </button>
          ))}
        </div>
      </PageHero>
      <section class="section !pt-12">
        <div class="container-x max-w-3xl">
          {entries.length === 0 ? (
            <div class="card p-8 text-center text-muted">
              No public releases yet. Follow along on{' '}
              <a class="underline" href={`${SITE.github}/releases`}>
                GitHub
              </a>
              .
            </div>
          ) : (
            <ol class="relative space-y-6 border-l border-line pl-6">
              {entries.map((e) => (
                <li class="relative" data-channel={e.channel}>
                  <span class={`absolute -left-[31px] top-2 h-3 w-3 rounded-full ring-4 ring-paper ${e.channel === 'stable' ? 'bg-accent' : 'bg-violet'}`} />
                  <div class="card p-6">
                    <div class="flex flex-wrap items-center gap-2 text-sm">
                      <span class={`chip ${e.channel === 'stable' ? 'chip-accent' : '!bg-violet-soft !text-violet !border-violet-line'}`}>{e.channel}</span>
                      <code class="font-mono text-xs text-muted">{e.version}</code>
                      <time class="text-muted" datetime={new Date(e.date).toISOString()}>
                        {humanDate(e.date)}
                      </time>
                    </div>
                    <h2 class="mt-3 text-xl font-extrabold">
                      <a href={e.url} rel="noopener" class="hover:underline">
                        {e.title}
                      </a>
                    </h2>
                    {e.html ? <div class="prose-md mt-3 !text-[15px]" dangerouslySetInnerHTML={{ __html: e.html }} /> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p class="mt-8 text-center text-xs text-muted">
            Source: GitHub {source === 'commits' ? 'commits on main (stable) and dev (beta)' : 'releases'} ·{' '}
            <a class="underline" href={`${SITE.github}`}>
              {SITE.github.replace('https://', '')}
            </a>
          </p>
        </div>
      </section>
    </>
  );
}

export function DocsPage({ page, html, toc }: { page: ContentPage; html: string; toc: TocItem[] }) {
  const idx = DOCS_PAGES.findIndex((p) => p.slug === page.slug);
  const prev = DOCS_PAGES[idx - 1];
  const next = DOCS_PAGES[idx + 1];
  const href = (slug: string) => (slug === 'index' ? '/docs' : `/docs/${slug}`);
  return (
    <div class="container-x py-8 md:py-12">
      <div class="grid gap-8 lg:grid-cols-[230px_minmax(0,1fr)] xl:grid-cols-[230px_minmax(0,1fr)_200px]">
        <aside class="lg:sticky lg:top-24 lg:self-start">
          <details class="card p-2 lg:hidden" data-docs-nav>
            <summary class="flex cursor-pointer list-none items-center justify-between px-3 py-2 font-semibold">
              Docs menu <Icon name="down" size={16} />
            </summary>
            <DocsNav current={page.slug} href={href} />
          </details>
          <div class="hidden lg:block">
            <DocsNav current={page.slug} href={href} />
          </div>
        </aside>
        <article class="min-w-0">
          <p class="font-mono text-xs uppercase tracking-widest text-muted">Docs</p>
          <h1 class="mt-2 font-display text-[34px] font-extrabold leading-tight md:text-[44px]">{page.title}</h1>
          {page.description ? <p class="mt-3 text-lg text-muted">{page.description}</p> : null}
          <div class="prose-md mt-8 max-w-[760px]" dangerouslySetInnerHTML={{ __html: html }} />
          <div class="mt-12 grid max-w-[760px] gap-3 sm:grid-cols-2">
            {prev ? (
              <a href={href(prev.slug)} class="card p-4 hover:shadow-pop">
                <span class="text-xs text-muted">← Previous</span>
                <span class="block font-bold">{prev.title}</span>
              </a>
            ) : (
              <span />
            )}
            {next ? (
              <a href={href(next.slug)} class="card p-4 text-right hover:shadow-pop">
                <span class="text-xs text-muted">Next →</span>
                <span class="block font-bold">{next.title}</span>
              </a>
            ) : null}
          </div>
          <p class="mt-8 text-sm text-muted">
            Updated {page.updated} ·{' '}
            <a class="underline" href={`${SITE.github}/edit/main/src/content/docs/${page.slug}.md`} rel="noopener">
              Edit on GitHub
            </a>
          </p>
        </article>
        <aside class="hidden xl:block">
          <div class="sticky top-24">
            <Toc toc={toc} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function DocsNav({ current, href }: { current: string; href: (s: string) => string }) {
  return (
    <nav aria-label="Documentation" class="dash-nav mt-1 flex flex-col gap-0.5 lg:mt-0">
      {DOCS_PAGES.map((p) => (
        <a href={href(p.slug)} aria-current={p.slug === current ? 'page' : undefined}>
          {p.slug === 'index' ? 'Overview' : p.title}
        </a>
      ))}
      <a href="/docs/api/reference">API reference (interactive)</a>
    </nav>
  );
}

export function LegalPage({ page, html, all }: { page: ContentPage; html: string; all: ContentPage[] }) {
  return (
    <div class="container-x py-12 md:py-16">
      <div class="mx-auto grid max-w-[1000px] gap-10 lg:grid-cols-[200px_1fr]">
        <nav aria-label="Legal" class="dash-nav flex gap-1 overflow-x-auto lg:flex-col lg:self-start lg:sticky lg:top-24">
          {all.map((p) => (
            <a href={`/legal/${p.slug}`} aria-current={p.slug === page.slug ? 'page' : undefined}>
              {p.title}
            </a>
          ))}
        </nav>
        <article class="min-w-0">
          <h1 class="font-display text-[34px] font-extrabold leading-tight md:text-[44px]">{page.title}</h1>
          <p class="mt-2 text-sm text-muted">Last updated {page.updated}</p>
          <div class="prose-md mt-8" dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      </div>
    </div>
  );
}

export function PreviewBanner({ slug, revision }: { slug: string; revision: number }) {
  return (
    <div class="sticky top-0 z-[55] bg-violet px-4 py-2 text-center text-sm font-semibold text-white">
      Draft preview · /p/{slug} · revision {revision} — not visible to the public.
    </div>
  );
}

export function MessagePage({ code, title, body, children }: { code: string; title: string; body: string; children?: Child }) {
  return (
    <section class="relative overflow-hidden">
      <div class="grid-bg pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
      <div class="container-x relative py-24 text-center md:py-32">
        <img src="/logo/anymd-mark.webp" alt="" width="120" height="120" class="mx-auto h-28 w-28 animate-float" />
        <p class="mt-6 font-mono text-sm font-semibold text-accent-ink">{code}</p>
        <h1 class="mt-3 font-display text-[40px] font-extrabold leading-tight md:text-[56px]">{title}</h1>
        <p class="section-lead mx-auto mt-4">{body}</p>
        <div class="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          {children ?? (
            <>
              <a href="/" class="btn btn-primary">
                Go home
              </a>
              <a href="/docs" class="btn btn-ghost">
                Read the docs
              </a>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** `?format=html` preview of a converted URL. */
export function ConvertedPreview({ title, source, html, markdownUrl }: { title: string; source: string; html: string; markdownUrl: string }) {
  return (
    <div class="container-x py-10">
      <div class="mx-auto max-w-[760px]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4 text-sm">
          <a href={source} rel="noopener nofollow" class="truncate text-muted hover:text-ink">
            {source}
          </a>
          <a href={markdownUrl} class="btn btn-ghost btn-sm">
            View Markdown
          </a>
        </div>
        <h1 class="mt-8 font-display text-[34px] font-extrabold leading-tight">{title}</h1>
        <div class="prose-md mt-6" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
