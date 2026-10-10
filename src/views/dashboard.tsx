/** Signed-in dashboard: overview, library, document, search, social search, usage, traces, keys, billing. */
import type { Child } from 'hono/jsx';
import type { ApiKeyRow, UserRow } from '../auth/identity';
import { KEY_PRESETS, roleAtLeast, ROLE_TEMPLATES } from '../auth/roles';
import { getPlan, LAUNCH_OFFER, PLANS } from '../billing/plans';
import type { RoleName } from '../env';
import type { Span } from '../lib/tracer';
import type { QuotaState } from '../lib/usage';
import { formatNumber, humanDate, safeJson, timeAgo } from '../lib/util';
import type { DocumentRow, DocumentSummary } from '../library/store';
import type { SearchMode, SearchResponse } from '../library/search';
import { SOCIAL_SEARCH_CREDITS } from '../billing/plans';
import { nextPageCredits, SOCIAL_SEARCH_ALL_MAX, type SocialSearchHistoryItem, type SocialSearchResponse, type SocialSearchTarget } from '../convert/social-search';
import { Icon, Logo } from './components/icons';
import { Converter } from './components/marketing';
import type { StoredReadingPreferences } from '../convert/reading-preferences';
import { ReadingPreferencesSection } from './reading-preferences-section';
import type { ReadingFormValues } from './components/reading-options-fields';

const NAV: { href: string; label: string; icon: string; min?: RoleName }[] = [
  { href: '/dashboard', label: 'Overview', icon: 'home' },
  { href: '/dashboard/library', label: 'Library', icon: 'book' },
  { href: '/dashboard/search', label: 'Search', icon: 'search' },
  { href: '/dashboard/social', label: 'Social search', icon: 'globe' },
  { href: '/dashboard/usage', label: 'Usage logs', icon: 'chart' },
  { href: '/dashboard/traces', label: 'Traces', icon: 'activity' },
  { href: '/dashboard/keys', label: 'API keys', icon: 'key' },
  { href: '/dashboard/billing', label: 'Billing', icon: 'card' },
  { href: '/dashboard/account', label: 'Account', icon: 'settings' },
];

const ADMIN_NAV: { href: string; label: string; icon: string; min: RoleName }[] = [
  { href: '/admin/pages', label: 'Pages', icon: 'pages', min: 'author' },
  { href: '/admin/posts', label: 'Blog posts', icon: 'pen', min: 'author' },
  { href: '/admin/users', label: 'Users & roles', icon: 'users', min: 'admin' },
  { href: '/admin/optouts', label: 'Site opt-outs', icon: 'shield', min: 'admin' },
  { href: '/admin/settings', label: 'Settings', icon: 'settings', min: 'admin' },
];

export function DashShell({ user, current, title, actions, children }: { user: UserRow; current: string; title: string; actions?: Child; children: Child }) {
  const role = user.role as RoleName;
  const admin = ADMIN_NAV.filter((n) => roleAtLeast(role, n.min));
  const link = (n: { href: string; label: string; icon: string }) => (
    <a href={n.href} aria-current={current === n.href ? 'page' : undefined}>
      <Icon name={n.icon} size={17} /> {n.label}
    </a>
  );
  return (
    <div class="min-h-[100dvh] lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside class="border-b border-line bg-card lg:sticky lg:top-0 lg:h-[100dvh] lg:border-b-0 lg:border-r">
        <div class="flex h-16 items-center justify-between px-5">
          <a href="/" aria-label="anymd home">
            <Logo />
          </a>
          <form method="post" action="/logout" class="lg:hidden">
            <button class="btn btn-ghost btn-sm" type="submit" aria-label="Log out">
              <Icon name="logout" size={16} />
            </button>
          </form>
        </div>
        <nav class="dash-nav scroll-x flex gap-1 px-3 pb-3 lg:flex-col lg:overflow-visible lg:pb-0" aria-label="Dashboard">
          {NAV.map(link)}
          {admin.length ? <p class="hidden px-3 pb-1 pt-5 font-mono text-[11px] uppercase tracking-widest text-muted lg:block">Admin</p> : null}
          {admin.map(link)}
        </nav>
        <div class="absolute bottom-0 hidden w-[247px] border-t border-line p-4 lg:block">
          <p class="truncate text-sm font-semibold">{user.name || user.email}</p>
          <p class="truncate text-xs text-muted">
            {user.email} · {ROLE_TEMPLATES[role]?.label ?? role}
          </p>
          <form method="post" action="/logout" class="mt-3">
            <button class="btn btn-ghost btn-sm w-full" type="submit">
              <Icon name="logout" size={15} /> Log out
            </button>
          </form>
        </div>
      </aside>
      <div class="min-w-0">
        <header class="flex flex-wrap items-center justify-between gap-3 px-5 pb-2 pt-6 md:px-8 md:pt-8">
          <h1 class="font-display text-[28px] font-extrabold leading-tight md:text-[34px]">{title}</h1>
          {actions ? <div class="flex flex-wrap gap-2">{actions}</div> : null}
        </header>
        <div class="px-5 pb-16 pt-4 md:px-8">{children}</div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, icon }: { label: string; value: string; hint?: string; icon: string }) {
  return (
    <div class="card p-5">
      <div class="flex items-center justify-between text-sm text-muted">
        {label}
        <Icon name={icon} size={17} />
      </div>
      <p class="mt-2 font-display text-[30px] font-extrabold leading-none">{value}</p>
      {hint ? <p class="mt-2 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function QuotaBar({ q }: { q: QuotaState }) {
  const total = q.included + q.extra;
  const pct = total ? Math.min(100, Math.round((q.used / total) * 100)) : 0;
  return (
    <div>
      <div class="flex justify-between text-sm">
        <span>
          <strong>{formatNumber(q.used)}</strong> / {formatNumber(total)} credits
        </span>
        <span class="text-muted">{pct}%</span>
      </div>
      <div class="mt-2 h-2.5 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div class={`h-full rounded-full ${pct >= 90 ? 'bg-coral' : 'bg-brand'}`} style={`width:${pct}%`} />
      </div>
      <p class="mt-2 text-xs text-muted">
        {q.overage ? 'Overage billed per 1k credits beyond your plan.' : 'Resets on the 1st of each month (UTC).'}
      </p>
    </div>
  );
}

function Empty({ icon, title, body, children }: { icon: string; title: string; body: string; children?: Child }) {
  return (
    <div class="card flex flex-col items-center px-6 py-14 text-center">
      <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
        <Icon name={icon} size={22} />
      </span>
      <p class="mt-4 text-lg font-bold">{title}</p>
      <p class="mt-1 max-w-md text-sm text-muted">{body}</p>
      {children ? <div class="mt-5">{children}</div> : null}
    </div>
  );
}

function DocRow({ d }: { d: DocumentSummary }) {
  return (
    <li class="flex items-start gap-3 border-b border-line px-4 py-3.5 last:border-0 sm:px-5">
      <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-paper-2 text-muted">
        <Icon name={kindIcon(d.source_kind)} size={16} />
      </span>
      <div class="min-w-0 flex-1">
        <a href={`/dashboard/library/${d.id}`} class="line-clamp-1 font-semibold hover:underline">
          {d.title || d.url}
        </a>
        <p class="mt-0.5 truncate text-xs text-muted">
          {d.domain} · {formatNumber(d.word_count)} words · {timeAgo(d.created_at)}
        </p>
        {d.tags ? (
          <ul class="mt-1.5 flex flex-wrap gap-1.5 text-xs" aria-label="Tags">
            {d.tags.split(' ').filter(Boolean).map((t) => (
              <li>
                <a href={`/dashboard/library?tag=${encodeURIComponent(t)}`} class="chip !py-0.5 !text-xs">
                  #{t}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

export function kindIcon(kind: string): string {
  return ({ x: 'x', youtube: 'play', github: 'git', hackernews: 'hn', reddit: 'chat', pdf: 'file', image: 'image', document: 'table' } as Record<string, string>)[kind] ?? 'globe';
}

export function OverviewPage(props: { user: UserRow; quota: QuotaState; docs: number; words: number; recent: DocumentSummary[]; month: { conversions: number; errors: number }; keyCount: number; origin: string; reading: StoredReadingPreferences }) {
  const plan = getPlan(props.user.plan);
  return (
    <>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Plan" value={plan.name} hint={plan.monthly > 0 ? `$${plan.monthly}/mo` : 'Free forever'} icon="card" />
        <Stat label="Conversions this month" value={formatNumber(props.month.conversions)} hint={`${props.month.errors} failed`} icon="bolt" />
        <Stat label="Library" value={formatNumber(props.docs)} hint={`${formatNumber(props.words)} words`} icon="book" />
        <Stat label="API keys" value={String(props.keyCount)} hint="Use them in the API, CLI and MCP" icon="key" />
      </div>
      <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div class="card p-5">
          <p class="font-bold">Convert a URL</p>
          <p class="mb-4 mt-1 text-sm text-muted">Saved to your library automatically and indexed for search.</p>
          <Converter compact reading={{ preferences: props.reading.preferences, saved: props.reading.saved }} />
        </div>
        <div class="card p-5">
          <div class="flex items-center justify-between">
            <p class="font-bold">Credits</p>
            <a href="/dashboard/billing" class="text-sm font-semibold text-accent-ink hover:underline">
              {plan.id === 'free' ? 'Upgrade' : 'Manage'}
            </a>
          </div>
          <div class="mt-4">
            <QuotaBar q={props.quota} />
          </div>
          {plan.id === 'free' ? (
            <p class="mt-4 rounded-xl bg-accent-soft p-3 text-sm text-accent-ink">
              Launch offer: <strong>{LAUNCH_OFFER.percent}% off</strong> Pro or Scale with <code class="font-mono font-bold">{LAUNCH_OFFER.code}</code>.
            </p>
          ) : null}
        </div>
      </div>
      <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div class="card overflow-hidden">
          <div class="flex items-center justify-between border-b border-line px-5 py-4">
            <p class="font-bold">Recent documents</p>
            <a href="/dashboard/library" class="text-sm font-semibold text-accent-ink hover:underline">
              View all
            </a>
          </div>
          {props.recent.length ? (
            <ul>{props.recent.map((d) => <DocRow d={d} />)}</ul>
          ) : (
            <p class="px-5 py-10 text-center text-sm text-muted">Nothing yet — convert your first URL above.</p>
          )}
        </div>
        <div class="card-night p-5">
          <p class="font-bold text-white">Plug in your agent</p>
          <p class="mt-1 text-sm text-[#9aa9ae]">Create a key, then add the MCP server:</p>
          <pre class="md-output mt-4 overflow-x-auto rounded-xl bg-night p-4 !whitespace-pre text-[12px]">{`claude mcp add --transport http anymd \\\n  ${props.origin}/mcp \\\n  --header "Authorization: Bearer amd_…"`}</pre>
          <div class="mt-4 flex flex-wrap gap-2">
            <a href="/dashboard/keys" class="btn btn-primary btn-sm">
              Create API key
            </a>
            <a href="/docs/mcp" class="btn btn-sm bg-night-3 text-white hover:bg-[#2e3d48]">
              MCP docs
            </a>
          </div>
        </div>
      </div>
    </>
  );
}

export function LibraryPage({ docs, domains, kinds, tags = [], filter, nextCursor, total }: { docs: DocumentSummary[]; domains: { domain: string; n: number }[]; kinds: { kind: string; n: number }[]; tags?: { tag: string; count: number }[]; filter: { domain?: string; kind?: string; tag?: string }; nextCursor: number | null; total: number }) {
  const qs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filter, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  return (
    <>
      <form action="/dashboard/search" class="card mb-4 flex items-center gap-2 p-2">
        <Icon name="search" size={18} class="ml-2 shrink-0 text-muted" />
        <input name="q" class="min-w-0 flex-1 bg-transparent px-1 py-2.5 outline-none" placeholder={`Search ${formatNumber(total)} documents…`} aria-label="Search library" />
        <button class="btn btn-dark btn-sm" type="submit">
          Search
        </button>
      </form>
      <div class="mb-4 flex flex-wrap gap-2 text-sm">
        <a href="/dashboard/library" class={`chip ${!filter.domain && !filter.kind && !filter.tag ? '!bg-ink !text-paper !border-ink' : ''}`}>
          All · {formatNumber(total)}
        </a>
        {kinds.map((k) => (
          <a href={`/dashboard/library${qs({ kind: k.kind, domain: undefined })}`} class={`chip capitalize ${filter.kind === k.kind ? '!bg-ink !text-paper !border-ink' : ''}`}>
            {k.kind} · {k.n}
          </a>
        ))}
        {domains.slice(0, 8).map((d) => (
          <a href={`/dashboard/library${qs({ domain: d.domain, kind: undefined })}`} class={`chip ${filter.domain === d.domain ? '!bg-ink !text-paper !border-ink' : ''}`}>
            {d.domain} · {d.n}
          </a>
        ))}
      </div>
      {tags.length || filter.tag ? (
        <nav class="mb-4 flex flex-wrap items-center gap-2 text-sm" aria-label="Filter by tag">
          <span class="font-semibold">Tags</span>
          {filter.tag && !tags.some((t) => t.tag === filter.tag) ? (
            <a href={`/dashboard/library${qs({ tag: undefined })}`} class="chip !bg-ink !text-paper !border-ink" aria-current="true">
              #{filter.tag} ×
            </a>
          ) : null}
          {tags.map((t) => {
            const active = filter.tag === t.tag;
            return (
              <a href={`/dashboard/library${qs({ tag: active ? undefined : t.tag, before: undefined })}`} class={`chip ${active ? '!bg-ink !text-paper !border-ink' : ''}`} aria-current={active ? 'true' : undefined} title={active ? 'Remove tag filter' : undefined}>
                #{t.tag} · {t.count}
              </a>
            );
          })}
        </nav>
      ) : null}
      {docs.length ? (
        <div class="card overflow-hidden">
          <ul>{docs.map((d) => <DocRow d={d} />)}</ul>
        </div>
      ) : filter.tag ? (
        <Empty icon="book" title="No documents with this tag" body={`Nothing in this view is tagged #${filter.tag}.`}>
          <a href="/dashboard/library" class="btn btn-ghost">
            Show all documents
          </a>
        </Empty>
      ) : (
        <Empty icon="book" title="Your library is empty" body="Every URL you convert while signed in lands here — searchable by keyword, meaning and your agents over MCP.">
          <a href="/dashboard" class="btn btn-primary">
            Convert something
          </a>
        </Empty>
      )}
      {nextCursor ? (
        <div class="mt-4 text-center">
          <a href={`/dashboard/library${qs({ before: String(nextCursor) })}`} class="btn btn-ghost">
            Load older
          </a>
        </div>
      ) : null}
    </>
  );
}

export function DocumentPage({ doc, html, origin }: { doc: DocumentRow; html: string; origin: string }) {
  return (
    <div data-document data-doc-id={doc.id} data-title={doc.title}>
      <div class="card p-5">
        <a href={doc.url} rel="noopener nofollow" target="_blank" class="inline-flex max-w-full items-center gap-1.5 truncate text-sm text-muted hover:text-ink">
          <Icon name={kindIcon(doc.source_kind)} size={15} /> <span class="truncate">{doc.url}</span> <Icon name="external" size={13} />
        </a>
        <div class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
          {doc.author ? <span>By {doc.author}</span> : null}
          {doc.published ? <span>Published {doc.published.slice(0, 10)}</span> : null}
          <span>{formatNumber(doc.word_count)} words</span>
          <span>Saved {humanDate(doc.created_at)}</span>
          <span>{doc.embedded_chunks ? `${doc.embedded_chunks} chunks indexed` : 'Indexing…'}</span>
        </div>
        <form class="mt-4 flex flex-wrap items-center gap-2" data-tags-form>
          <label for="tags" class="text-sm font-semibold">
            Tags
          </label>
          <input id="tags" name="tags" class="input !min-h-9 max-w-sm flex-1 !py-1.5 text-sm" value={doc.tags} placeholder="research, agents" />
          <button class="btn btn-ghost btn-sm" type="submit">
            Save
          </button>
        </form>
        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" class="btn btn-dark btn-sm" data-doc-action="copy">
            <Icon name="copy" size={15} /> Copy Markdown
          </button>
          <a class="btn btn-ghost btn-sm" href={`/api/v1/library/${doc.id}?format=md`} download={`${doc.id}.md`}>
            <Icon name="download" size={15} /> Download .md
          </a>
          <button type="button" class="btn btn-ghost btn-sm" data-doc-action="chatgpt">
            ChatGPT
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-doc-action="claude">
            Claude
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-doc-action="gemini">
            Gemini
          </button>
          <button type="button" class="btn btn-ghost btn-sm !text-danger" data-doc-action="delete">
            <Icon name="trash" size={15} /> Delete
          </button>
        </div>
      </div>
      <div class="mt-4 card overflow-hidden" data-tabs>
        <div class="flex gap-1 border-b border-line bg-paper-2/60 p-2" role="tablist">
          <button type="button" class="tab !text-muted aria-selected:!bg-ink aria-selected:!text-paper" role="tab" aria-selected="true" data-tab="preview">
            Preview
          </button>
          <button type="button" class="tab !text-muted aria-selected:!bg-ink aria-selected:!text-paper" role="tab" aria-selected="false" data-tab="markdown">
            Markdown
          </button>
        </div>
        <div data-panel="preview" role="tabpanel" class="p-5 sm:p-8">
          <div class="prose-md mx-auto max-w-[760px]" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
        <div data-panel="markdown" role="tabpanel" class="hidden bg-night p-5">
          <pre class="md-output" data-raw-md>{doc.markdown}</pre>
        </div>
      </div>
      <p class="mt-3 text-xs text-muted">
        API: <code class="font-mono">GET {origin}/api/v1/library/{doc.id}</code>
      </p>
    </div>
  );
}

const MODES: { id: SearchMode; label: string; hint: string }[] = [
  { id: 'hybrid', label: 'Hybrid', hint: 'BM25 + full-text + semantic, fused with RRF' },
  { id: 'bm25', label: 'BM25', hint: 'Keyword relevance' },
  { id: 'fulltext', label: 'Full-text', hint: 'FTS5 syntax: "exact phrase", AND, OR, NOT, prefix*' },
  { id: 'semantic', label: 'Semantic', hint: 'Meaning, not words (bge-m3 embeddings)' },
];

export function SearchPage({ q, mode, fanout, decide, result, error }: { q: string; mode: SearchMode; fanout: boolean; decide: boolean; result: SearchResponse | null; error?: string }) {
  return (
    <>
      <form class="card p-3 sm:p-4" action="/dashboard/search">
        <div class="flex flex-col gap-2 sm:flex-row">
          <div class="flex min-w-0 flex-1 items-center rounded-xl bg-paper px-3">
            <Icon name="search" size={18} class="shrink-0 text-muted" />
            <input name="q" value={q} class="min-w-0 flex-1 bg-transparent px-2 py-3 outline-none" placeholder="What did that article say about…" aria-label="Query" autofocus />
          </div>
          <button class="btn btn-primary h-12" type="submit">
            Search
          </button>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {MODES.map((m) => (
            <label class="chip cursor-pointer has-[:checked]:!border-ink has-[:checked]:!bg-ink has-[:checked]:!text-paper" title={m.hint}>
              <input type="radio" name="mode" value={m.id} checked={m.id === mode} class="sr-only" />
              {m.label}
            </label>
          ))}
          <span class="mx-1 hidden h-5 w-px bg-line sm:block" />
          <label class="inline-flex items-center gap-1.5 text-muted" title="Rewrite the query 3 ways with an LLM and fuse the results">
            <input type="checkbox" name="fanout" value="1" checked={fanout} class="h-4 w-4 accent-[#05c977]" /> Query fan-out
          </label>
          <label class="inline-flex items-center gap-1.5 text-muted" title="Let Jev (TypeSafe) pick the best result when the top ones are close">
            <input type="checkbox" name="decide" value="1" checked={decide} class="h-4 w-4 accent-[#05c977]" /> Jev tie-break
          </label>
        </div>
      </form>
      {error ? <p class="mt-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}
      {result ? (
        <div class="mt-4">
          <div class="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>
              {result.hits.length} results · {result.took_ms} ms
            </span>
            {result.variants.length > 1 ? (
              <span class="flex flex-wrap gap-1">
                · variants:
                {result.variants.slice(1).map((v) => (
                  <span class="chip !text-[11px]">{v}</span>
                ))}
              </span>
            ) : null}
            {result.jev?.used ? (
              <span class="chip chip-accent !text-[11px]">
                Jev: {result.jev.choice ? `picked #1 (${Math.round((result.jev.confidence ?? 0) * 100)}%)` : result.jev.reason}
              </span>
            ) : null}
          </div>
          {result.hits.length ? (
            <ol class="mt-3 space-y-3">
              {result.hits.map((h, i) => (
                <li class="card p-4 sm:p-5">
                  <div class="flex items-start gap-3">
                    <span class="mt-0.5 font-mono text-xs text-muted">{i + 1}</span>
                    <div class="min-w-0 flex-1">
                      <a href={`/dashboard/library/${h.id}`} class="font-semibold hover:underline">
                        {h.title || h.url}
                      </a>
                      <p class="truncate text-xs text-muted">
                        {h.domain} · {timeAgo(h.created_at)}
                      </p>
                      <p class="prose-md mt-2 !text-[14px] !leading-relaxed text-ink-2" dangerouslySetInnerHTML={{ __html: h.snippet }} />
                      <div class="mt-2 flex flex-wrap gap-1">
                        {h.matched.map((m) => (
                          <span class="chip !py-0 !text-[11px]">{m}</span>
                        ))}
                        <span class="chip !py-0 !text-[11px]">score {h.score.toFixed(4)}</span>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div class="mt-3">
              <Empty icon="search" title="No matches" body="Try semantic mode, turn on fan-out, or convert more pages into your library." />
            </div>
          )}
        </div>
      ) : (
        <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {MODES.map((m) => (
            <div class="card p-4">
              <p class="font-bold">{m.label}</p>
              <p class="mt-1 text-sm text-muted">{m.hint}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const SOCIAL_LABELS: { id: SocialSearchTarget; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'x', label: 'X' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'threads', label: 'Threads' },
  { id: 'linkedin', label: 'LinkedIn' },
];
const socialLabel = (id: SocialSearchTarget) => SOCIAL_LABELS.find((p) => p.id === id)?.label ?? id;

const authorLabel = (a: SocialSearchResponse['results'][number]['author']) => a.name || (a.handle ? `@${a.handle}` : 'Unknown author');
const statLine = (s: SocialSearchResponse['results'][number]['stats']) =>
  ([['likes', s.likes], ['replies', s.replies], ['reposts', s.reposts], ['views', s.views]] as const).filter(([, n]) => n !== null).map(([label, n]) => `${formatNumber(n!)} ${label}`);

/** Past searches; each link reopens the saved results without spending credits. */
function SocialHistory({ history, current }: { history: SocialSearchHistoryItem[]; current?: string }) {
  if (!history.length) return null;
  return (
    <section class="mt-8">
      <h2 class="flex items-center gap-2 text-sm font-semibold">
        <Icon name="clock" size={16} class="text-muted" /> Recent searches
      </h2>
      <ul class="card mt-3 divide-y divide-line">
        {history.map((h) => (
          <li>
            <a
              href={`/dashboard/social/${h.id}`}
              class={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-3 text-sm hover:bg-paper ${h.id === current ? 'bg-paper' : ''}`}
              aria-current={h.id === current ? 'page' : undefined}
            >
              <span class="min-w-0 max-w-full truncate font-medium">{h.query}</span>
              <span class="chip !py-0 !text-[11px]">{socialLabel(h.platform)}</span>
              {h.paged ? <span class="chip !py-0 !text-[11px]">next page</span> : null}
              {h.channel !== 'web' ? <span class="chip !py-0 !text-[11px]">{h.channel.toUpperCase()}</span> : null}
              <span class="flex-1" />
              <span class="text-muted">
                {h.resultCount} results · {h.credits} credits · <span title={new Date(h.createdAt).toISOString()}>{timeAgo(h.createdAt)}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Posted form: every search can spend credits, so it is never a bookmarkable GET. Saved searches reopen from the history for free. */
export function SocialSearchPage({ platform, q, result, error, history = [], saved }: {
  platform: SocialSearchTarget;
  q: string;
  result: SocialSearchResponse | null;
  error?: string;
  history?: SocialSearchHistoryItem[];
  saved?: { channel: string; createdAt: number };
}) {
  const all = result?.platform === 'all';
  const more = result ? nextPageCredits(result) : 0;
  return (
    <>
      <form class="card p-3 sm:p-4" method="post" action="/dashboard/social">
        <div class="flex flex-col gap-2 sm:flex-row">
          <div class="flex min-w-0 flex-1 items-center rounded-xl bg-paper px-3">
            <Icon name="search" size={18} class="shrink-0 text-muted" />
            <input name="q" value={q} required maxlength={200} class="min-w-0 flex-1 bg-transparent px-2 py-3 outline-none" placeholder="Keywords, #hashtag or a phrase" aria-label="Query" autofocus={!saved} />
          </div>
          <button class="btn btn-primary h-12" type="submit">
            Search
          </button>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {SOCIAL_LABELS.map((p) => (
            <label class="chip cursor-pointer has-[:checked]:!border-ink has-[:checked]:!bg-ink has-[:checked]:!text-paper">
              <input type="radio" name="platform" value={p.id} checked={p.id === platform} class="sr-only" />
              {p.label}
            </label>
          ))}
        </div>
        <p class="mt-2 text-xs text-muted">
          Per page with results: {SOCIAL_SEARCH_CREDITS.x} credits for X, Facebook, Instagram or Threads, {SOCIAL_SEARCH_CREDITS.linkedin} for LinkedIn. All adds up the platforms that
          return results (at most {SOCIAL_SEARCH_ALL_MAX}). Empty pages are free.
        </p>
      </form>
      {error ? <p class="mt-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}
      {result ? (
        <div class="mt-4">
          {saved ? (
            <p class="mb-2 text-sm text-muted">
              Saved search from {humanDate(saved.createdAt)}
              {saved.channel !== 'web' ? ` via ${saved.channel.toUpperCase()}` : ''}. Reopening it is free; search again for fresh posts.
            </p>
          ) : null}
          <p class="text-sm text-muted">
            {result.results.length} results · {result.credits} credits · {result.durationMs} ms
          </p>
          {all ? (
            <p class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
              {result.platforms.map((p) => (
                <span class={p.error ? 'text-danger' : ''} title={p.error ?? undefined}>
                  {socialLabel(p.platform)}: {p.error ? 'unavailable' : String(p.count)}
                </span>
              ))}
            </p>
          ) : null}
          {result.results.length ? (
            <ol class="mt-3 space-y-3">
              {result.results.map((r) => (
                <li class="card p-4 sm:p-5">
                  <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                    {all ? <span class="chip !py-0 !text-[11px]">{socialLabel(r.platform)}</span> : null}
                    {r.author.url ? (
                      <a href={r.author.url} target="_blank" rel="noopener noreferrer nofollow" class="font-semibold hover:underline">
                        {authorLabel(r.author)}
                      </a>
                    ) : (
                      <span class="font-semibold">{authorLabel(r.author)}</span>
                    )}
                    {r.author.handle && r.author.name ? <span class="text-muted">@{r.author.handle}</span> : null}
                    {r.publishedAt ? <span class="text-muted">· {humanDate(Date.parse(r.publishedAt))}</span> : null}
                  </div>
                  {r.text ? <p class="mt-2 whitespace-pre-line break-words text-[14px] leading-relaxed text-ink-2">{r.text.length > 600 ? `${r.text.slice(0, 600)}…` : r.text}</p> : null}
                  <div class="mt-3 flex flex-wrap items-center gap-2">
                    {statLine(r.stats).map((s) => (
                      <span class="chip !py-0 !text-[11px]">{s}</span>
                    ))}
                    <span class="flex-1" />
                    <a href={r.url} target="_blank" rel="noopener noreferrer nofollow" class="btn btn-ghost !min-h-8 !px-3 !py-1 text-sm">
                      Open <Icon name="external" size={14} />
                    </a>
                    <a href={`/convert?url=${encodeURIComponent(r.url)}`} class="btn btn-dark !min-h-8 !px-3 !py-1 text-sm" title="Convert this post to Markdown and save it to your library">
                      Convert
                    </a>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div class="mt-3">
              <Empty icon="search" title="No posts found" body="Try other keywords or another platform. Empty searches are free." />
            </div>
          )}
          {result.nextCursor ? (
            <form method="post" action="/dashboard/social" class="mt-4 flex justify-center">
              <input type="hidden" name="q" value={result.query} />
              <input type="hidden" name="platform" value={result.platform} />
              <input type="hidden" name="cursor" value={result.nextCursor} />
              <button class="btn btn-ghost" type="submit">
                More results ({all ? 'up to ' : ''}
                {more} credits)
              </button>
            </form>
          ) : null}
        </div>
      ) : !error && !history.length ? (
        <div class="mt-4">
          <Empty icon="globe" title="Search public social posts" body="Find posts on X, Facebook, Instagram, Threads and LinkedIn, then convert the ones you need into your library." />
        </div>
      ) : null}
      <SocialHistory history={history} current={result?.traceId} />
    </>
  );
}

export interface UsageRow {
  id: string;
  channel: string;
  kind: string;
  target: string;
  status: string;
  http_status: number;
  credits: number;
  duration_ms: number;
  trace_id: string | null;
  error: string | null;
  created_at: number;
}

export function UsagePage({ quota, daily, events, byChannel }: { quota: QuotaState; daily: { day: string; credits: number; n: number }[]; events: UsageRow[]; byChannel: { channel: string; n: number; credits: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.n));
  return (
    <>
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.6fr]">
        <div class="card p-5">
          <p class="font-bold">This month</p>
          <div class="mt-4">
            <QuotaBar q={quota} />
          </div>
          <ul class="mt-5 space-y-2 text-sm">
            {byChannel.map((c) => (
              <li class="flex justify-between">
                <span class="capitalize">{c.channel}</span>
                <span class="text-muted">
                  {formatNumber(c.n)} calls · {formatNumber(c.credits)} credits
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div class="card p-5">
          <p class="font-bold">Last 30 days</p>
          <div class="mt-4 flex h-40 items-end gap-[3px]" role="img" aria-label="Requests per day">
            {daily.map((d) => (
              <div class="group relative flex-1 rounded-t bg-brand/80 hover:bg-accent" style={`height:${Math.max(3, Math.round((d.n / max) * 100))}%`} title={`${d.day}: ${d.n} requests, ${d.credits} credits`} />
            ))}
          </div>
          <div class="mt-2 flex justify-between text-xs text-muted">
            <span>{daily[0]?.day}</span>
            <span>{daily[daily.length - 1]?.day}</span>
          </div>
        </div>
      </div>
      <div class="card mt-4 overflow-hidden">
        <div class="border-b border-line px-5 py-4 font-bold">Request log</div>
        {events.length ? (
          <div class="scroll-x">
            <table class="table min-w-[760px]">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Channel</th>
                  <th>Target</th>
                  <th>Status</th>
                  <th>Credits</th>
                  <th>Duration</th>
                  <th>Trace</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr>
                    <td class="whitespace-nowrap text-muted" title={new Date(e.created_at).toISOString()}>
                      {timeAgo(e.created_at)}
                    </td>
                    <td>
                      <span class="chip !py-0">{e.channel}</span>
                    </td>
                    <td class="max-w-[320px]">
                      <span class="block truncate" title={e.target}>
                        {e.kind === 'search' ? `🔎 ${e.target}` : e.target}
                      </span>
                      {e.error ? <span class="block truncate text-xs text-danger">{e.error}</span> : null}
                    </td>
                    <td>
                      <StatusChip status={e.status} code={e.http_status} />
                    </td>
                    <td>{e.credits}</td>
                    <td class="whitespace-nowrap">{e.duration_ms} ms</td>
                    <td>
                      {e.trace_id ? (
                        <a class="font-mono text-xs text-accent-ink hover:underline" href={`/dashboard/traces/${e.trace_id}`}>
                          {e.trace_id.slice(-8)}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="px-5 py-10 text-center text-sm text-muted">No requests yet.</p>
        )}
      </div>
    </>
  );
}

function StatusChip({ status, code }: { status: string; code: number }) {
  const cls = status === 'error' ? '!bg-danger-soft !text-danger !border-danger-line' : status === 'cached' ? '!bg-info-soft !text-sky !border-info-line' : 'chip-mint';
  return (
    <span class={`chip !py-0 ${cls}`}>
      {status} {code !== 200 ? code : ''}
    </span>
  );
}

export interface TraceRow {
  id: string;
  kind: string;
  target: string;
  status: string;
  duration_ms: number;
  spans: string;
  meta: string;
  created_at: number;
}

export function TracesPage({ traces }: { traces: TraceRow[] }) {
  if (!traces.length) return <Empty icon="activity" title="No traces yet" body="Every conversion and search you run while signed in records a span-by-span trace here." />;
  return (
    <div class="card overflow-hidden">
      <ul>
        {traces.map((t) => {
          const spans = safeJson<Span[]>(t.spans, []);
          return (
            <li class="border-b border-line last:border-0">
              <a href={`/dashboard/traces/${t.id}`} class="flex items-center gap-3 px-5 py-3.5 hover:bg-paper-2/60">
                <StatusChip status={t.status} code={200} />
                <span class="chip !py-0">{t.kind}</span>
                <span class="min-w-0 flex-1 truncate text-sm">{t.target}</span>
                <span class="hidden text-xs text-muted sm:inline">{spans.length} spans</span>
                <span class="w-16 text-right text-sm font-semibold">{t.duration_ms} ms</span>
                <span class="hidden w-16 text-right text-xs text-muted md:inline">{timeAgo(t.created_at)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface TraceCreditMeta {
  credits?: number;
  credit_breakdown?: Record<string, number> | null;
  reading_options?: Record<string, unknown> & { sources?: Record<string, string> };
}

const ENRICHMENT_LABELS: Record<string, string> = { base: 'Base conversion', thread: 'X thread posts', comments: 'Comments & replies', images: 'Image analysis' };
const SOURCE_LABELS: Record<string, string> = { request: 'this request', preference: 'saved default', default: 'safe default' };

/** Which enrichment produced the charge and why each option was on (request, saved default or safe default). */
function TraceCredits({ meta }: { meta: TraceCreditMeta }) {
  const options = meta.reading_options;
  if (!meta.credit_breakdown && !options) return null;
  const sources = options?.sources ?? {};
  return (
    <div class="card mt-4 p-5 text-sm">
      <p class="font-bold">Credits</p>
      {meta.credit_breakdown ? (
        <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          {Object.entries(meta.credit_breakdown).map(([part, value]) => (
            <div>
              <dt class="text-muted">{ENRICHMENT_LABELS[part] ?? part}</dt>
              <dd class="font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {options ? (
        <ul class="mt-3 space-y-1 text-muted">
          {(['expandThread', 'includeComments', 'analyzeImages', 'removeImages', 'maxCredits'] as const).map((key) => (
            <li>
              <code class="font-mono text-xs">{key}</code> = {String(options[key])} <span class="text-xs">({SOURCE_LABELS[sources[key]] ?? sources[key] ?? 'unknown'})</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TraceDetailPage({ trace }: { trace: TraceRow }) {
  const spans = safeJson<Span[]>(trace.spans, []);
  const total = Math.max(1, trace.duration_ms, ...spans.map((s) => s.start + s.duration));
  return (
    <>
      <div class="card p-5 text-sm">
        <p class="break-all font-semibold">{trace.target}</p>
        <p class="mt-1 text-muted">
          {trace.kind} · {trace.status} · {trace.duration_ms} ms · {new Date(trace.created_at).toISOString()} · <code class="font-mono">{trace.id}</code>
        </p>
      </div>
      <TraceCredits meta={safeJson<TraceCreditMeta>(trace.meta, {})} />
      <div class="card mt-4 p-5">
        <p class="font-bold">Spans</p>
        <ol class="mt-4 space-y-2">
          {spans.map((s) => (
            <li class="grid grid-cols-[minmax(110px,180px)_1fr_64px] items-center gap-3 text-sm">
              <span class="truncate font-mono text-xs" title={s.meta ? JSON.stringify(s.meta) : ''}>
                {s.name}
              </span>
              <span class="relative h-5 rounded bg-paper-2">
                <span
                  class={`absolute top-0 h-5 rounded ${s.status === 'error' ? 'bg-coral' : 'bg-brand'}`}
                  style={`left:${(s.start / total) * 100}%;width:${Math.max(0.8, (s.duration / total) * 100)}%`}
                />
              </span>
              <span class="text-right text-xs text-muted">{s.duration} ms</span>
            </li>
          ))}
        </ol>
        <details class="mt-5">
          <summary class="cursor-pointer text-sm font-semibold text-muted">Raw JSON</summary>
          <pre class="md-output mt-3 overflow-x-auto rounded-xl bg-night p-4 text-[12px]">{JSON.stringify({ spans, meta: safeJson(trace.meta, {}) }, null, 2)}</pre>
        </details>
      </div>
    </>
  );
}

export interface GrantView {
  id: string;
  clientName: string;
  scopes: string[];
  createdAt: number;
}

export function KeysPage({ keys, newKey, grants, role, error }: { keys: ApiKeyRow[]; newKey?: string; grants: GrantView[]; role: RoleName; error?: string }) {
  const allowed = new Set(ROLE_TEMPLATES[role].scopes);
  return (
    <>
      {newKey ? (
        <div class="card mb-4 border-accent p-5" data-new-key>
          <p class="font-bold">Your new API key</p>
          <p class="mt-1 text-sm text-muted">Copy it now — for your security we never show it again.</p>
          <div class="mt-3 flex flex-col gap-2 sm:flex-row">
            <code class="min-w-0 flex-1 break-all rounded-xl bg-night px-4 py-3 font-mono text-sm text-[#7fe3d6]">{newKey}</code>
            <button type="button" class="btn btn-primary" data-copy={newKey}>
              <Icon name="copy" size={16} /> Copy
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p class="mb-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.5fr]">
        <form method="post" action="/dashboard/keys" class="card p-5">
          <p class="font-bold">Create a key</p>
          <div class="mt-4 space-y-4">
            <div>
              <label class="label" for="key-name">
                Name
              </label>
              <input id="key-name" name="name" class="input" placeholder="Claude Code on laptop" maxlength={80} required />
            </div>
            <fieldset>
              <legend class="label">Permissions</legend>
              <div class="space-y-2">
                {KEY_PRESETS.map((p, i) => {
                  const ok = p.scopes.some((s) => allowed.has(s));
                  return (
                    <label class={`flex cursor-pointer items-start gap-2.5 rounded-xl border border-line p-3 text-sm has-[:checked]:border-ink ${ok ? '' : 'opacity-50'}`}>
                      <input type="radio" name="preset" value={p.id} checked={i === 1} disabled={!ok} class="mt-0.5 accent-[#05c977]" />
                      <span>
                        <strong>{p.label}</strong>
                        <span class="mt-0.5 block text-xs text-muted">{p.scopes.filter((s) => allowed.has(s)).join(', ') || 'Not available for your role'}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div>
              <label class="label" for="key-exp">
                Expires
              </label>
              <select id="key-exp" name="expires_in_days" class="input">
                <option value="">Never</option>
                <option value="30">In 30 days</option>
                <option value="90" selected>
                  In 90 days
                </option>
                <option value="365">In 1 year</option>
              </select>
            </div>
            <button class="btn btn-dark w-full" type="submit">
              Create key
            </button>
          </div>
        </form>
        <div class="space-y-4">
          <div class="card overflow-hidden">
            <div class="border-b border-line px-5 py-4 font-bold">Active keys</div>
            {keys.length ? (
              <ul>
                {keys.map((k) => (
                  <li class="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5 last:border-0">
                    <div class="min-w-0 flex-1">
                      <p class="font-semibold">{k.name}</p>
                      <p class="text-xs text-muted">
                        <code class="font-mono">{k.prefix}…</code> · {safeJson<string[]>(k.scopes, []).length} scopes · created {humanDate(k.created_at)} · {k.last_used_at ? `used ${timeAgo(k.last_used_at)}` : 'never used'}
                        {k.expires_at ? ` · expires ${humanDate(k.expires_at)}` : ''}
                      </p>
                    </div>
                    <form method="post" action={`/dashboard/keys/${k.id}/revoke`} data-confirm="Revoke this key? Apps using it stop working immediately.">
                      <button class="btn btn-ghost btn-sm !text-danger" type="submit">
                        Revoke
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="px-5 py-8 text-center text-sm text-muted">No keys yet.</p>
            )}
          </div>
          <div class="card overflow-hidden">
            <div class="border-b border-line px-5 py-4">
              <p class="font-bold">Connected apps (OAuth)</p>
              <p class="text-xs text-muted">MCP clients you approved through the OAuth flow.</p>
            </div>
            {grants.length ? (
              <ul>
                {grants.map((g) => (
                  <li class="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5 last:border-0">
                    <div class="min-w-0 flex-1">
                      <p class="font-semibold">{g.clientName}</p>
                      <p class="text-xs text-muted">
                        {g.scopes.join(', ')} · since {humanDate(g.createdAt)}
                      </p>
                    </div>
                    <form method="post" action={`/dashboard/grants/${encodeURIComponent(g.id)}/revoke`} data-confirm="Disconnect this app?">
                      <button class="btn btn-ghost btn-sm !text-danger" type="submit">
                        Disconnect
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="px-5 py-8 text-center text-sm text-muted">No connected apps.</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function BillingPage({ user, quota, enabled, provider = 'Creem', notice, error, subscription, chosen = {} }: { user: UserRow; quota: QuotaState; enabled: boolean; provider?: string; notice?: string; error?: string; chosen?: { plan?: string; interval?: string }; subscription: { status: string; billing_interval: string; current_period_end: number | null; cancel_at_period_end: number } | null }) {
  const plan = getPlan(user.plan);
  return (
    <>
      {notice ? <p class="mb-4 rounded-xl border border-ok-line bg-accent-soft px-4 py-3 text-sm text-accent-ink">{notice}</p> : null}
      {error ? <p class="mb-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div class="card p-5">
          <p class="text-sm text-muted">Current plan</p>
          <p class="mt-1 font-display text-[34px] font-extrabold">{plan.name}</p>
          {subscription ? (
            <p class="text-sm text-muted">
              {subscription.status} · billed {subscription.billing_interval}ly
              {subscription.current_period_end ? ` · ${subscription.cancel_at_period_end ? 'ends' : 'renews'} ${humanDate(subscription.current_period_end)}` : ''}
            </p>
          ) : (
            <p class="text-sm text-muted">{plan.tagline}</p>
          )}
          <div class="mt-5">
            <QuotaBar q={quota} />
          </div>
          {enabled && plan.id !== 'free' ? (
            <form method="post" action="/dashboard/billing/portal" class="mt-5">
              <button class="btn btn-ghost" type="submit">
                Manage subscription & invoices
              </button>
            </form>
          ) : null}
        </div>
        <div class="card p-5">
          <p class="font-bold">Upgrade</p>
          {enabled ? (
            <p class="mt-1 text-sm text-muted">
              Secure checkout by {provider}. Code <code class="font-mono font-bold text-ink">{LAUNCH_OFFER.code}</code> takes {LAUNCH_OFFER.percent}% off.
            </p>
          ) : (
            <p class="mt-1 text-sm text-muted">Paid plans open soon on this environment. You’ll be able to upgrade here in one click.</p>
          )}
          <div class="mt-4 space-y-3">
            {PLANS.filter((p) => p.id === 'pro' || p.id === 'scale').map((p) => (
              <form method="post" action="/dashboard/billing/checkout" class={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${chosen.plan === p.id ? 'border-accent bg-accent-soft' : 'border-line'}`}>
                <input type="hidden" name="plan" value={p.id} />
                <div class="min-w-0 flex-1">
                  <p class="font-bold">
                    {p.name} <span class="font-normal text-muted">· {formatNumber(p.credits)} credits/mo</span>
                  </p>
                  <p class="text-sm text-muted">
                    ${p.monthly}/mo or ${p.yearly}/mo billed yearly
                  </p>
                </div>
                <select name="interval" class="input !min-h-10 !w-auto !py-1.5 text-sm" aria-label="Billing interval">
                  <option value="month">Monthly</option>
                  <option value="year" selected={chosen.plan === p.id && chosen.interval === 'year'}>
                    Yearly
                  </option>
                </select>
                <button class="btn btn-primary btn-sm" type="submit" disabled={!enabled || user.plan === p.id}>
                  {user.plan === p.id ? 'Current' : `Get ${p.name}`}
                </button>
              </form>
            ))}
          </div>
          <p class="mt-4 text-xs text-muted">
            Need more? <a href="mailto:hello@digitop.ai?subject=anymd%20Enterprise" class="underline">Talk to us about Enterprise</a> ·{' '}
            <a href="/legal/refund" class="underline">
              Refund policy
            </a>
          </p>
        </div>
      </div>
    </>
  );
}

export function AccountPage({ user, docs, error, reading }: { user: UserRow; docs: number; error?: string; reading: { stored: StoredReadingPreferences; notice?: string; error?: string; submitted?: ReadingFormValues } }) {
  const isOwner = user.role === 'owner';
  return (
    <>
      {error ? <p class="mb-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div class="card p-5">
          <p class="font-bold">Profile</p>
          <dl class="mt-3 space-y-2 text-sm">
            <div class="flex justify-between gap-4">
              <dt class="text-muted">Email</dt>
              <dd class="truncate">{user.email}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">Name</dt>
              <dd class="truncate">{user.name || '—'}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">Role</dt>
              <dd>{ROLE_TEMPLATES[user.role as RoleName]?.label ?? user.role}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">Member since</dt>
              <dd>{humanDate(user.created_at)}</dd>
            </div>
          </dl>
          <p class="mt-4 text-xs text-muted">
            To change your email, write to <a class="underline" href="mailto:hello@digitop.ai">hello@digitop.ai</a>. To change your password, use{' '}
            <a class="underline" href="/forgot">
              reset password
            </a>
            .
          </p>
        </div>
        <div class="card p-5">
          <p class="font-bold">Export your library</p>
          <p class="mt-1 text-sm text-muted">{formatNumber(docs)} documents. Take everything with you, any time.</p>
          <div class="mt-4 flex flex-wrap gap-2">
            <a class="btn btn-dark btn-sm" href="/dashboard/account/export?format=md" download>
              <Icon name="download" size={15} /> Markdown (.md)
            </a>
            <a class="btn btn-ghost btn-sm" href="/dashboard/account/export?format=json" download>
              <Icon name="download" size={15} /> JSON
            </a>
          </div>
        </div>
      </div>
      <ReadingPreferencesSection stored={reading.stored} notice={reading.notice} error={reading.error} submitted={reading.submitted} />
      <div class="card mt-4 border-danger-line p-5">
        <p class="font-bold text-danger">Delete account</p>
        <p class="mt-1 max-w-2xl text-sm text-muted">
          Removes your documents, embeddings, API keys, connected apps, usage logs and traces right away. Cancel any paid subscription in the billing portal first. This cannot be undone.
        </p>
        {isOwner ? (
          <p class="mt-3 text-sm">The owner account cannot be deleted. Transfer ownership first.</p>
        ) : (
          <form method="post" action="/dashboard/account/delete" class="mt-4 flex flex-wrap items-end gap-3" data-confirm="Delete your account and all your data permanently?">
            <div class="min-w-0 flex-1 sm:max-w-sm">
              <label class="label" for="confirm-email">
                Type your email to confirm
              </label>
              <input id="confirm-email" name="confirm" type="email" class="input" autocomplete="off" required placeholder={user.email} />
            </div>
            <button class="btn btn-sm !bg-danger !text-white" type="submit">
              <Icon name="trash" size={15} /> Delete my account
            </button>
          </form>
        )}
      </div>
    </>
  );
}
