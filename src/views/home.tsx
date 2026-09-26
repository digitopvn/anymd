import { LAUNCH_OFFER } from '../billing/plans';
import { FAQ, ROADMAP_SOURCES, SOURCES } from '../content/site';
import { formatNumber } from '../lib/util';
import { Icon } from './components/icons';
import { BrandLink, Converter, EcosystemGrid, FaqList, FounderCard, OfferBar, PricingCards, SectionHeader } from './components/marketing';

const HTML_NOISE = [
  '<div class="cookie-consent-v3 modal-open">',
  '<script async src="//ads.tracker.example/px.js">',
  '<nav class="mega-menu"><ul><li><a href="/deals">',
  '<div id="newsletter-popup" data-delay="4000">',
  '<aside class="related-posts sidebar sticky">',
  '<iframe src="https://ads.example/slot-728x90">',
  '<span class="share-count">1.2k</span><svg>…</svg>',
  '<div class="paywall-teaser blur-md">',
  '<footer class="site-footer"><div class="cols-6">',
  '<link rel="preload" as="font" href="/f/x.woff2">',
  '<div class="comments-widget lazy" data-src>',
  '<style>.a{}.b{}.c{}.d{}.e{}.f{}.g{}</style>',
];

const CODE_TABS: { id: string; label: string; code: string }[] = [
  { id: 'url', label: 'URL', code: 'https://anymd.cc/https://stephango.com/saw\n\n# or skip the scheme\nhttps://anymd.cc/stephango.com/saw' },
  {
    id: 'curl',
    label: 'cURL',
    code: 'curl https://anymd.cc/api/v1/convert \\\n  -H "Authorization: Bearer $ANYMD_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"url":"https://stephango.com/saw"}\'',
  },
  {
    id: 'cli',
    label: 'CLI',
    code: 'npm i -g https://cdn.anymd.cc/cli/anymd-cli-latest.tgz\n\nanymd login\nanymd https://stephango.com/saw > saw.md\nanymd search "file over app" --mode hybrid',
  },
  {
    id: 'mcp',
    label: 'MCP',
    code: '// Claude Code\nclaude mcp add --transport http anymd https://anymd.cc/mcp\n\n// Any MCP client (OAuth or API key)\n{\n  "mcpServers": {\n    "anymd": {\n      "url": "https://anymd.cc/mcp",\n      "headers": { "Authorization": "Bearer amd_…" }\n    }\n  }\n}',
  },
  {
    id: 'webmcp',
    label: 'WebMCP',
    code: '// On anymd.cc, in-page agents see these tools:\nnavigator.modelContext\n  // convert_url, get_page_markdown,\n  // search_library, list_documents (signed in)',
  },
  {
    id: 'js',
    label: 'JavaScript',
    code: 'const res = await fetch("https://anymd.cc/stephango.com/saw", {\n  headers: { Accept: "application/json" },\n});\nconst { title, markdown, word_count } = await res.json();',
  },
];

export function HomePage({ conversions }: { conversions: number }) {
  return (
    <>
      <OfferBar />

      {/* ── Hero ─────────────────────────────────────────── */}
      <section class="relative overflow-hidden">
        <div class="grid-bg pointer-events-none absolute inset-0 opacity-70" aria-hidden="true" />
        <div class="container-x relative pb-16 pt-12 md:pb-24 md:pt-20">
          <div class="mx-auto max-w-4xl text-center">
            <a href="https://github.com/digitopvn/anymd" rel="noopener" class="chip reveal is-in hover:border-ink">
              <Icon name="github" size={14} /> Open source · MIT · Self-hostable
            </a>
            <h1 class="reveal is-in mt-6 font-display text-[44px] font-extrabold leading-[0.98] sm:text-[64px] md:text-[84px]">
              Any URL in.
              <br />
              <span class="relative inline-block">
                <span class="md-mark text-[0.8em] align-[0.08em]">#</span> Clean Markdown out.
              </span>
            </h1>
            <p class="reveal is-in reveal-d1 mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted sm:text-[20px]">
              Your AI reads the web through a wall of HTML noise. anymd keeps only what matters — from web pages, X posts, YouTube, PDFs, GitHub and more — and files it
              in a library your agents can search.
            </p>
          </div>
          <div class="reveal is-in reveal-d2 mx-auto mt-9 max-w-3xl scroll-mt-28" id="try">
            <Converter autofocus={false} />
          </div>
          <div class="reveal is-in reveal-d3 mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
            <span class="inline-flex items-center gap-1.5">
              <Icon name="check" size={16} class="text-mint" stroke={2.4} /> No signup to try
            </span>
            <span class="inline-flex items-center gap-1.5">
              <Icon name="bolt" size={16} class="text-accent-ink" /> Runs on Cloudflare’s edge
            </span>
            {/* A live counter only reads as proof once it is meaningful; until then state a fact instead. */}
            {conversions >= 1000 ? (
              <span class="inline-flex items-center gap-1.5">
                <Icon name="activity" size={16} class="text-violet" />
                <strong class="text-ink" data-counter={conversions}>
                  {formatNumber(conversions)}
                </strong>{' '}
                conversions so far
              </span>
            ) : (
              <span class="inline-flex items-center gap-1.5">
                <Icon name="sparkles" size={16} class="text-violet" /> 500 free credits every month
              </span>
            )}
          </div>
        </div>
      </section>

      {/* ── Sources marquee ──────────────────────────────── */}
      <section class="border-y border-line bg-card py-5" aria-label="Supported sources">
        <div class="relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]">
          <div class="flex w-max animate-marquee gap-3 pr-3">
            {[...SOURCES, ...SOURCES].map((s) => (
              <span class="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-line bg-paper px-4 py-2 text-sm font-semibold">
                <Icon name={s.icon} size={16} class="text-accent-ink" /> {s.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Problem story ────────────────────────────────── */}
      <section class="section" id="why">
        <div class="container-x">
          <SectionHeader
            eyebrow="The problem"
            title='Your agent is paying to read <span class="hl">cookie banners</span>.'
            lead="A typical article page is mostly packaging: menus, trackers, pop-ups, related posts, inline styles. Feed that to a model and you burn tokens, context and accuracy on noise."
          />
          <div class="mt-12 grid items-stretch gap-5 lg:grid-cols-[1fr_auto_1fr]">
            <div class="reveal card-night relative h-[340px] overflow-hidden p-5">
              <div class="mb-3 flex items-center justify-between text-xs text-[#7f9098]">
                <span class="font-mono">page.html</span>
                <span class="chip !bg-night-3 !border-night-3 !text-[#ff9c85]">~ 94% noise</span>
              </div>
              <div class="h-full overflow-hidden [mask-image:linear-gradient(transparent,#000_12%,#000_80%,transparent)]">
                <div class="font-mono text-[12.5px] leading-7 text-[#7f9098] [animation:scroll-up_22s_linear_infinite]">
                  {[...HTML_NOISE, ...HTML_NOISE].map((line, i) => (
                    <div class={i % 5 === 3 ? 'text-[#e2eae7]' : ''}>{i % 5 === 3 ? '<p>The actual sentence you wanted…</p>' : line}</div>
                  ))}
                </div>
              </div>
            </div>
            <div class="reveal reveal-d1 flex items-center justify-center">
              <div class="flex h-14 w-14 items-center justify-center rounded-full bg-brand text-ink [animation:pulse-ring_1.8s_ease-out_infinite] lg:rotate-0 rotate-90">
                <Icon name="arrow" size={24} stroke={2.4} />
              </div>
            </div>
            <div class="reveal reveal-d2 card relative h-[340px] overflow-hidden p-5">
              <div class="mb-3 flex items-center justify-between text-xs text-muted">
                <span class="font-mono">page.md</span>
                <span class="chip chip-mint">only the story</span>
              </div>
              <div class="font-mono text-[13px] leading-7 text-ink-2">
                <div class="text-muted">---</div>
                <div>
                  <span class="text-muted">title:</span> "File over app"
                </div>
                <div>
                  <span class="text-muted">author:</span> "Steph Ango"
                </div>
                <div>
                  <span class="text-muted">source:</span> "stephango.com/file-over-app"
                </div>
                <div class="text-muted">---</div>
                <div class="mt-2 font-bold text-accent-ink"># File over app</div>
                <div class="mt-1">
                  Artifacts that last are <strong>files you control</strong>, in formats anyone can open…
                </div>
                <div class="mt-2 text-info">[Read more](https://…)</div>
              </div>
            </div>
          </div>
          <div class="mt-6 grid gap-4 sm:grid-cols-3">
            {[
              ['bolt', 'Fewer tokens', 'The converter shows exactly how much smaller the Markdown is than the page it came from — often 10× or more.'],
              ['sparkles', 'Better answers', 'Headings, lists, tables, code and footnotes survive. Models reason over structure, not soup.'],
              ['clock', 'Seconds, not scripts', 'No headless browser to babysit. One request, cached at the edge, the same result every time.'],
            ].map(([icon, title, body], i) => (
              <div class={`reveal reveal-d${i + 1} card p-6`}>
                <Icon name={icon} size={22} class="text-accent-ink" />
                <h3 class="mt-3 text-lg font-bold">{title}</h3>
                <p class="mt-1.5 text-[15px] leading-relaxed text-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────── */}
      <section class="section bg-paper-2/60" id="how">
        <div class="container-x">
          <SectionHeader eyebrow="How it works" title="Three steps. The middle one is ours." center />
          <ol class="mt-12 grid gap-5 md:grid-cols-3">
            {[
              ['01', 'Prefix or paste', 'Put anymd.cc/ in front of any link, paste it above, call the API, or let your agent do it over MCP.', 'anymd.cc/stephango.com/saw'],
              ['02', 'We extract', 'Our extractor strips clutter and standardises footnotes, code and math. Dedicated adapters handle X, YouTube, GitHub, Reddit, HN and files.', 'extract → adapters → markdown'],
              ['03', 'Use it anywhere', 'Copy it, download it, send it to ChatGPT, Claude or Gemini — and signed-in conversions land in your searchable library.', 'library · search · MCP'],
            ].map(([n, title, body, code], i) => (
              <li class={`reveal reveal-d${i + 1} card relative flex flex-col p-7`}>
                <span class="font-display text-[56px] font-extrabold leading-none text-brand">{n}</span>
                <h3 class="mt-4 text-xl font-extrabold">{title}</h3>
                <p class="mt-2 flex-1 text-[15px] leading-relaxed text-muted">{body}</p>
                <code class="mt-5 block truncate rounded-lg bg-paper px-3 py-2 text-[13px] text-ink-2">{code}</code>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Sources ──────────────────────────────────────── */}
      <section class="section" id="sources">
        <div class="container-x">
          <SectionHeader
            eyebrow="What it reads"
            title="Not just web pages. <br class='hidden sm:block'/>The whole internet’s formats."
            lead="Each source gets a dedicated path, so an X post keeps its quote and stats, a YouTube video keeps its transcript, and a spreadsheet stays a table."
          />
          <div class="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SOURCES.map((s, i) => (
              <div class={`reveal reveal-d${(i % 3) + 1} group card flex items-start gap-4 p-5 transition-transform hover:-translate-y-0.5`}>
                <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink transition-colors group-hover:bg-accent group-hover:text-night">
                  <Icon name={s.icon} size={20} />
                </span>
                <div>
                  <h3 class="font-bold">{s.label}</h3>
                  <p class="mt-0.5 text-sm leading-relaxed text-muted">{s.note}</p>
                </div>
              </div>
            ))}
          </div>
          <div class="reveal mt-6 flex flex-wrap items-center gap-2 text-sm">
            <span class="font-semibold">Coming next:</span>
            {ROADMAP_SOURCES.map((s) => (
              <span class="chip">{s}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Library & search ─────────────────────────────── */}
      <section class="section bg-night text-[#e2eae7]" id="library">
        <div class="container-x">
          <div class="grid items-center gap-12 lg:grid-cols-2">
            <div class="reveal">
              <span class="eyebrow !text-[#7f9098]">Your library</span>
              <h2 class="section-title mt-3 text-white">
                Everything you convert becomes <span class="text-accent-2">memory</span>.
              </h2>
              <p class="mt-4 text-[17px] leading-relaxed text-[#9aa9ae]">
                Signed in, every conversion is saved and indexed four ways — so you (and your agents) find it again by keyword, by exact phrase, or by meaning.
              </p>
              <ul class="mt-8 space-y-4">
                {[
                  ['BM25', 'Classic relevance ranking over titles, text, domains and tags.'],
                  ['Full-text', 'Exact "phrases", AND / OR / NOT, prefix* and column filters.'],
                  ['Semantic', 'Multilingual bge-m3 embeddings find ideas, not just words.'],
                  ['Query fan-out', 'An LLM rewrites your query three ways; results are fused with RRF.'],
                  ['Jev', 'When the top results are too close to call, TypeSafe’s Jev decides which one answers you.'],
                ].map(([k, v]) => (
                  <li class="flex gap-4">
                    <span class="mt-0.5 w-28 shrink-0 font-mono text-sm font-semibold text-accent-2">{k}</span>
                    <span class="text-[15px] leading-relaxed text-[#c5d2d0]">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div class="reveal reveal-d2 card-night p-4 shadow-pop sm:p-6">
              <div class="flex items-center gap-2 rounded-xl bg-night px-4 py-3 font-mono text-sm">
                <Icon name="search" size={16} class="text-[#7f9098]" />
                <span class="text-white">keep files over apps</span>
                <span class="caret" />
              </div>
              <div class="mt-3 flex flex-wrap gap-1.5 text-[11px] font-mono">
                {['keep files over apps', 'durable file formats', 'local-first ownership', 'digital preservation'].map((v, i) => (
                  <span class={`rounded-md px-2 py-1 ${i === 0 ? 'bg-accent text-night' : 'bg-night-3 text-[#c5d2d0]'}`}>{v}</span>
                ))}
              </div>
              <ul class="mt-4 space-y-2.5">
                {[
                  ['File over app', 'stephango.com', 'bm25 · semantic', true],
                  ['Local-first software', 'inkandswitch.com', 'semantic · fan-out', false],
                  ['The Markdown guide', 'markdownguide.org', 'bm25', false],
                ].map(([title, domain, via, jev]) => (
                  <li class="rounded-xl border border-night-3 bg-night p-4">
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-semibold text-white">{title}</span>
                      {jev ? <span class="chip !border-accent/40 !bg-accent/15 !text-accent-2 !text-[11px]">Jev pick</span> : null}
                    </div>
                    <div class="mt-1 flex justify-between gap-2 text-xs text-[#7f9098]">
                      <span>{domain}</span>
                      <span class="font-mono">{via}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <p class="mt-4 text-center text-xs text-[#7f9098]">Illustration. Search is free — it never costs credits.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── For agents ───────────────────────────────────── */}
      <section class="section" id="agents">
        <div class="container-x">
          <div class="grid items-start gap-12 lg:grid-cols-[1fr_1.2fr]">
            <div class="reveal">
              <SectionHeader
                eyebrow="Built for agents"
                title="One endpoint. <br/>Every way your agent talks."
                lead="URL prefix for quick hacks, REST for apps, a CLI for pipelines, MCP over HTTP for Claude, Cursor and friends, and WebMCP for agents living in the browser."
              />
              <div class="mt-8 grid grid-cols-2 gap-3 text-sm">
                {[
                  ['plug', 'MCP over HTTP', 'OAuth 2.1 + PKCE or API keys'],
                  ['terminal', 'CLI', 'Pipe Markdown anywhere'],
                  ['code', 'REST + OpenAPI', 'Interactive reference'],
                  ['globe', 'WebMCP', 'Tools inside the page'],
                ].map(([icon, t, d]) => (
                  <div class="card p-4">
                    <Icon name={icon} size={18} class="text-accent-ink" />
                    <p class="mt-2 font-bold">{t}</p>
                    <p class="text-muted">{d}</p>
                  </div>
                ))}
              </div>
            </div>
            <div class="reveal reveal-d2 card-night overflow-hidden shadow-pop" data-tabs>
              <div class="scroll-x flex gap-1 border-b border-night-3 p-2" role="tablist" aria-label="Integration examples">
                {CODE_TABS.map((t, i) => (
                  <button type="button" class="tab" role="tab" aria-selected={i === 0 ? 'true' : 'false'} data-tab={t.id}>
                    {t.label}
                  </button>
                ))}
              </div>
              {CODE_TABS.map((t, i) => (
                <div class={i === 0 ? '' : 'hidden'} data-panel={t.id} role="tabpanel">
                  <div class="relative">
                    <pre class="md-output min-h-[260px] overflow-x-auto p-5 !whitespace-pre">{t.code}</pre>
                    <button type="button" class="btn btn-sm absolute right-3 top-3 !min-h-8 bg-night-3 !px-2.5 text-white hover:bg-[#2e3d48]" data-copy={t.code} aria-label="Copy code">
                      <Icon name="copy" size={14} />
                    </button>
                  </div>
                </div>
              ))}
              <div class="border-t border-night-3 px-5 py-3 text-sm">
                <a href="/docs" class="font-semibold text-accent-2 hover:underline">
                  Read the docs →
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trust ────────────────────────────────────────── */}
      <section class="section bg-paper-2/60" id="trust">
        <div class="container-x">
          <SectionHeader eyebrow="Why trust it" title="Boring where it matters." center lead="Proven extraction, open code, edge infrastructure and privacy defaults you do not have to ask for." />
          <div class="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ['layers', 'Proven engine', 'Battle-tested content extraction, plus dedicated adapters for X, YouTube, GitHub, Reddit, Hacker News and files.'],
              ['github', 'Open source, MIT', 'Read every line, open an issue, or self-host it on your own Cloudflare account.'],
              ['bolt', 'Cloudflare edge', 'Workers, D1, Vectorize and R2 in 300+ cities. Results cached at the edge for an hour.'],
              ['lock', 'Private by default', 'Your library is yours. We never sell data or train models on what you convert. Delete anything, anytime.'],
              ['shield', 'Secure access', 'API keys stored as hashes, role-scoped permissions, OAuth 2.1 with PKCE for MCP clients.'],
              ['star', 'Fair pricing', 'Pay per page, not per seat. Cached hits and search are free. 14-day money-back.'],
            ].map(([icon, t, d], i) => (
              <div class={`reveal reveal-d${(i % 3) + 1} card p-6`}>
                <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-night text-white">
                  <Icon name={icon} size={18} />
                </span>
                <h3 class="mt-4 text-lg font-bold">{t}</h3>
                <p class="mt-1.5 text-[15px] leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing teaser ───────────────────────────────── */}
      <section class="section" id="pricing">
        <div class="container-x">
          <SectionHeader
            eyebrow="Pricing"
            title="Pay for pages, <span class='hl'>not seats</span>."
            lead="1 credit = 1 web page. Start free, upgrade when your agents get hungry. Pro and Scale never block you — overage is billed per 1,000 credits."
            center
          />
          <div class="reveal mt-10">
            <PricingCards />
          </div>
          <div class="reveal mx-auto mt-8 flex max-w-2xl flex-col items-center gap-3 rounded-2xl border border-dashed border-accent/50 bg-accent-soft/60 p-5 text-center sm:flex-row sm:text-left">
            <Icon name="gift" size={28} class="shrink-0 text-accent-ink" />
            <p class="text-[15px]">
              <strong>Launch offer:</strong> {LAUNCH_OFFER.percent}% off Pro or Scale with <code class="font-mono font-bold">{LAUNCH_OFFER.code}</code>.{' '}
              <span class="text-muted">
                Ends in <span class="font-mono font-semibold text-ink" data-countdown={LAUNCH_OFFER.endsAt} />.
              </span>
            </p>
          </div>
          <p class="mt-6 text-center text-sm">
            <a href="/pricing" class="font-semibold underline underline-offset-4">
              Compare plans and credit costs →
            </a>
          </p>
        </div>
      </section>

      {/* ── Founder ──────────────────────────────────────── */}
      <section class="section bg-paper-2/60" id="founder">
        <div class="container-x">
          <SectionHeader eyebrow="Who builds it" title="Made by people who ship agents every day." />
          <div class="reveal mt-10">
            <FounderCard />
          </div>
        </div>
      </section>

      {/* ── Ecosystem ────────────────────────────────────── */}
      <section class="section" id="ecosystem">
        <div class="container-x">
          <div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <SectionHeader
              eyebrow="The Digitop ecosystem"
              title="anymd plays well with friends."
              lead={
                <>
                  Tools from <BrandLink to="owner" /> and <BrandLink to="partner" /> for building, running and remembering with AI agents.
                </>
              }
            />
            <a href="/ecosystem" class="btn btn-ghost reveal shrink-0">
              See all <Icon name="arrow" size={16} />
            </a>
          </div>
          <div class="reveal mt-10">
            <EcosystemGrid />
          </div>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────── */}
      <section class="section bg-paper-2/60" id="faq">
        <div class="container-x grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <SectionHeader eyebrow="FAQ" title="Questions, answered." lead="Still curious? Email hello@digitop.ai — a human replies." />
          <div class="reveal">
            <FaqList items={FAQ} />
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────── */}
      <section class="relative overflow-hidden bg-brand text-ink">
        <div class="container-x relative py-20 text-center md:py-28">
          <h2 class="reveal mx-auto max-w-3xl font-display text-[40px] font-extrabold leading-[1.02] md:text-[64px]">Stop feeding your agent HTML.</h2>
          <p class="reveal reveal-d1 mx-auto mt-5 max-w-xl text-lg text-ink/80">Convert your first page in five seconds. Keep everything in a library your agents can search.</p>
          <div class="reveal reveal-d2 mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <a href="/signup" class="btn btn-dark h-12 px-6 text-base">
              Create free account <Icon name="arrow" size={16} />
            </a>
            <a href="#try" class="btn btn-light h-12 px-6 text-base">
              Try without signing up
            </a>
          </div>
          <p class="reveal reveal-d3 mt-5 text-sm text-ink/70">500 free credits every month · no card required</p>
        </div>
      </section>

      <ReturnOffer />
    </>
  );
}

/** Returning-visitor offer. Shown by the client script on a later visit, with its own 48h timer. */
function ReturnOffer() {
  return (
    <div class="fixed inset-x-3 bottom-3 z-[60] hidden sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[380px]" data-return-offer data-hours={LAUNCH_OFFER.returnVisitorHours} role="dialog" aria-labelledby="return-offer-title">
      <div class="card overflow-hidden shadow-pop">
        <div class="bg-night px-5 py-3 text-white flex items-center justify-between">
          <span class="font-mono text-xs uppercase tracking-widest text-accent-2">Welcome back</span>
          <button type="button" class="rounded-md p-1 hover:bg-night-3" data-return-close aria-label="Close offer">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div class="p-5">
          <p id="return-offer-title" class="font-display text-2xl font-extrabold leading-tight">
            {LAUNCH_OFFER.returnVisitorPercent}% off, just for coming back.
          </p>
          <p class="mt-2 text-sm text-muted">
            Use <code class="font-mono font-bold text-ink">{LAUNCH_OFFER.returnVisitorCode}</code> at checkout. It expires in{' '}
            <strong class="font-mono text-ink" data-return-countdown>
              48:00:00
            </strong>
            .
          </p>
          <div class="mt-4 flex gap-2">
            <a href="/pricing" class="btn btn-primary btn-sm flex-1" data-copy-on-click={LAUNCH_OFFER.returnVisitorCode}>
              Claim {LAUNCH_OFFER.returnVisitorPercent}% off
            </a>
            <button type="button" class="btn btn-ghost btn-sm" data-return-close>
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
