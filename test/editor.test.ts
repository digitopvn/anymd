/** Editor logic against the real server op engine: undo round-trips and schema-driven prop forms. */
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { applyOpsToDocument, type PageDocument as SDoc, type PageOp as SOp } from '../src/cms/pages';
import { blockCatalog } from '../src/cms/blocks';
import { inverseOf, Aliases, clone, sameJson, type UndoEntry } from '../client/editor/doc';
import { buildSchemaForm, validate } from '../client/editor/schema-form';
import type { PageOp, PageDocument, BlockNode } from '../client/editor/api';

const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
(globalThis as any).document = document;

// Each check becomes its own test; `extra` is shown when it fails.
const checks: [string, () => [boolean, unknown?]][] = [];
const check = (name: string, fn: () => [boolean, unknown?]) => checks.push([name, fn]);

type State = { doc: PageDocument; meta: { title: string; description: string; slug: string } };
const aliases = new Aliases();
function apply(s: State, ops: PageOp[]) {
  const r = applyOpsToDocument(s.doc as unknown as SDoc, s.meta, ops.map((o) => aliases.op(o)) as unknown as SOp[]);
  s.doc = r.doc as unknown as PageDocument;
  s.meta = r.meta;
  return r.created;
}
function restore(s: State, node: BlockNode, index: number, parentId?: string, slot?: string) {
  const [id] = apply(s, [{ op: 'insert', block: { type: node.type, props: node.props, size: node.size }, index, parentId, slot }]);
  aliases.set(node.id, id);
  for (const [name, kids] of Object.entries(node.slots ?? {})) kids.forEach((k, i) => restore(s, k, i, id, name));
}
function undo(s: State, e: UndoEntry) {
  for (const st of e.steps) st.kind === 'ops' ? apply(s, st.ops) : restore(s, st.node, st.index, st.parentId, st.slot);
}
function perform(s: State, ops: PageOp[]): UndoEntry {
  const before = clone(s.doc);
  const meta = { ...s.meta };
  const created = apply(s, ops);
  return inverseOf(before, meta, ops, created, 'x')!;
}
const strip = (bs: BlockNode[]): unknown =>
  bs.map((b) => ({ t: b.type, s: b.size, p: b.props, slots: b.slots ? Object.fromEntries(Object.entries(b.slots).map(([k, v]) => [k, strip(v)])) : undefined }));
const shape = (s: State) => ({
  meta: s.meta,
  layout: s.doc.layout,
  seo: { title: s.doc.seo.title ?? '', description: s.doc.seo.description ?? '', image: s.doc.seo.image ?? '', noindex: s.doc.seo.noindex ?? false },
  blocks: strip(s.doc.blocks),
});

const cat = blockCatalog();
const ex = (t: string) => clone(cat.find((c) => c.type === t)!.example) as Record<string, unknown>;
function fresh(): State {
  const s: State = { doc: { version: 1, layout: 'default', seo: {}, blocks: [] }, meta: { title: 'T', description: 'D', slug: 'tee' } };
  apply(s, [
    { op: 'insert', block: { type: 'hero', props: ex('hero') } },
    { op: 'insert', block: { type: 'feature-grid', props: ex('feature-grid') } },
    { op: 'insert', block: { type: 'columns', props: {} } },
    { op: 'insert', block: { type: 'cta', props: ex('cta') } },
  ]);
  const col = s.doc.blocks[2].id;
  apply(s, [
    { op: 'insert', block: { type: 'faq', props: ex('faq') }, parentId: col, slot: 'left' },
    { op: 'insert', block: { type: 'image', props: ex('image') }, parentId: col, slot: 'right' },
  ]);
  return s;
}

const ids = (s: State) => ({ hero: s.doc.blocks[0].id, grid: s.doc.blocks[1].id, col: s.doc.blocks[2].id, cta: s.doc.blocks[3].id, faq: s.doc.blocks[2].slots!.left[0].id });
const scenarios: [string, (i: ReturnType<typeof ids>) => PageOp[]][] = [
  ['move top-level', (i) => [{ op: 'move', id: i.cta, index: 0 }]],
  ['move out of slot', (i) => [{ op: 'move', id: i.faq, index: 1 }]],
  ['move into slot', (i) => [{ op: 'move', id: i.hero, index: 0, parentId: i.col, slot: 'right' }]],
  ['update props+size', (i) => [{ op: 'update', id: i.hero, props: { title: 'X' }, size: 'small' }]],
  ['replace_props clears optional', (i) => [{ op: 'replace_props', id: i.hero, props: { title: 'Only' } }]],
  ['remove container with children', (i) => [{ op: 'remove', id: i.col }]],
  ['remove slot child', (i) => [{ op: 'remove', id: i.faq }]],
  ['duplicate', (i) => [{ op: 'duplicate', id: i.grid }]],
  ['insert into slot', (i) => [{ op: 'insert', block: { type: 'rich-text', props: { markdown: 'hi' } }, parentId: i.col, slot: 'left', index: 1 }]],
  ['settings batch', () => [{ op: 'set_meta', title: 'New', slug: 'new-slug' }, { op: 'set_seo', seo: { title: '', description: 'd', image: '', noindex: true } }, { op: 'set_layout', layout: 'landing' }]],
];
for (const [name, mk] of scenarios) {
  check(`undo: ${name}`, () => {
    aliases.clear();
    const s = fresh();
    const before = shape(s);
    undo(s, perform(s, mk(ids(s))));
    return [sameJson(shape(s), before), shape(s)];
  });
}
check('chained undo with aliases', () => {
  aliases.clear();
  const s = fresh();
  const before = shape(s);
  const i = ids(s);
  const e1 = perform(s, [{ op: 'remove', id: i.col }]);
  const e2 = perform(s, [{ op: 'duplicate', id: i.hero }]);
  const e3 = perform(s, [{ op: 'move', id: i.cta, index: 0 }]);
  undo(s, e3);
  undo(s, e2);
  undo(s, e1);
  const e4 = perform(s, [{ op: 'remove', id: aliases.resolve(i.faq) }]);
  undo(s, e4);
  return [sameJson(shape(s), before), shape(s)];
});

for (const item of cat) check(`form round-trip: ${item.type}`, () => {
  const form = buildSchemaForm(item.propsSchema as never, clone(item.example) as Record<string, unknown>, () => {});
  const value = form.value();
  const issues = validate(item.propsSchema as never, value);
  const s = fresh();
  let ok = true;
  let err: unknown;
  try {
    const got = applyOpsToDocument(s.doc as never, s.meta, [{ op: 'insert', block: { type: item.type, props: value } } as never]).doc.blocks.at(-1)!;
    const want = applyOpsToDocument(s.doc as never, s.meta, [{ op: 'insert', block: { type: item.type, props: clone(item.example) } } as never]).doc.blocks.at(-1)!;
    ok = sameJson(got.props, want.props);
    if (!ok) err = { got: got.props, want: want.props };
  } catch (e) {
    ok = false;
    err = e instanceof Error ? `${e.message} ${JSON.stringify((e as { details?: unknown }).details)}` : e;
  }
  return [!issues.length && ok, issues.length ? issues : err];
});
const hero = cat.find((c) => c.type === 'hero')!;
check('optional link omitted when blank', () => {
  const v = buildSchemaForm(hero.propsSchema as never, { title: 'T' }, () => {}).value();
  return [!('primary' in v) && !('eyebrow' in v), v];
});
check('required blank flagged', () => {
  const bad = validate(hero.propsSchema as never, { title: '' });
  return [bad.length === 1 && bad[0].path === 'title', bad];
});
check('nested array issue path', () => {
  const fg = cat.find((c) => c.type === 'feature-grid')!;
  const iss = validate(fg.propsSchema as never, { items: [{ icon: 'bolt', title: '', body: '' }], columns: 3 });
  return [iss.some((x) => x.path === 'items.0.title'), iss];
});

describe('page editor: undo and schema forms', () => {
  for (const [name, fn] of checks) {
    it(name, () => {
      const [ok, extra] = fn();
      expect(ok, JSON.stringify(extra ?? '').slice(0, 600)).toBe(true);
    });
  }
});
