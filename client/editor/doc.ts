/** Block-tree helpers and undo bookkeeping (inverse ops computed from the pre-change document). */
import type { BlockNode, PageDocument, PageOp, PageSeo } from './api';

export interface Located {
  node: BlockNode;
  list: BlockNode[];
  index: number;
  parentId?: string;
  slot?: string;
}

/** Deep copy of JSON data (structuredClone needs Safari 15.4+; the bundle targets Safari 15). */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function locate(blocks: BlockNode[], id: string, parentId?: string, slot?: string): Located | null {
  for (let i = 0; i < blocks.length; i++) {
    const node = blocks[i];
    if (node.id === id) return { node, list: blocks, index: i, parentId, slot };
    for (const [name, children] of Object.entries(node.slots ?? {})) {
      const found = locate(children, id, node.id, name);
      if (found) return found;
    }
  }
  return null;
}

export function contains(node: BlockNode, id: string): boolean {
  return Object.values(node.slots ?? {}).some((children) => locate(children, id) !== null);
}

export interface Meta {
  title: string;
  description: string;
  slug: string;
}

/** A step of an undo entry: plain ops, or re-creating a removed subtree (new ids are aliased). */
export type UndoStep = { kind: 'ops'; ops: PageOp[] } | { kind: 'restore'; node: BlockNode; index: number; parentId?: string; slot?: string };

export interface UndoEntry {
  label: string;
  steps: UndoStep[];
}

const seoReset = (seo: PageSeo, keys: (keyof PageSeo)[]): PageSeo =>
  Object.fromEntries(keys.map((k) => [k, seo[k] ?? (k === 'noindex' ? false : '')])) as PageSeo;

/**
 * Builds the inverse of a UI-originated batch. Ops in a batch are assumed independent (the editor only
 * batches settings ops, or props + size of one block), so each inverse is computed against `before`.
 */
export function inverseOf(before: PageDocument, meta: Meta, ops: PageOp[], created: string[], label: string): UndoEntry | null {
  const steps: UndoStep[] = [];
  let createdIdx = 0;
  for (const op of ops) {
    switch (op.op) {
      case 'insert':
      case 'duplicate': {
        const id = created[createdIdx++];
        if (id) steps.push({ kind: 'ops', ops: [{ op: 'remove', id }] });
        break;
      }
      case 'update':
      case 'replace_props': {
        const found = locate(before.blocks, op.id);
        if (!found) return null;
        const inv: PageOp[] = [];
        if (op.op === 'replace_props' || op.props) inv.push({ op: 'replace_props', id: op.id, props: clone(found.node.props) });
        if (op.op === 'update' && op.size && op.size !== found.node.size) inv.push({ op: 'update', id: op.id, size: found.node.size });
        if (inv.length) steps.push({ kind: 'ops', ops: inv });
        break;
      }
      case 'move': {
        const found = locate(before.blocks, op.id);
        if (!found) return null;
        steps.push({ kind: 'ops', ops: [{ op: 'move', id: op.id, index: found.index, parentId: found.parentId, slot: found.slot }] });
        break;
      }
      case 'remove': {
        const found = locate(before.blocks, op.id);
        if (!found) return null;
        steps.push({ kind: 'restore', node: clone(found.node), index: found.index, parentId: found.parentId, slot: found.slot });
        break;
      }
      case 'set_seo':
        steps.push({ kind: 'ops', ops: [{ op: 'set_seo', seo: seoReset(before.seo, Object.keys(op.seo) as (keyof PageSeo)[]) }] });
        break;
      case 'set_layout':
        steps.push({ kind: 'ops', ops: [{ op: 'set_layout', layout: before.layout }] });
        break;
      case 'set_meta': {
        const inv: PageOp = { op: 'set_meta' };
        if (op.title !== undefined) inv.title = meta.title;
        if (op.description !== undefined) inv.description = meta.description;
        if (op.slug !== undefined) inv.slug = meta.slug;
        steps.push({ kind: 'ops', ops: [inv] });
        break;
      }
    }
  }
  return steps.length ? { label, steps: steps.reverse() } : null;
}

/** Old id → new id, for blocks re-created by undo. */
export class Aliases {
  private map = new Map<string, string>();

  set(from: string, to: string): void {
    this.map.set(from, to);
  }

  resolve(id: string): string;
  resolve(id: string | undefined): string | undefined;
  resolve(id: string | undefined): string | undefined {
    let cur = id;
    for (let i = 0; cur && this.map.has(cur) && i < 50; i++) cur = this.map.get(cur);
    return cur;
  }

  op(op: PageOp): PageOp {
    const out = { ...op } as PageOp & { id?: string; parentId?: string };
    if ('id' in out && out.id) out.id = this.resolve(out.id);
    if ('parentId' in out && out.parentId) out.parentId = this.resolve(out.parentId);
    return out;
  }

  clear(): void {
    this.map.clear();
  }
}

/** Short human summary of a block for the outline. */
export function summary(node: BlockNode): string {
  const p = node.props;
  for (const key of ['title', 'quote', 'markdown', 'alt', 'code']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  return '';
}

/** Deep equality for JSON data, ignoring object key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, norm(x)]))
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
