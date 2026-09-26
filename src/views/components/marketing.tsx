import { CREDIT_TABLE, LAUNCH_OFFER, PLANS, type Plan } from '../../billing/plans';
import type { Child } from 'hono/jsx';
import { ECOSYSTEM, FAQ, FOUNDER, SITE } from '../../content/site';
import { Icon } from './icons';

/** Inline link for the company names we credit in running copy. */
export function BrandLink({ to, class: cls = '' }: { to: 'owner' | 'partner'; class?: string }) {
  const [label, href] = to === 'owner' ? [SITE.owner, SITE.ownerUrl] : [SITE.partner, SITE.partnerUrl];
  return (
    <a href={href} rel="noopener" class={`text-link ${cls}`}>
      {label}
    </a>
  );
}

export function OfferBar() {
  const endDate = new Date(LAUNCH_OFFER.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (Date.now() > LAUNCH_OFFER.endsAt) return null;
  return (
    <div class="bg-night text-white text-[13px] sm:text-sm" data-offer-bar data-ends={LAUNCH_OFFER.endsAt}>
      <div class="container-x flex min-h-10 flex-wrap items-center justify-center gap-x-3 gap-y-1 py-2 text-center">
        <span class="chip !bg-accent !text-night !border-accent !py-0.5">Launch</span>
        <span>
          <strong>{LAUNCH_OFFER.percent}% off Pro & Scale</strong> with code{' '}
          <button type="button" class="font-mono font-semibold text-accent-2 underline decoration-dotted underline-offset-4" data-copy={LAUNCH_OFFER.code}>
            {LAUNCH_OFFER.code}
          </button>{' '}
          · ends {endDate}
        </span>
        <span class="font-mono text-[#c5d2d0]" data-countdown={LAUNCH_OFFER.endsAt} aria-label="Time left">
          &nbsp;
        </span>
      </div>
    </div>
  );
}

export function Converter({ compact = false, autofocus = false }: { compact?: boolean; autofocus?: boolean }) {
  const examples = [
    ['stephango.com/saw', 'Article'],
    ['developers.cloudflare.com/workers/', 'Docs page'],
    ['github.com/digitopvn/anymd', 'GitHub repo'],
    ['news.ycombinator.com/item?id=8863', 'Discussion'],
  ];
  return (
    <div class="w-full" data-converter>
      <form class="card flex flex-col gap-2 p-2 sm:flex-row sm:items-center shadow-pop" data-converter-form action="/convert" method="get">
        <label for="convert-url" class="sr-only">
          URL to convert
        </label>
        <div class="flex min-w-0 flex-1 items-center rounded-xl bg-paper px-3">
          <span class="select-none font-mono text-[15px] font-semibold text-muted">anymd.cc/</span>
          <input
            id="convert-url"
            name="url"
            type="text"
            inputmode="url"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            required
            placeholder="paste a public URL…"
            class="min-w-0 flex-1 bg-transparent py-3 pl-1 font-mono text-[15px] outline-none placeholder:text-[#9aa7a9]"
            autofocus={autofocus}
          />
        </div>
        <button type="submit" class="btn btn-primary h-12 sm:w-auto" data-converter-submit>
          Convert <Icon name="arrow" size={16} />
        </button>
      </form>
      {compact ? null : (
        <div class="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          <span class="text-muted">Try:</span>
          {examples.map(([url, label]) => (
            <button type="button" class="chip hover:border-accent hover:text-accent-ink transition-colors" data-example={url}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div class="mt-5 hidden" data-converter-result>
        <div class="card-night overflow-hidden shadow-pop">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-night-3 px-3 py-2">
            <div class="flex gap-1" role="tablist" aria-label="Output format">
              <button type="button" class="tab" role="tab" aria-selected="true" data-view="md">
                Markdown
              </button>
              <button type="button" class="tab" role="tab" aria-selected="false" data-view="preview">
                Preview
              </button>
              <button type="button" class="tab" role="tab" aria-selected="false" data-view="json">
                JSON
              </button>
            </div>
            <div class="flex items-center gap-1 text-[#c5d2d0]">
              <button type="button" class="btn btn-sm !min-h-8 !px-2.5 hover:bg-night-3" data-result-action="copy" title="Copy Markdown">
                <Icon name="copy" size={15} /> <span class="hidden sm:inline">Copy</span>
              </button>
              <button type="button" class="btn btn-sm !min-h-8 !px-2.5 hover:bg-night-3" data-result-action="download" title="Download .md">
                <Icon name="download" size={15} />
              </button>
              <button type="button" class="btn btn-sm !min-h-8 !px-2.5 hover:bg-night-3" data-result-action="chatgpt" title="Send to ChatGPT">
                GPT
              </button>
              <button type="button" class="btn btn-sm !min-h-8 !px-2.5 hover:bg-night-3" data-result-action="claude" title="Send to Claude">
                Claude
              </button>
              <button type="button" class="btn btn-sm !min-h-8 !px-2.5 hover:bg-night-3" data-result-action="gemini" title="Send to Gemini">
                Gemini
              </button>
            </div>
          </div>
          <div class="grid gap-0 md:grid-cols-[1fr_220px]">
            <div class="max-h-[460px] overflow-auto p-4 sm:p-5" data-result-body>
              <pre class="md-output" data-output-md />
              <div class="prose-md hidden rounded-xl bg-paper p-5 text-[15px]" data-output-preview />
              <pre class="md-output hidden" data-output-json />
            </div>
            <aside class="border-t border-night-3 p-4 text-[13px] md:border-l md:border-t-0" data-result-stats>
              <dl class="grid grid-cols-2 gap-3 md:grid-cols-1">
                <div>
                  <dt class="text-[#7f9098]">Source</dt>
                  <dd class="font-semibold text-white truncate" data-stat="kind">—</dd>
                </div>
                <div>
                  <dt class="text-[#7f9098]">Words</dt>
                  <dd class="font-semibold text-white" data-stat="words">—</dd>
                </div>
                <div>
                  <dt class="text-[#7f9098]">Smaller than HTML</dt>
                  <dd class="font-semibold text-accent-2" data-stat="ratio">—</dd>
                </div>
                <div>
                  <dt class="text-[#7f9098]">Time</dt>
                  <dd class="font-semibold text-white" data-stat="time">—</dd>
                </div>
              </dl>
              <a href="/signup" class="mt-4 block rounded-xl bg-night-3 p-3 text-[#e2eae7] hover:bg-[#2e3d48]" data-save-cta>
                <strong class="text-white">Save it to your library →</strong>
                <span class="mt-1 block text-[#9aa9ae]">Free account: 500 credits/mo, search, MCP.</span>
              </a>
            </aside>
          </div>
        </div>
      </div>
      <p class="mt-4 hidden rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger" data-converter-error role="alert" />
    </div>
  );
}

function price(plan: Plan, yearly: boolean): string {
  if (plan.monthly < 0) return 'Custom';
  if (plan.monthly === 0) return '$0';
  return `$${yearly ? plan.yearly : plan.monthly}`;
}

export function PricingCards({ ctaFor }: { ctaFor?: (plan: Plan) => { href: string; label: string } }) {
  return (
    <div data-pricing>
      <div class="flex justify-center">
        <div class="inline-flex rounded-xl border border-line bg-card p-1 text-sm font-semibold" role="group" aria-label="Billing period">
          <button type="button" class="rounded-lg px-4 py-2 aria-pressed:bg-ink aria-pressed:text-paper" aria-pressed="true" data-period="month">
            Monthly
          </button>
          <button type="button" class="rounded-lg px-4 py-2 aria-pressed:bg-ink aria-pressed:text-paper" aria-pressed="false" data-period="year">
            Yearly <span class="ml-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-bold text-accent-ink">−20%</span>
          </button>
        </div>
      </div>
      <div class="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {PLANS.map((plan) => {
          const cta = ctaFor?.(plan) ?? defaultCta(plan);
          return (
            <div class={`card relative flex flex-col p-6 ${plan.highlight ? '!border-ink ring-2 ring-ink' : ''}`}>
              {plan.highlight ? <span class="chip chip-accent absolute -top-3 left-6">Most popular</span> : null}
              <h3 class="text-xl font-extrabold">{plan.name}</h3>
              <p class="mt-1 text-sm text-muted">{plan.tagline}</p>
              <div class="mt-5 flex items-end gap-1">
                <span class="font-display text-[44px] font-extrabold leading-none" data-price-month={price(plan, false)} data-price-year={price(plan, true)}>
                  {price(plan, false)}
                </span>
                {plan.monthly > 0 ? <span class="pb-1.5 text-sm text-muted">/ month</span> : null}
              </div>
              <p class="mt-1 h-5 text-xs text-muted" data-yearly-note={plan.monthly > 0 ? `billed $${plan.yearly * 12}/year` : ''} />
              <a href={cta.href} class={`btn mt-5 w-full ${plan.highlight ? 'btn-primary' : 'btn-ghost'}`} data-plan={plan.id}>
                {cta.label}
              </a>
              <ul class="mt-6 space-y-2.5 text-[14px]">
                {plan.features.map((f) => (
                  <li class="flex gap-2">
                    <span class="mt-0.5 text-mint">
                      <Icon name="check" size={16} stroke={2.4} />
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function defaultCta(plan: Plan): { href: string; label: string } {
  if (plan.id === 'free') return { href: '/signup', label: 'Start free' };
  if (plan.id === 'enterprise') return { href: 'mailto:hello@digitop.ai?subject=anymd%20Enterprise', label: 'Talk to us' };
  return { href: `/signup?plan=${plan.id}`, label: `Get ${plan.name}` };
}

export function CreditTable() {
  return (
    <div class="card overflow-hidden">
      <div class="scroll-x">
        <table class="table">
          <thead>
            <tr>
              <th>What you convert</th>
              <th class="text-right">Credits</th>
            </tr>
          </thead>
          <tbody>
            {CREDIT_TABLE.map((row) => (
              <tr>
                <td>{row.label}</td>
                <td class="text-right font-mono font-semibold">{row.credits === 0 ? 'Free' : row.credits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FaqList({ items = FAQ }: { items?: { q: string; a: string }[] }) {
  return (
    <div class="divide-y divide-line card">
      {items.map((f) => (
        <details class="group p-5 sm:p-6">
          <summary class="flex cursor-pointer list-none items-start justify-between gap-4 text-[17px] font-semibold">
            <span>{f.q}</span>
            <span class="mt-0.5 shrink-0 transition-transform group-open:rotate-45 text-accent-ink">
              <Icon name="plus" size={20} />
            </span>
          </summary>
          <p class="mt-3 leading-relaxed text-muted">{f.a}</p>
        </details>
      ))}
    </div>
  );
}

export function EcosystemGrid({ dark = false }: { dark?: boolean }) {
  return (
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {ECOSYSTEM.map((p) => (
        <a
          href={p.url}
          rel="noopener"
          target="_blank"
          class={`group flex flex-col gap-3 rounded-2xl border p-5 transition-all hover:-translate-y-0.5 ${dark ? 'border-night-3 bg-night-2 hover:border-[#3b4d58]' : 'border-line bg-card hover:shadow-card'}`}
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex h-10 items-center">
              {p.logo ? (
                <img src={p.logo} alt="" loading="lazy" class="h-9 w-auto max-w-[150px] object-contain" />
              ) : (
                <span class="font-mono text-lg font-bold">{p.name}</span>
              )}
            </div>
            <span class={`chip !text-[11px] ${dark ? '!bg-night-3 !border-night-3 !text-[#c5d2d0]' : ''}`}>{p.tag}</span>
          </div>
          <div>
            <h3 class={`font-bold ${dark ? 'text-white' : ''}`}>{p.name}</h3>
            <p class={`mt-1 text-sm leading-relaxed ${dark ? 'text-[#9aa9ae]' : 'text-muted'}`}>{p.tagline}</p>
          </div>
          <span class={`mt-auto inline-flex items-center gap-1 text-sm font-semibold ${dark ? 'text-accent' : 'text-accent-ink'}`}>
            {new URL(p.url).hostname} <Icon name="external" size={14} />
          </span>
        </a>
      ))}
    </div>
  );
}

export function FounderCard() {
  return (
    <div class="card overflow-hidden" data-founder>
      <div class="grid md:grid-cols-[300px_1fr]">
        <div class="relative bg-night p-8 text-white">
          <img
            src={FOUNDER.avatar}
            alt={`${FOUNDER.name} ${FOUNDER.handle}`}
            width="160"
            height="160"
            loading="lazy"
            class="h-32 w-32 rounded-2xl object-cover ring-4 ring-accent/60 animate-float md:h-40 md:w-40"
          />
          <p class="mt-5 font-display text-2xl font-extrabold">
            {FOUNDER.name} <span class="text-accent-2">{FOUNDER.handle}</span>
          </p>
          <p class="text-sm text-[#c5d2d0]">
            Founder, <BrandLink to="owner" class="hover:text-accent-2" />
          </p>
          <div class="mt-4 flex flex-wrap gap-2">
            {FOUNDER.links.map((l) => (
              <a href={l.url} rel="noopener" target="_blank" class="chip !bg-night-3 !border-night-3 !text-white hover:!bg-accent hover:!text-night">
                {l.label}
              </a>
            ))}
          </div>
        </div>
        <div class="flex flex-col justify-between gap-6 p-6 sm:p-10">
          <div class="relative min-h-[150px] sm:min-h-[120px]" data-rotator data-interval="5200">
            {FOUNDER.quotes.map((q, i) => (
              <blockquote
                class={`absolute inset-0 font-display text-[24px] font-extrabold leading-tight transition-all duration-700 sm:text-[32px] ${i === 0 ? 'opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}
                data-rotator-item
                aria-hidden={i === 0 ? 'false' : 'true'}
              >
                <span class="text-accent-ink">“</span>
                {q}
                <span class="text-accent-ink">”</span>
              </blockquote>
            ))}
          </div>
          <ul class="grid gap-2 text-sm text-muted sm:grid-cols-2">
            {FOUNDER.facts.map((f) => (
              <li class="flex gap-2">
                <span class="md-mark">›</span>
                {f}
              </li>
            ))}
          </ul>
          <div class="-mx-1 flex" data-rotator-dots>
            {FOUNDER.quotes.map((_, i) => (
              <button type="button" class="grid h-8 min-w-8 place-items-center px-1" aria-label={`Show quote ${i + 1}`} aria-pressed={i === 0 ? 'true' : 'false'}>
                <span class={`block h-1.5 rounded-full transition-all ${i === 0 ? 'w-6 bg-accent' : 'w-1.5 bg-line'}`} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SectionHeader({ eyebrow, title, lead, center = false }: { eyebrow: string; title: string; lead?: Child; center?: boolean }) {
  return (
    <div class={`reveal ${center ? 'mx-auto text-center' : ''}`}>
      <span class="eyebrow">{eyebrow}</span>
      <h2 class={`section-title mt-3 ${center ? 'mx-auto' : ''} max-w-3xl`} dangerouslySetInnerHTML={{ __html: title }} />
      {lead ? <p class={`section-lead mt-4 ${center ? 'mx-auto' : ''}`}>{lead}</p> : null}
    </div>
  );
}
