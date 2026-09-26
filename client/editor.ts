/**
 * Page-builder editor island for /admin/pages/:id. Hooks into the shell rendered by
 * `PageEditorPage` (src/views/admin.tsx) through data-ed-* attributes. Every change is an op batch
 * sent to /api/v1/admin/pages/:id/ops against the current revision; the preview iframe reloads after
 * each saved batch. Undo replays inverse ops computed from the document before each change.
 */
import { ApiError, getCatalog, getPage, postOps, publish, unpublish, type BlockNode, type CatalogItem, type JsonSchema, type OpsResult, type PageDocument, type PageOp, type PageView } from './editor/api';
import { Aliases, clone, inverseOf, locate, sameJson, type UndoEntry } from './editor/doc';
import { h, isEditable, isMobile, qs, qsa, toast, type Root } from './editor/dom';
import { Outline, type DropTarget } from './editor/outline';
import { Preview } from './editor/preview';
import { buildSchemaForm, humanize, validate, type SchemaForm } from './editor/schema-form';
import { registerEditorTools } from './editor/webmcp';

interface Boot {
  pageId: string;
  canPublish: boolean;
}

interface OpenForm {
  id: string;
  form: SchemaForm;
  schema: JsonSchema;
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 600;
const UNDO_LIMIT = 50;
const CATEGORY_ORDER = ['hero', 'content', 'layout', 'product', 'conversion', 'social-proof'];
const EMPTY_DOC: PageDocument = { version: 1, layout: 'default', seo: {}, blocks: [] };

function readBoot(): Boot | null {
  try {
    const raw: unknown = JSON.parse(document.getElementById('editor-boot')?.textContent ?? '');
    if (raw && typeof raw === 'object' && typeof (raw as Boot).pageId === 'string' && (raw as Boot).pageId) {
      return { pageId: (raw as Boot).pageId, canPublish: (raw as Boot).canPublish === true };
    }
  } catch {
    // fall through
  }
  return null;
}

function need<T extends Element = HTMLElement>(sel: string, root: Root = document): T {
  const el = qs<T>(sel, root);
  if (!el) throw new Error(`Editor markup is missing ${sel}`);
  return el;
}

class Editor {
  private page!: PageView;
  private doc: PageDocument = EMPTY_DOC;
  private catalog = new Map<string, CatalogItem>();
  private selected: string | null = null;
  /** Slot to insert into when the selected block is a container; null inserts after it. */
  private insertSlot: string | null = null;
  private undoStack: UndoEntry[] = [];
  private aliases = new Aliases();
  private chain: Promise<unknown> = Promise.resolve();
  private busy = 0;
  /** Bumped on a revision conflict so batches queued against stale state are dropped. */
  private gen = 0;
  private form: OpenForm | null = null;
  private pending: OpenForm | null = null;
  private pendingTimer = 0;
  private savedTimer = 0;

  private readonly root = need('[data-editor]');
  private readonly el = {
    title: need('[data-ed-title]', this.root),
    slug: need('[data-ed-slug]', this.root),
    rev: need('[data-ed-rev]', this.root),
    status: need('[data-ed-status]', this.root),
    saving: need('[data-ed-saving]', this.root),
    undo: need<HTMLButtonElement>('[data-ed-action="undo"]', this.root),
    settings: need<HTMLButtonElement>('[data-ed-action="settings"]', this.root),
    publish: qs<HTMLButtonElement>('[data-ed-action="publish"]', this.root),
    unpublish: qs<HTMLButtonElement>('[data-ed-action="unpublish"]', this.root),
    add: need<HTMLButtonElement>('[data-ed-action="add"]', this.root),
    previewLink: need<HTMLAnchorElement>('[data-ed-preview-link]', this.root),
    outline: need('[data-ed-outline]', this.root),
    palette: need('[data-ed-palette]', this.root),
    paletteList: need('[data-ed-palette-list]', this.root),
    frameWrap: need('[data-ed-frame-wrap]', this.root),
    frame: need<HTMLIFrameElement>('[data-ed-frame]', this.root),
    props: need('[data-ed-props]', this.root),
    dialog: need<HTMLDialogElement>('dialog[data-ed-dialog]', this.root),
    settingsForm: need<HTMLFormElement>('form[data-ed-settings-form]', this.root),
  };
  private readonly paletteTarget = h('div', { class: 'mb-2 text-xs text-muted', 'aria-live': 'polite' });
  private readonly dialogError = h('p', { role: 'alert', class: 'mt-3 hidden rounded-xl border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger' });

  private readonly outline: Outline;
  private readonly preview: Preview;

  constructor(private boot: Boot) {
    this.outline = new Outline(this.el.outline, (type) => this.catalog.get(type)?.label ?? type, {
      select: (id) => this.select(id, 'outline'),
      move: (id, target) => this.move(id, target),
      shift: (id, delta) => this.shift(id, delta),
      duplicate: (id) => this.duplicate(id),
      remove: (id) => this.remove(id),
    });
    this.preview = new Preview(this.el.frame, (id) => this.select(id, 'preview'));
  }

  async start(): Promise<void> {
    this.wire();
    this.el.outline.replaceChildren(h('li', { class: 'px-1 py-3 text-sm text-muted' }, 'Loading blocks…'));
    try {
      const [page, catalog] = await Promise.all([getPage(this.boot.pageId), getCatalog()]);
      for (const item of catalog) this.catalog.set(item.type, item);
      this.renderPalette();
      this.setPage(page, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retry = h('button', { type: 'button', class: 'btn btn-ghost btn-sm mt-2', onclick: () => void this.start() }, 'Retry');
      this.el.outline.replaceChildren(h('li', { role: 'alert', class: 'rounded-xl border border-danger-line bg-danger-soft px-3 py-3 text-sm text-danger' }, `Could not load the editor: ${msg}`, h('br'), retry));
    }
  }

  // ─── Wiring ─────────────────────────────────────────────────────────────

  private wiredOnce = false;

  private wire(): void {
    if (this.wiredOnce) return;
    this.wiredOnce = true;
    const { el } = this;
    el.saving.setAttribute('role', 'status');
    el.saving.setAttribute('aria-live', 'polite');
    el.undo.addEventListener('click', () => this.undo());
    el.settings.addEventListener('click', () => this.openSettings());
    el.publish?.addEventListener('click', () => this.publishClick());
    el.unpublish?.addEventListener('click', () => this.unpublishClick());
    el.add.addEventListener('click', () => this.togglePalette());
    el.palette.id ||= 'ed-palette';
    el.add.setAttribute('aria-controls', el.palette.id);
    el.add.setAttribute('aria-expanded', 'false');
    el.palette.insertBefore(this.paletteTarget, el.paletteList);
    el.previewLink.setAttribute('aria-label', 'Open shareable preview in a new tab');
    this.updateUndo();

    // Registered synchronously (before site.js finishes its async WebMCP setup); tools that need the
    // loaded page report `not_ready` until boot completes.
    const ready = () => {
      if (!this.page) throw new ApiError('The editor is still loading. Retry in a moment.', 503, 'not_ready');
    };
    registerEditorTools({
      pageId: this.boot.pageId,
      canPublish: this.boot.canPublish,
      getPage: () => getPage(this.boot.pageId),
      listBlocks: () => Array.from(this.catalog.values()),
      applyOps: async (base, ops, key) => (ready(), this.applyExternal(base, ops, key)),
      publish: async (revision) => (ready(), this.enqueue(() => this.doPublish(revision))),
    });

    // Mobile tabs; `lg:block` keeps every pane visible on desktop whatever the active tab.
    const tabs = qsa<HTMLButtonElement>('[data-ed-tab]', this.root);
    for (const pane of qsa('[data-ed-pane]', this.root)) {
      pane.classList.add('lg:block');
      pane.id ||= `ed-pane-${pane.dataset.edPane}`;
    }
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-controls', `ed-pane-${tab.dataset.edTab}`);
      tab.addEventListener('click', () => this.showTab(tab.dataset.edTab!));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        this.showTab(next.dataset.edTab!);
        next.focus();
      });
    });
    this.showTab('outline');

    // Preview widths.
    const widths = qsa<HTMLButtonElement>('[data-ed-width]', this.root);
    for (const btn of widths) {
      btn.addEventListener('click', () => {
        const w = btn.dataset.edWidth!;
        el.frameWrap.style.width = w.endsWith('%') ? w : `${Number(w)}px`;
        el.frameWrap.style.maxWidth = '100%';
        widths.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      });
    }

    // Settings dialog.
    qs<HTMLButtonElement>('button[value="cancel"]', el.settingsForm)?.setAttribute('formnovalidate', '');
    const actions = el.settingsForm.lastElementChild;
    el.settingsForm.insertBefore(this.dialogError, actions);
    el.settingsForm.addEventListener('submit', (e) => this.saveSettings(e as SubmitEvent));

    document.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('beforeunload', (e) => {
      if (!this.pending && !this.busy) return;
      this.flushPending();
      e.preventDefault();
      e.returnValue = '';
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (this.el.dialog.open || !this.page) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      if (isEditable(e.target)) return; // native text undo
      e.preventDefault();
      this.undo();
    } else if (e.key === 'Delete' && !mod && this.selected && !isEditable(e.target) && !(e.target instanceof Node && (this.el.props.contains(e.target) || this.el.palette.contains(e.target)))) {
      e.preventDefault();
      this.remove(this.selected);
    } else if (e.key === 'Escape' && !this.el.palette.classList.contains('hidden')) {
      this.togglePalette(false);
      this.el.add.focus();
    }
  }

  private showTab(name: string): void {
    for (const tab of qsa<HTMLButtonElement>('[data-ed-tab]', this.root)) {
      const on = tab.dataset.edTab === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    for (const pane of qsa('[data-ed-pane]', this.root)) pane.classList.toggle('hidden', pane.dataset.edPane !== name);
  }

  // ─── State ──────────────────────────────────────────────────────────────

  private setPage(page: PageView, rerenderProps: boolean): void {
    const prev = this.page;
    this.page = page;
    if (!page.draft) toast('The page draft could not be read. Showing an empty page.', 'error');
    this.doc = page.draft ?? EMPTY_DOC;
    const { el } = this;
    el.title.textContent = page.title;
    el.slug.textContent = page.slug;
    el.rev.textContent = String(page.revision);
    const stale = page.status === 'published' && page.publishedRevision !== page.revision;
    el.status.textContent = stale ? `${page.status} · unpublished changes` : page.status;
    el.previewLink.href = page.previewUrl;
    this.updatePublish();

    if (this.selected) this.selected = this.aliases.resolve(this.selected);
    if (this.selected && !locate(this.doc.blocks, this.selected)) this.selected = null;
    this.outline.render(this.doc, this.selected);
    this.updatePaletteTarget();
    if (rerenderProps || this.form?.id !== (this.selected ?? undefined)) this.renderProps();
    if (!prev || prev.revision !== page.revision || prev.previewUrl !== page.previewUrl) this.preview.load(page.previewUrl);
    this.preview.select(this.selected);
  }

  private select(id: string | null, source: 'outline' | 'preview' | 'program'): void {
    if (id && !locate(this.doc.blocks, id)) return;
    if (id !== this.selected) {
      this.flushPending();
      this.selected = id;
      const node = id ? locate(this.doc.blocks, id)?.node : null;
      this.insertSlot = node?.slots ? (Object.keys(node.slots)[0] ?? null) : null;
      this.outline.render(this.doc, id);
      this.updatePaletteTarget();
      this.renderProps();
    }
    if (id) this.outline.reveal(id);
    this.preview.select(id, source !== 'preview');
    if (source !== 'program' && id && isMobile()) this.showTab('props');
  }

  private label(type: string): string {
    return this.catalog.get(type)?.label ?? type;
  }

  // ─── Save pipeline ──────────────────────────────────────────────────────

  private setSaving(state: SaveState, message?: string): void {
    const s = this.el.saving;
    window.clearTimeout(this.savedTimer);
    s.classList.toggle('hidden', state === 'idle');
    s.style.color = state === 'error' ? '#a3301a' : '';
    s.textContent = { idle: '', dirty: 'Unsaved changes…', saving: 'Saving…', saved: 'Saved', error: message ? `Not saved: ${message}` : 'Not saved' }[state];
    if (state === 'saved') this.savedTimer = window.setTimeout(() => this.setSaving('idle'), 2500);
  }

  /** Runs tasks one at a time so every batch sees the revision produced by the previous one. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.busy++;
    this.setSaving('saving');
    const run = this.chain.then(task);
    const done = () => {
      this.busy--;
      if (!this.busy && !this.pending) this.setSaving('saved');
    };
    this.chain = run.then(done, () => {
      this.busy--;
    });
    return run;
  }

  /** Sends one batch against the current revision and adopts the returned page. */
  private async send(ops: PageOp[], rerenderProps = false): Promise<OpsResult> {
    const res = await postOps(this.page.id, this.page.revision, ops.map((op) => this.aliases.op(op)));
    this.setPage(res.page ?? (await getPage(this.page.id)), rerenderProps);
    return res;
  }

  /** Queues a UI batch, records its inverse for undo, and reports failures. Never rejects. */
  private perform(ops: PageOp[], opts: { label: string; onError?: (e: ApiError) => void }): Promise<OpsResult | null> {
    const gen = this.gen;
    return this.enqueue(async () => {
      if (gen !== this.gen) return null;
      const before = clone(this.doc);
      const meta = { title: this.page.title, description: this.page.description, slug: this.page.slug };
      const res = await this.send(ops);
      const entry = inverseOf(before, meta, ops, res.createdBlockIds, opts.label);
      if (entry) {
        this.undoStack.push(entry);
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        this.updateUndo();
      }
      return res;
    }).catch((e: unknown) => {
      this.fail(e, opts.onError);
      return null;
    });
  }

  private fail(e: unknown, onError?: (e: ApiError) => void): void {
    const err = e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 0, 'client_error');
    onError?.(err);
    if (err.code === 'revision_conflict') {
      this.resync('This page was changed elsewhere (another tab or an agent). Loaded the latest version; your last change was not applied.');
      return;
    }
    const message = err.status === 401 ? 'Your session expired. Reload the page to sign in again.' : err.message;
    this.setSaving('error', message);
    if (err.code !== 'invalid_props') toast(message, 'error');
  }

  /** Reloads the page after a conflict; queued stale batches and undo history are discarded. */
  private resync(message: string): void {
    this.gen++;
    window.clearTimeout(this.pendingTimer);
    this.pending = null;
    this.undoStack = [];
    this.aliases.clear();
    this.updateUndo();
    this.enqueue(async () => this.setPage(await getPage(this.page.id), true))
      .then(() => toast(message, 'error'))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.setSaving('error', msg);
        toast(`Could not reload the page: ${msg}`, 'error');
      });
  }

  /** Ops from a WebMCP agent: caller-supplied baseRevision, no undo entry, errors returned to the agent. */
  private applyExternal(baseRevision: number, ops: PageOp[], key?: string): Promise<OpsResult> {
    this.flushPending();
    return this.enqueue(async () => {
      const res = await postOps(this.page.id, baseRevision, ops, key);
      this.setPage(res.page ?? (await getPage(this.page.id)), true);
      return res;
    });
  }

  // ─── Block actions ──────────────────────────────────────────────────────

  private move(id: string, target: DropTarget): void {
    const node = locate(this.doc.blocks, id)?.node;
    if (!node) return;
    this.flushPending();
    void this.perform([{ op: 'move', id, index: target.index, parentId: target.parentId, slot: target.slot }], { label: `Move ${this.label(node.type)}` });
  }

  private shift(id: string, delta: -1 | 1): void {
    const loc = locate(this.doc.blocks, id);
    if (!loc) return;
    const index = loc.index + delta;
    if (index < 0 || index >= loc.list.length) return;
    this.move(id, { index, parentId: loc.parentId, slot: loc.slot });
  }

  private duplicate(id: string): void {
    const node = locate(this.doc.blocks, id)?.node;
    if (!node) return;
    this.flushPending();
    void this.perform([{ op: 'duplicate', id }], { label: `Duplicate ${this.label(node.type)}` }).then((res) => {
      const copy = res?.createdBlockIds[0];
      if (copy) {
        this.select(copy, 'program');
        this.outline.focus(`sel:${copy}`);
      }
    });
  }

  private remove(id: string): void {
    const loc = locate(this.doc.blocks, id);
    if (!loc) return;
    if (this.pending?.id === id) {
      window.clearTimeout(this.pendingTimer);
      this.pending = null;
    }
    this.flushPending();
    const next = loc.list[loc.index + 1]?.id ?? loc.list[loc.index - 1]?.id ?? loc.parentId ?? null;
    const label = this.label(loc.node.type);
    void this.perform([{ op: 'remove', id }], { label: `Remove ${label}` }).then((res) => {
      if (!res) return;
      toast(`Removed ${label}. Press Undo to restore it.`);
      if (!this.selected || this.selected === id) this.select(next, 'program');
      if (next) this.outline.focus(`sel:${next}`);
      else this.el.add.focus();
    });
  }

  private insert(type: string): void {
    const def = this.catalog.get(type);
    if (!def) return;
    this.flushPending();
    const target = this.insertTarget();
    void this.perform([{ op: 'insert', block: { type, props: clone(def.example), size: def.defaultSize }, ...target }], { label: `Add ${def.label}` }).then((res) => {
      const id = res?.createdBlockIds[0];
      if (!id) return;
      this.togglePalette(false);
      this.select(id, 'program');
      this.outline.focus(`sel:${id}`);
      if (isMobile()) this.showTab('props');
    });
  }

  private insertTarget(): Partial<DropTarget> & { index?: number } {
    const loc = this.selected ? locate(this.doc.blocks, this.selected) : null;
    if (!loc) return {};
    if (loc.node.slots && this.insertSlot && loc.node.slots[this.insertSlot]) {
      return { parentId: loc.node.id, slot: this.insertSlot, index: loc.node.slots[this.insertSlot].length };
    }
    return { parentId: loc.parentId, slot: loc.slot, index: loc.index + 1 };
  }

  // ─── Undo ───────────────────────────────────────────────────────────────

  private updateUndo(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    this.el.undo.disabled = !top;
    this.el.undo.setAttribute('aria-label', top ? `Undo: ${top.label}` : 'Nothing to undo');
  }

  private undo(): void {
    this.flushPending();
    const gen = this.gen;
    // Pop inside the queue: a just-flushed edit only lands on the stack once its batch has saved.
    this.enqueue(async () => {
      if (gen !== this.gen) return null;
      const entry = this.undoStack.pop();
      this.updateUndo();
      if (!entry) return null;
      for (const step of entry.steps) {
        if (step.kind === 'ops') await this.send(step.ops, true);
        else await this.restore(step.node, step.index, step.parentId, step.slot);
      }
      return entry;
    })
      .then((entry) => toast(entry ? `Undid: ${entry.label}` : 'Nothing to undo'))
      .catch((e: unknown) => this.fail(e));
  }

  /** Re-creates a removed block (and its slot children) and aliases the old ids to the new ones. */
  private async restore(node: BlockNode, index: number, parentId?: string, slot?: string): Promise<void> {
    const res = await this.send([{ op: 'insert', block: { type: node.type, props: node.props, size: node.size }, index, parentId, slot }], true);
    const created = res.createdBlockIds[0];
    if (!created) return;
    this.aliases.set(node.id, created);
    for (const [name, children] of Object.entries(node.slots ?? {})) {
      for (let i = 0; i < children.length; i++) await this.restore(children[i], i, created, name);
    }
    if (!this.selected) this.select(created, 'program');
  }

  // ─── Props panel ────────────────────────────────────────────────────────

  private renderProps(): void {
    const panel = this.el.props;
    const node = this.selected ? locate(this.doc.blocks, this.selected)?.node : null;
    this.form = null;
    if (!node) {
      panel.replaceChildren(h('p', { class: 'text-sm text-muted' }, 'Select a block to edit its content, size and layout.'));
      return;
    }
    const def = this.catalog.get(node.type);
    if (!def) {
      panel.replaceChildren(h('p', { role: 'alert', class: 'text-sm text-danger' }, `Unknown block type “${node.type}”. It can be moved or removed, but not edited here.`));
      return;
    }
    const sizeId = `ed-size-${node.id}`;
    const size = h('select', { id: sizeId, class: 'input' }, ...def.sizes.map((s) => h('option', { value: s, selected: s === node.size }, humanize(s))));
    size.addEventListener('change', () => {
      this.flushPending();
      void this.perform([{ op: 'update', id: node.id, size: size.value as typeof node.size }], { label: `Resize ${def.label}` });
    });
    const id = node.id;
    const form = buildSchemaForm(def.propsSchema, node.props, () => this.schedule());
    this.form = { id, form, schema: def.propsSchema };
    panel.replaceChildren(
      h(
        'div',
        { class: 'space-y-4' },
        h(
          'div',
          {},
          h('p', { class: 'flex items-center gap-2 font-bold' }, def.label, h('span', { class: 'chip !py-0 font-mono' }, def.type)),
          h('p', { class: 'mt-1 text-xs text-muted' }, def.description),
        ),
        def.sizes.length > 1 ? h('div', {}, h('label', { class: 'label !mb-1', for: sizeId }, 'Size'), size) : null,
        form.el,
      ),
    );
  }

  private schedule(): void {
    if (!this.form) return;
    this.pending = this.form;
    this.setSaving('dirty');
    window.clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => this.flushPending(), DEBOUNCE_MS);
  }

  /** Sends debounced prop edits now (before any other action, so ops stay in order). */
  private flushPending(): void {
    const p = this.pending;
    if (!p) return;
    window.clearTimeout(this.pendingTimer);
    this.pending = null;
    const node = locate(this.doc.blocks, p.id)?.node;
    if (!node) return;
    const props = p.form.value();
    const issues = validate(p.schema, props);
    if (issues.length) {
      p.form.showErrors(issues);
      this.setSaving('error', issues.length === 1 ? 'fix the highlighted field' : `fix ${issues.length} highlighted fields`);
      return;
    }
    p.form.clearErrors();
    if (sameJson(props, node.props)) {
      if (!this.busy) this.setSaving('idle');
      return;
    }
    // replace_props (not a merging update) so cleared optional fields are actually removed.
    void this.perform([{ op: 'replace_props', id: p.id, props }], {
      label: `Edit ${this.label(node.type)}`,
      onError: (e) => {
        if (e.code === 'invalid_props' && this.form?.form === p.form) p.form.showErrors(e.issues);
      },
    });
  }

  // ─── Palette ────────────────────────────────────────────────────────────

  private renderPalette(): void {
    const groups = new Map<string, CatalogItem[]>();
    for (const item of this.catalog.values()) {
      const cat = item.category ?? 'other';
      groups.set(cat, [...(groups.get(cat) ?? []), item]);
    }
    const order = [...CATEGORY_ORDER, ...[...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c))];
    const children: HTMLElement[] = [];
    for (const cat of order) {
      const items = groups.get(cat);
      if (!items?.length) continue;
      children.push(h('p', { class: 'col-span-2 mt-2 text-xs font-bold uppercase tracking-wide text-muted first:mt-0' }, humanize(cat)));
      for (const item of items) {
        children.push(
          h(
            'button',
            { type: 'button', 'data-type': item.type, title: item.description, class: 'min-h-[44px] rounded-xl border border-line bg-card p-2 text-left hover:border-accent disabled:opacity-40', onclick: () => this.insert(item.type) },
            h('span', { class: 'block text-sm font-semibold' }, item.label),
            h('span', { class: 'mt-0.5 block text-xs leading-snug text-muted' }, item.description),
          ),
        );
      }
    }
    this.el.paletteList.replaceChildren(...children);
  }

  private togglePalette(open?: boolean): void {
    const { palette, add } = this.el;
    const show = open ?? palette.classList.contains('hidden');
    palette.classList.toggle('hidden', !show);
    add.setAttribute('aria-expanded', String(show));
    if (show) {
      this.updatePaletteTarget();
      palette.scrollIntoView({ block: 'nearest' });
      qs<HTMLButtonElement>('button:not([disabled])', palette)?.focus();
    }
  }

  /** Explains where a palette click inserts, with a slot chooser for container blocks. */
  private updatePaletteTarget(): void {
    const loc = this.selected ? locate(this.doc.blocks, this.selected) : null;
    const box = this.paletteTarget;
    if (!loc) {
      box.replaceChildren('Inserts at the end of the page.');
    } else if (loc.node.slots) {
      const label = this.label(loc.node.type);
      const choice = (value: string | null, text: string) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip min-h-[36px] aria-pressed:!bg-ink aria-pressed:!text-paper',
            'aria-pressed': String(this.insertSlot === value),
            onclick: () => {
              this.insertSlot = value;
              this.updatePaletteTarget();
            },
          },
          text,
        );
      box.replaceChildren(
        h('span', { class: 'mb-1 block' }, `Insert into “${label}”:`),
        h('span', { class: 'flex flex-wrap gap-1', role: 'group', 'aria-label': 'Insert position' }, ...Object.keys(loc.node.slots).map((s) => choice(s, humanize(s))), choice(null, `After ${label}`)),
      );
    } else {
      box.replaceChildren(`Inserts after “${this.label(loc.node.type)}”${loc.parentId ? ` in ${humanize(loc.slot ?? '')}` : ''}.`);
    }
    // Containers can't be nested inside slots.
    const target = this.insertTarget();
    for (const btn of qsa<HTMLButtonElement>('[data-type]', this.el.paletteList)) {
      const container = !!this.catalog.get(btn.dataset.type!)?.slots?.length;
      btn.disabled = container && !!target.parentId;
    }
  }

  // ─── Settings, publish ──────────────────────────────────────────────────

  private field(name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
    const f = this.el.settingsForm.elements.namedItem(name);
    return f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement || f instanceof HTMLSelectElement ? f : null;
  }

  private openSettings(): void {
    if (!this.page) return;
    this.flushPending();
    const { page, doc } = this;
    const set = (name: string, v: string) => {
      const f = this.field(name);
      if (f) f.value = v;
    };
    set('title', page.title);
    set('slug', page.slug);
    set('description', page.description);
    set('layout', doc.layout);
    set('seo_title', doc.seo.title ?? '');
    set('seo_description', doc.seo.description ?? '');
    set('seo_image', doc.seo.image ?? '');
    const noindex = this.field('noindex');
    if (noindex instanceof HTMLInputElement) noindex.checked = doc.seo.noindex === true;
    this.dialogError.classList.add('hidden');
    if (this.el.unpublish) this.el.unpublish.hidden = page.status !== 'published';
    this.el.dialog.showModal();
    this.field('title')?.focus();
  }

  private settingsOps(): PageOp[] {
    const { page, doc } = this;
    const val = (name: string) => (this.field(name)?.value ?? '').trim();
    const ops: PageOp[] = [];
    const meta: PageOp & { op: 'set_meta' } = { op: 'set_meta' };
    if (val('title') !== page.title) meta.title = val('title');
    if (val('description') !== page.description) meta.description = val('description');
    if (val('slug') && val('slug') !== page.slug) meta.slug = val('slug');
    if (Object.keys(meta).length > 1) ops.push(meta);
    const noindex = this.field('noindex');
    const seo = { title: val('seo_title'), description: val('seo_description'), image: val('seo_image'), noindex: noindex instanceof HTMLInputElement && noindex.checked };
    const current = { title: doc.seo.title ?? '', description: doc.seo.description ?? '', image: doc.seo.image ?? '', noindex: doc.seo.noindex === true };
    if (!sameJson(seo, current)) ops.push({ op: 'set_seo', seo });
    const layout = val('layout');
    if ((layout === 'default' || layout === 'landing' || layout === 'article') && layout !== doc.layout) ops.push({ op: 'set_layout', layout });
    return ops;
  }

  private saveSettings(e: SubmitEvent): void {
    const submitter = e.submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'save') return; // Cancel closes the dialog natively.
    e.preventDefault();
    const ops = this.settingsOps();
    if (!ops.length) {
      this.el.dialog.close();
      return;
    }
    submitter.disabled = true;
    this.dialogError.classList.add('hidden');
    void this.perform(ops, {
      label: 'Page settings',
      onError: (err) => {
        this.dialogError.textContent = err.code === 'revision_conflict' ? 'The page changed elsewhere and was reloaded. Review and save again.' : err.message;
        this.dialogError.classList.remove('hidden');
      },
    }).then((res) => {
      submitter.disabled = false;
      if (!res) return;
      this.el.dialog.close();
      toast('Page settings saved');
    });
  }

  private updatePublish(): void {
    const btn = this.el.publish;
    if (!btn) return;
    if (!this.boot.canPublish) {
      btn.hidden = true;
      return;
    }
    const upToDate = this.page.status === 'published' && this.page.publishedRevision === this.page.revision;
    btn.disabled = upToDate;
    btn.textContent = upToDate ? 'Published' : 'Publish';
    btn.setAttribute('aria-label', upToDate ? 'Published: live page is up to date' : `Publish revision ${this.page.revision}`);
  }

  private async doPublish(revision?: number): Promise<PageView> {
    await publish(this.page.id, revision ?? this.page.revision);
    const page = await getPage(this.page.id);
    this.setPage(page, false);
    return page;
  }

  private publishClick(): void {
    const btn = this.el.publish;
    if (!btn || !this.boot.canPublish) return;
    this.flushPending();
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    this.enqueue(() => this.doPublish())
      .then((page) => toast(`Published at ${page.url}`))
      .catch((e: unknown) => this.fail(e))
      .finally(() => this.updatePublish());
  }

  private unpublishClick(): void {
    if (!this.boot.canPublish || !window.confirm('Unpublish this page? Visitors will get a 404 until you publish again.')) return;
    this.flushPending();
    this.enqueue(async () => {
      await unpublish(this.page.id);
      this.setPage(await getPage(this.page.id), false);
    })
      .then(() => {
        this.el.dialog.close();
        toast('Page unpublished');
      })
      .catch((e: unknown) => this.fail(e));
  }
}

function init(): void {
  const boot = readBoot();
  if (!boot || !document.querySelector('[data-editor]')) return;
  try {
    void new Editor(boot).start();
  } catch (e) {
    console.error(e);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
