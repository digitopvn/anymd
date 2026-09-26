/**
 * Block outline: nested tree with select, move up/down, duplicate and remove, plus drag-and-drop
 * reordering (HTML5 DnD for mouse, pointer events for touch/pen via the drag handle).
 */
import type { BlockNode, PageDocument } from './api';
import { h } from './dom';
import { contains, locate, summary } from './doc';
import { humanize } from './schema-form';

export interface DropTarget {
  index: number;
  parentId?: string;
  slot?: string;
}

export interface OutlineHandlers {
  select(id: string): void;
  move(id: string, target: DropTarget): void;
  shift(id: string, delta: -1 | 1): void;
  duplicate(id: string): void;
  remove(id: string): void;
}

interface Drop extends DropTarget {
  noop: boolean;
  el: HTMLElement;
  after: boolean;
}

interface TouchDrag {
  id: string;
  pointerId: number;
  startY: number;
  active: boolean;
  drop: Drop | null;
}

const ACCENT = '#05c977';

export class Outline {
  private doc: PageDocument | null = null;
  private selected: string | null = null;
  private dragId: string | null = null;
  private marked: HTMLElement | null = null;
  private touch: TouchDrag | null = null;

  constructor(
    private root: HTMLElement,
    private labelFor: (type: string) => string,
    private on: OutlineHandlers,
  ) {
    root.setAttribute('aria-label', 'Page blocks');
    root.addEventListener('keydown', (e) => this.onKey(e));
    root.addEventListener('dragstart', (e) => this.onDragStart(e));
    root.addEventListener('dragover', (e) => this.onDragOver(e));
    root.addEventListener('drop', (e) => this.onDrop(e));
    root.addEventListener('dragend', () => this.endDrag());
    root.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    root.addEventListener('pointermove', (e) => this.onPointerMove(e));
    root.addEventListener('pointerup', (e) => this.onPointerUp(e));
    root.addEventListener('pointercancel', () => this.endDrag());
  }

  render(doc: PageDocument, selected: string | null): void {
    this.doc = doc;
    this.selected = selected;
    const active = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    this.root.replaceChildren(...doc.blocks.map((node, i) => this.row(node, doc.blocks, i)));
    if (!doc.blocks.length) {
      this.root.appendChild(h('li', { class: 'rounded-xl border border-dashed border-line px-3 py-6 text-center text-sm text-muted' }, 'No blocks yet. Use “Add” to insert the first one.'));
    }
    if (active) this.focus(active);
  }

  /** Focuses a row control by key (`sel:<id>`, `up:<id>`…), falling back to the selected row. */
  focus(key?: string): void {
    const find = (k: string) => this.root.querySelector<HTMLButtonElement>(`[data-focus="${CSS.escape(k)}"]`);
    const el = (key && find(key)) || (this.selected ? find(`sel:${this.selected}`) : null);
    if (el && !el.disabled) el.focus();
    else if (this.selected) find(`sel:${this.selected}`)?.focus();
  }

  reveal(id: string): void {
    this.root.querySelector(`[data-box="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private row(node: BlockNode, list: BlockNode[], index: number): HTMLLIElement {
    const label = this.labelFor(node.type);
    const isSel = node.id === this.selected;
    const text = summary(node);
    const box = h(
      'div',
      { 'data-box': node.id, class: `flex items-center gap-1 rounded-xl border pr-1 ${isSel ? 'border-accent bg-accent-soft' : 'border-line bg-card'}` },
      h('span', { 'data-handle': node.id, draggable: 'true', 'aria-hidden': 'true', title: 'Drag to reorder', class: 'flex h-11 w-9 shrink-0 cursor-grab touch-none select-none items-center justify-center text-lg text-muted' }, '⠿'),
      h(
        'button',
        { type: 'button', 'data-focus': `sel:${node.id}`, 'aria-pressed': isSel ? 'true' : 'false', class: 'min-h-[44px] min-w-0 flex-1 py-1.5 text-left', onclick: () => this.on.select(node.id) },
        h('span', { class: 'block truncate text-sm font-semibold' }, label, h('span', { class: 'ml-1.5 text-xs font-normal text-muted' }, node.size)),
        text ? h('span', { class: 'block truncate text-xs text-muted' }, text) : null,
      ),
    );
    const li = h('li', { 'data-id': node.id }, box);
    if (isSel) {
      const btn = (key: string, text: string, aria: string, fn: () => void, disabled = false) =>
        h('button', { type: 'button', 'data-focus': `${key}:${node.id}`, class: 'btn btn-ghost btn-sm !min-h-[44px] !min-w-[44px] !px-2', 'aria-label': aria, title: aria, disabled, onclick: fn }, text);
      li.appendChild(
        h(
          'div',
          { class: 'mt-1 flex gap-1 pl-9', role: 'group', 'aria-label': `${label} actions` },
          btn('up', '↑', `Move ${label} up`, () => this.on.shift(node.id, -1), index === 0),
          btn('down', '↓', `Move ${label} down`, () => this.on.shift(node.id, 1), index === list.length - 1),
          btn('dup', '⧉', `Duplicate ${label}`, () => this.on.duplicate(node.id)),
          btn('del', '✕', `Remove ${label}`, () => this.on.remove(node.id)),
        ),
      );
    }
    for (const [slot, children] of Object.entries(node.slots ?? {})) {
      const ol = h('ol', { class: 'space-y-1.5', 'aria-label': `${label}: ${humanize(slot)}` }, ...children.map((c, i) => this.row(c, children, i)));
      if (!children.length) {
        ol.appendChild(
          h(
            'li',
            { 'data-slot-drop': '', 'data-parent': node.id, 'data-slot': slot, class: 'flex min-h-[44px] items-center rounded-xl border border-dashed border-line px-3 text-xs text-muted' },
            'Empty. Drag a block here, or select this block and use Add.',
          ),
        );
      }
      li.appendChild(h('div', { class: 'ml-5 mt-1.5 space-y-1 border-l-2 border-line pl-2' }, h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-muted' }, humanize(slot)), ol));
    }
    return li;
  }

  private onKey(e: KeyboardEvent): void {
    const el = e.target instanceof HTMLElement ? e.target : null;
    const key = el?.dataset.focus;
    if (!key) return;
    const id = key.slice(key.indexOf(':') + 1);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      this.on.shift(id, e.key === 'ArrowUp' ? -1 : 1);
    } else if (!e.altKey && !e.ctrlKey && !e.metaKey && key.startsWith('sel:') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const all = Array.from(this.root.querySelectorAll<HTMLElement>('[data-focus^="sel:"]'));
      all[all.indexOf(el!) + (e.key === 'ArrowUp' ? -1 : 1)]?.focus();
    }
  }

  // ─── Drag and drop ──────────────────────────────────────────────────────

  private dropAt(el: Element | null, y: number): Drop | null {
    const doc = this.doc;
    const dragId = this.dragId;
    if (!doc || !dragId || !el) return null;
    const from = locate(doc.blocks, dragId);
    if (!from) return null;
    const zone = el.closest<HTMLElement>('[data-slot-drop]');
    if (zone && this.root.contains(zone)) {
      const parentId = zone.dataset.parent!;
      if (parentId === dragId || from.node.slots) return null;
      return { parentId, slot: zone.dataset.slot, index: 0, noop: false, el: zone, after: false };
    }
    const box = el.closest<HTMLElement>('[data-box]');
    if (!box || !this.root.contains(box)) return null;
    const targetId = box.dataset.box!;
    if (targetId === dragId || contains(from.node, targetId)) return null;
    const to = locate(doc.blocks, targetId);
    if (!to) return null;
    if (to.parentId && from.node.slots) return null; // containers can't be nested
    const rect = box.getBoundingClientRect();
    const after = y > rect.top + rect.height / 2;
    const siblings = to.list.map((n) => n.id).filter((id) => id !== dragId);
    const index = siblings.indexOf(targetId) + (after ? 1 : 0);
    const noop = from.parentId === to.parentId && from.slot === to.slot && from.index === index;
    return { parentId: to.parentId, slot: to.slot, index, noop, el: box, after };
  }

  private mark(drop: Drop | null): void {
    if (this.marked && this.marked !== drop?.el) {
      this.marked.style.boxShadow = '';
      this.marked.style.borderColor = '';
    }
    this.marked = drop?.el ?? null;
    if (!drop || drop.noop) {
      if (drop) drop.el.style.boxShadow = '';
      return;
    }
    if (drop.el.hasAttribute('data-slot-drop')) drop.el.style.borderColor = ACCENT;
    else drop.el.style.boxShadow = `0 ${drop.after ? 3 : -3}px 0 0 ${ACCENT}`;
  }

  private commit(drop: Drop | null): void {
    const id = this.dragId;
    this.endDrag();
    if (id && drop && !drop.noop) this.on.move(id, { index: drop.index, parentId: drop.parentId, slot: drop.slot });
  }

  private setDragging(id: string | null): void {
    this.root.querySelectorAll<HTMLElement>('[data-box]').forEach((b) => (b.style.opacity = b.dataset.box === id ? '0.5' : ''));
  }

  private endDrag(): void {
    this.mark(null);
    this.setDragging(null);
    this.dragId = null;
    this.touch = null;
  }

  private onDragStart(e: DragEvent): void {
    const handle = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-handle]') : null;
    if (this.touch) return e.preventDefault(); // a touch drag is already in progress
    if (!handle || !e.dataTransfer) return;
    this.dragId = handle.dataset.handle!;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dragId);
    const box = handle.closest<HTMLElement>('[data-box]');
    if (box) e.dataTransfer.setDragImage(box, 20, 20);
    requestAnimationFrame(() => this.setDragging(this.dragId));
  }

  private onDragOver(e: DragEvent): void {
    if (!this.dragId) return;
    const drop = this.dropAt(e.target instanceof Element ? e.target : null, e.clientY);
    this.mark(drop);
    if (drop) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    }
  }

  private onDrop(e: DragEvent): void {
    if (!this.dragId) return;
    e.preventDefault();
    this.commit(this.dropAt(e.target instanceof Element ? e.target : null, e.clientY));
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return; // mouse uses native DnD
    const handle = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-handle]') : null;
    if (!handle) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    this.touch = { id: handle.dataset.handle!, pointerId: e.pointerId, startY: e.clientY, active: false, drop: null };
  }

  private onPointerMove(e: PointerEvent): void {
    const t = this.touch;
    if (!t || e.pointerId !== t.pointerId) return;
    if (!t.active) {
      if (Math.abs(e.clientY - t.startY) < 6) return;
      t.active = true;
      this.dragId = t.id;
      this.setDragging(t.id);
    }
    e.preventDefault();
    t.drop = this.dropAt(document.elementFromPoint(e.clientX, e.clientY), e.clientY);
    this.mark(t.drop);
    // Auto-scroll near the viewport edges.
    if (e.clientY < 70) window.scrollBy(0, -14);
    else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
  }

  private onPointerUp(e: PointerEvent): void {
    const t = this.touch;
    if (!t || e.pointerId !== t.pointerId) return;
    if (t.active) this.commit(t.drop);
    else this.endDrag();
  }
}
