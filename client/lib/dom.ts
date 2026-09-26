/** Small DOM, storage and feedback helpers shared by the browser scripts. */

/** Anything with querySelector (Document, Element, fragment). Avoids ParentNode, which clashes with Workers' Element typings. */
type Scope = Pick<ParentNode, 'querySelector' | 'querySelectorAll'>;

export const $ = <T extends Element = HTMLElement>(sel: string, root: Scope = document): T | null => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: Scope = document): T[] => Array.from(root.querySelectorAll<T>(sel));

/** Closest ancestor (or self) of an event target matching `sel`. */
export function closestTarget<T extends Element = HTMLElement>(e: Event, sel: string): T | null {
  return e.target instanceof Element ? e.target.closest<T>(sel) : null;
}

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let seq = 0;
export const uid = (prefix: string): string => `${prefix}-${++seq}`;

type Area = 'local' | 'session';
const area = (a: Area): Storage => (a === 'local' ? localStorage : sessionStorage);

/** Web Storage that never throws: private mode, disabled storage and quota errors all read as "nothing stored". */
export const store = {
  get<T>(key: string, a: Area = 'local'): T | null {
    try {
      const raw = area(a).getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown, a: Area = 'local'): void {
    try {
      area(a).setItem(key, JSON.stringify(value));
    } catch {
      // Storage unavailable: the feature simply won't remember across visits.
    }
  },
};

let toastTimer = 0;
/** Show a message in the shared #toast live region. */
export function toast(message: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

export const errorMessage = (err: unknown, fallback = 'Something went wrong. Try again.'): string => (err instanceof Error && err.message ? err.message : fallback);

/**
 * Enhance a <details> disclosure: mirror state in aria-expanded, close after a link is used and,
 * for dropdowns, close on outside click and Escape.
 */
export function disclosure(details: HTMLDetailsElement, dropdown = true): void {
  const summary = details.querySelector('summary');
  const sync = () => summary?.setAttribute('aria-expanded', String(details.open));
  details.addEventListener('toggle', sync);
  sync();
  details.addEventListener('click', (e) => {
    if (closestTarget(e, 'a[href]')) details.open = false;
  });
  if (!dropdown) return;
  document.addEventListener('click', (e) => {
    if (details.open && e.target instanceof Node && !details.contains(e.target)) details.open = false;
  });
  details.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !details.open) return;
    details.open = false;
    summary?.focus();
  });
}

/**
 * Accessible tab behaviour for a set of role="tab" buttons: aria-selected, roving tabindex and
 * Arrow/Home/End keys. Returns a function to select a tab programmatically.
 */
export function setupTabs(tabs: HTMLElement[], onSelect: (tab: HTMLElement) => void): (tab: HTMLElement) => void {
  const activate = (tab: HTMLElement, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    if (focus) tab.focus();
    onSelect(tab);
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      const n = tabs.length;
      const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
      if (next < 0) return;
      e.preventDefault();
      activate(tabs[next], true);
    });
  });
  const current = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
  for (const t of tabs) t.tabIndex = t === current ? 0 : -1;
  return activate;
}
