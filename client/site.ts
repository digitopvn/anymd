/**
 * Progressive enhancement for every page. HTML is server-rendered and usable without this script;
 * each feature looks for its data-* hooks and does nothing when they are absent.
 */
import { initDashboard } from './dashboard';
import { requestText } from './lib/api';
import { copyText, isAiTarget, sendToAi } from './lib/clipboard';
import { initConverters } from './lib/converter';
import { initReadingOptions } from './lib/reading-options';
import { $, $$, closestTarget, disclosure, reducedMotion, setupTabs, store, uid } from './lib/dom';
import { initWebMcp } from './lib/webmcp';

document.documentElement.classList.add('js');

// ─── Shared once-a-second ticker (countdowns) ─────────────────────────────────

const tickers = new Set<() => boolean>();
let tickTimer = 0;

/** Run `fn` now and every second while it returns true. */
function everySecond(fn: () => boolean): void {
  if (!fn()) return;
  tickers.add(fn);
  if (tickTimer) return;
  tickTimer = window.setInterval(() => {
    for (const f of tickers) if (!f()) tickers.delete(f);
    if (!tickers.size) {
      clearInterval(tickTimer);
      tickTimer = 0;
    }
  }, 1000);
}

const pad = (n: number) => String(n).padStart(2, '0');

function dhms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 86400)}d ${pad(Math.floor((s % 86400) / 3600))}h ${pad(Math.floor((s % 3600) / 60))}m ${pad(s % 60)}s`;
}

function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// ─── Header ───────────────────────────────────────────────────────────────────

function initHeader(): void {
  const header = $('[data-header]');
  if (header) {
    let queued = false;
    const update = () => {
      queued = false;
      header.classList.toggle('shadow-card', window.scrollY > 8);
    };
    addEventListener(
      'scroll',
      () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(update);
      },
      { passive: true },
    );
    update();
  }
  $$<HTMLDetailsElement>('details[data-menu], [data-page-actions] details').forEach((d) => disclosure(d));
  $$<HTMLDetailsElement>('details[data-docs-nav]').forEach((d) => disclosure(d, false));
}

// ─── Scroll reveal & counters ─────────────────────────────────────────────────

function initReveal(): void {
  const items = $$('.reveal:not(.is-in)');
  if (!items.length) return;
  const show = (el: Element) => el.classList.add('is-in');
  // Content must never stay invisible: without IntersectionObserver (or with reduced motion) show everything now.
  if (reducedMotion() || !('IntersectionObserver' in window)) return items.forEach(show);
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        show(e.target);
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  items.forEach((el) => io.observe(el));
  addEventListener('beforeprint', () => items.forEach(show));
}

function initCounters(): void {
  const els = $$('[data-counter]');
  if (!els.length || reducedMotion() || !('IntersectionObserver' in window)) return;
  const fmt = new Intl.NumberFormat('en-US');
  const run = (el: HTMLElement) => {
    const target = Number(el.dataset.counter);
    if (!Number.isFinite(target) || target <= 0) return;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 1400);
      el.textContent = fmt.format(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        run(e.target as HTMLElement);
      }
    },
    { threshold: 0.5 },
  );
  els.forEach((el) => io.observe(el));
}

// ─── Countdowns & offers ──────────────────────────────────────────────────────

function initCountdowns(): void {
  for (const bar of $$('[data-offer-bar]')) {
    const ends = Number(bar.dataset.ends);
    if (ends && ends <= Date.now()) bar.hidden = true;
  }
  for (const el of $$('[data-countdown]')) {
    const ends = Number(el.dataset.countdown);
    if (!Number.isFinite(ends) || ends <= 0) continue;
    everySecond(() => {
      const left = ends - Date.now();
      if (left > 0) {
        el.textContent = dhms(left);
        return true;
      }
      // Expired: hide the offer bar, or the inline "Ends in …" wrapper.
      const scope = el.closest<HTMLElement>('[data-offer-bar]') ?? (el.parentElement?.localName === 'span' ? el.parentElement : el);
      scope.hidden = true;
      return false;
    });
  }
}

interface Visit {
  first: number;
  sessions: number;
  shownAt?: number;
  dismissed?: boolean;
}

const VISIT_KEY = 'anymd:visit';
const DAY = 864e5;

function readVisit(now: number): Visit {
  const v = store.get<Visit>(VISIT_KEY);
  if (v && typeof v.first === 'number' && typeof v.sessions === 'number') return v;
  return { first: now, sessions: 0 };
}

/** Returning visitors (a later day, or a second session) get a one-time offer with its own timer. */
function initReturnOffer(): void {
  const now = Date.now();
  const visit = readVisit(now);
  if (!store.get('anymd:session', 'session')) {
    visit.sessions += 1;
    store.set('anymd:session', 1, 'session');
  }
  const box = $('[data-return-offer]');
  const returning = visit.sessions >= 2 || now - visit.first >= DAY;
  if (box && returning && !visit.dismissed) {
    visit.shownAt ??= now;
    const ends = visit.shownAt + (Number(box.dataset.hours) || 48) * 36e5;
    if (ends > now) showReturnOffer(box, ends, visit);
  }
  store.set(VISIT_KEY, visit);
}

function showReturnOffer(box: HTMLElement, ends: number, visit: Visit): void {
  const out = $('[data-return-countdown]', box);
  const hide = () => box.classList.add('hidden');
  const dismiss = () => {
    hide();
    visit.dismissed = true;
    store.set(VISIT_KEY, visit);
  };
  $$('[data-return-close]', box).forEach((b) => b.addEventListener('click', dismiss));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismiss();
  });
  // Let the page settle before sliding in a promo.
  setTimeout(() => {
    box.classList.remove('hidden');
    everySecond(() => {
      const left = ends - Date.now();
      if (left <= 0) {
        hide();
        return false;
      }
      if (out) out.textContent = hms(left);
      return true;
    });
  }, 1500);
}

// ─── Founder quote rotator ────────────────────────────────────────────────────

const QUOTE_ON = ['opacity-100'];
const QUOTE_OFF = ['pointer-events-none', 'translate-y-3', 'opacity-0'];

function initRotators(): void {
  for (const root of $$('[data-rotator]')) {
    const items = $$('[data-rotator-item]', root);
    if (items.length < 2) continue;
    const scope = root.closest<HTMLElement>('[data-founder]') ?? root.parentElement ?? root;
    const dots = Array.from($('[data-rotator-dots]', scope)?.children ?? []) as HTMLElement[];
    let index = Math.max(0, items.findIndex((el) => el.getAttribute('aria-hidden') === 'false'));
    let hover = false;
    let focus = false;

    const show = (i: number) => {
      index = (i + items.length) % items.length;
      items.forEach((el, j) => {
        const on = j === index;
        el.classList.remove(...(on ? QUOTE_OFF : QUOTE_ON));
        el.classList.add(...(on ? QUOTE_ON : QUOTE_OFF));
        el.setAttribute('aria-hidden', String(!on));
      });
      dots.forEach((d, j) => {
        const on = j === index;
        const bar = (d.firstElementChild as HTMLElement | null) ?? d;
        bar.classList.toggle('w-6', on);
        bar.classList.toggle('bg-accent', on);
        bar.classList.toggle('w-1.5', !on);
        bar.classList.toggle('bg-line', !on);
        d.setAttribute('aria-pressed', String(on));
      });
    };

    let timer = 0;
    const restart = () => {
      clearInterval(timer);
      if (reducedMotion()) return;
      timer = window.setInterval(() => {
        if (!hover && !focus && !document.hidden) show(index + 1);
      }, Number(root.dataset.interval) || 6000);
    };

    dots.forEach((d, j) => {
      d.addEventListener('click', () => {
        show(j);
        restart();
      });
    });
    scope.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') hover = true;
    });
    scope.addEventListener('pointerleave', () => (hover = false));
    scope.addEventListener('focusin', () => (focus = true));
    scope.addEventListener('focusout', () => (focus = false));
    restart();
  }
}

// ─── Tabs, pricing, changelog filter ──────────────────────────────────────────

function initTabs(): void {
  for (const root of $$('[data-tabs]')) {
    const own = (el: Element) => el.closest('[data-tabs]') === root;
    const tabs = $$('[data-tab]', root).filter(own);
    const panels = $$('[data-panel]', root).filter(own);
    if (!tabs.length) continue;
    for (const tab of tabs) {
      const panel = panels.find((p) => p.dataset.panel === tab.dataset.tab);
      if (!panel) continue;
      panel.id ||= uid('panel');
      tab.id ||= uid('tab');
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('aria-labelledby', tab.id);
    }
    setupTabs(tabs, (tab) => {
      const id = tab.dataset.tab;
      for (const p of panels) p.classList.toggle('hidden', p.dataset.panel !== id);
      root.dispatchEvent(new CustomEvent('tabs:change', { bubbles: true, detail: { id } }));
    });
  }
}

function initPricing(): void {
  for (const root of $$('[data-pricing]')) {
    const buttons = $$('[data-period]', root);
    const apply = (period: string) => {
      const yearly = period === 'year';
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.period === period));
      for (const el of $$('[data-price-month]', root)) el.textContent = (yearly ? el.dataset.priceYear : el.dataset.priceMonth) ?? el.textContent;
      for (const el of $$('[data-yearly-note]', root)) el.textContent = yearly ? (el.dataset.yearlyNote ?? '') : '';
      // Carry the chosen billing period through signup to checkout.
      for (const a of $$<HTMLAnchorElement>('a[href^="/signup?plan="]', root)) {
        const url = new URL(a.href, location.origin);
        if (yearly) url.searchParams.set('interval', 'year');
        else url.searchParams.delete('interval');
        a.setAttribute('href', url.pathname + url.search);
      }
    };
    buttons.forEach((b) => b.addEventListener('click', () => apply(b.dataset.period ?? 'month')));
  }
}

function initFilters(): void {
  for (const group of $$('[data-filter-group]')) {
    const buttons = $$('[data-filter]', group);
    buttons.forEach((b) =>
      b.addEventListener('click', () => {
        const f = b.dataset.filter ?? 'all';
        for (const x of buttons) x.setAttribute('aria-pressed', String(x === b));
        for (const item of $$('[data-channel]')) item.hidden = f !== 'all' && item.dataset.channel !== f;
      }),
    );
  }
}

// ─── Copy buttons & page actions ──────────────────────────────────────────────

function initCopy(): void {
  document.addEventListener('click', (e) => {
    const onClick = closestTarget(e, '[data-copy-on-click]');
    if (onClick) {
      // Copy on the way through; the link still navigates.
      const code = onClick.dataset.copyOnClick ?? '';
      if (code) void copyText(code, `${code} copied`);
      return;
    }
    const el = closestTarget(e, '[data-copy]');
    if (!el) return;
    let text = el.dataset.copy ?? '';
    if (!text && el.dataset.target) {
      try {
        text = document.querySelector(el.dataset.target)?.textContent ?? '';
      } catch {
        text = ''; // invalid selector
      }
    }
    if (!text) return;
    e.preventDefault();
    void copyText(text);
  });
}

function initPageActions(): void {
  for (const root of $$('[data-page-actions]')) {
    const mdUrl = root.dataset.mdUrl ?? '';
    const title = root.dataset.title ?? '';
    if (!mdUrl) continue;
    root.addEventListener('click', (e) => {
      const btn = closestTarget(e, '[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'copy-md') void copyText(requestText(mdUrl), 'Markdown copied');
      else if (action === 'copy-md-url') void copyText(mdUrl, 'Markdown URL copied');
      else if (action === 'send' && isAiTarget(btn.dataset.target)) sendToAi(btn.dataset.target, `Read ${mdUrl}${title ? ` (“${title}” on anymd.cc)` : ''} and help me with it.`);
      root.querySelector('details')?.removeAttribute('open');
    });
  }
}

// ─── Cookie badge ─────────────────────────────────────────────────────────────

function initCookieBadge(): void {
  const root = $('[data-cookie-badge]');
  const card = root?.firstElementChild as HTMLElement | null;
  if (!root || !card) return;
  const reopen = $('[data-cookie="reopen"]', root);
  const open = (on: boolean) => {
    card.hidden = !on; // the attribute, since the card's own `flex` would fight a `hidden` class
    document.documentElement.classList.toggle('cookie-open', on);
    reopen?.classList.toggle('hidden', on);
  };
  root.classList.remove('hidden');
  open(!store.get('anymd:cookies'));
  root.addEventListener('click', (e) => {
    const choice = closestTarget(e, '[data-cookie]')?.dataset.cookie;
    if (choice === 'accept') {
      // Only an essential session cookie exists; remembering the dismissal is all there is to store.
      store.set('anymd:cookies', { choice, at: Date.now() });
      open(false);
      reopen?.focus();
    } else if (choice === 'reopen') {
      open(true);
      $('[data-cookie="accept"]', root)?.focus();
    }
  });
}

// ─── Theme ─────────────────────────────────────────────────────────────────────

const THEME_KEY = 'anymd:theme';
const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  // An explicit choice overrides the OS for the browser chrome too.
  $$<HTMLMetaElement>('meta[data-theme-color]').forEach((m) => {
    const dark = theme === 'system' ? m.media.includes('dark') : theme === 'dark';
    m.content = dark ? '#10171b' : '#f5f7f4';
  });
  $$<HTMLButtonElement>('[data-theme-toggle]').forEach((b) => {
    const label = `Color theme: ${THEME_LABEL[theme]}`;
    b.setAttribute('aria-label', label);
    b.title = label;
  });
}

function initTheme(): void {
  const saved = store.get<string>(THEME_KEY);
  let current: Theme = THEMES.includes(saved as Theme) ? (saved as Theme) : 'system';
  applyTheme(current);
  document.addEventListener('click', (e) => {
    if (!closestTarget(e, '[data-theme-toggle]')) return;
    current = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    store.set(THEME_KEY, current);
    applyTheme(current);
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

function run(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch((err) => console.error(`[anymd] ${name}`, err));
  } catch (err) {
    console.error(`[anymd] ${name}`, err);
  }
}

function boot(): void {
  run('theme', initTheme);
  run('header', initHeader);
  run('reveal', initReveal);
  run('counters', initCounters);
  run('countdowns', initCountdowns);
  run('return-offer', initReturnOffer);
  run('rotator', initRotators);
  run('tabs', initTabs);
  run('pricing', initPricing);
  run('filters', initFilters);
  run('copy', initCopy);
  run('page-actions', initPageActions);
  run('cookies', initCookieBadge);
  run('reading-options', initReadingOptions);
  run('converter', initConverters);
  run('dashboard', initDashboard);
  run('webmcp', initWebMcp);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
