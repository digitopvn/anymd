/** Tiny DOM helpers for the editor. Text always goes through text nodes, never innerHTML. */

type AttrValue = string | number | boolean | null | undefined;
type Attrs = Record<string, AttrValue | ((e: Event) => void)>;
export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, '').toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
}

export function qs<T extends Element = HTMLElement>(sel: string, root: Root = document): T | null {
  return root.querySelector(sel) as T | null;
}

export function qsa<T extends Element = HTMLElement>(sel: string, root: Root = document): T[] {
  return Array.from(root.querySelectorAll(sel)) as T[];
}

/** Workers types merge an HTMLRewriter `Element` into the DOM one, so avoid `ParentNode` directly. */
export type Root = Pick<ParentNode, 'querySelector' | 'querySelectorAll'>;

let seq = 0;
export function uid(prefix = 'ed'): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

let toastEl: HTMLElement | null = null;
let toastTimer = 0;

/** Transient status message (uses the site `.toast` component). */
export function toast(message: string, tone: 'info' | 'error' = 'info'): void {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.style.background = tone === 'error' ? '#a3301a' : '';
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('show'), tone === 'error' ? 6000 : 3000);
}

export const isMobile = (): boolean => window.matchMedia('(max-width: 1023.98px)').matches;
