/**
 * Generates an editing form from a block's JSON Schema (zod `toJSONSchema`, io: input) and reads it
 * back as a props object. Optional empty values are omitted so the server applies its defaults.
 */
import type { Issue, JsonSchema } from './api';
import { clone } from './doc';
import { h, uid, type Child } from './dom';

interface Field {
  el: HTMLElement;
  /** Current value; `undefined` means "omit this key". */
  get(): unknown;
}

interface Ctx {
  path: string;
  key: string;
  label: string;
  required: boolean;
  onChange: () => void;
  /** Render an object without its own fieldset (array items, the form root). */
  bare?: boolean;
}

export interface SchemaForm {
  el: HTMLElement;
  value(): Record<string, unknown>;
  showErrors(issues: Issue[]): void;
  clearErrors(): void;
}

const LABELS: Record<string, string> = {
  q: 'Question',
  a: 'Answer',
  href: 'Link URL',
  src: 'Image URL',
  alt: 'Alt text',
  showConverter: 'Show live converter',
  endsAt: 'Ends at',
};
const LONG_TEXT = new Set(['body', 'text', 'markdown', 'content', 'quote', 'a']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const join = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));
const isBlank = (v: unknown): boolean =>
  v === '' || typeof v === 'boolean' || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.values(v).every(isBlank));

export function humanize(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const s = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const singular = (key: string) => humanize(key).replace(/ies$/, 'y').replace(/s$/, '') || 'Item';

function typeOf(s: JsonSchema): string | undefined {
  return Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
}

/** `anyOf` made only of `const` members (e.g. a union of number literals) renders as a select. */
function constOptions(s: JsonSchema): unknown[] | null {
  const members = s.anyOf ?? s.oneOf;
  if (!members?.length || !members.every((m) => 'const' in m)) return null;
  return members.map((m) => m.const);
}

/** Starting value for a newly added array item. */
export function defaultFor(s: JsonSchema): unknown {
  if (s.default !== undefined) return clone(s.default);
  if (s.enum?.length) return s.enum[0];
  const consts = constOptions(s);
  if (consts) return consts[0];
  switch (typeOf(s)) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(s.properties ?? {})) {
        if (s.required?.includes(k) || child.default !== undefined) out[k] = defaultFor(child);
      }
      return out;
    }
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return s.minimum ?? 0;
    default:
      return '';
  }
}

function wrap(ctx: Ctx, control: Node, id: string, hint?: string): HTMLElement {
  return h(
    'div',
    { 'data-path': ctx.path, class: 'space-y-1' },
    h('label', { class: 'label !mb-1', for: id }, ctx.label, ctx.required ? h('span', { class: 'text-danger', 'aria-hidden': 'true' }, ' *') : null),
    control,
    hint ? h('p', { class: 'text-xs text-muted' }, hint) : null,
  );
}

function selectField(options: unknown[], value: unknown, ctx: Ctx, fallback: unknown): Field {
  const id = uid('f');
  const allowEmpty = !ctx.required && fallback === undefined;
  const select = h('select', { id, class: 'input', required: ctx.required });
  if (allowEmpty) select.appendChild(h('option', { value: '' }, '—'));
  const current = value === undefined ? fallback : value;
  options.forEach((opt, i) => select.appendChild(h('option', { value: String(i), selected: opt === current }, humanizeOption(opt))));
  if (allowEmpty && current === undefined) select.value = '';
  return { el: wrap(ctx, select, id), get: () => (select.value === '' ? undefined : options[Number(select.value)]) };
}

function humanizeOption(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dateTimeField(s: JsonSchema, value: unknown, ctx: Ctx): Field {
  const id = uid('f');
  const raw = typeof value === 'string' ? value : '';
  const initial = raw ? toLocalInput(raw) : '';
  const input = h('input', { id, type: 'datetime-local', step: 1, class: 'input', value: initial, required: ctx.required });
  const get = () => {
    const v = input.value;
    if (!v) return ctx.required ? '' : undefined;
    if (v === initial) return raw; // untouched: keep the exact stored value
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  };
  return { el: wrap(ctx, input, id, 'Your local time; stored as UTC.'), get };
}

function stringField(s: JsonSchema, value: unknown, ctx: Ctx): Field {
  if (s.format === 'date-time') return dateTimeField(s, value, ctx);
  const id = uid('f');
  const str = typeof value === 'string' ? value : typeof s.default === 'string' ? s.default : '';
  const long = (s.maxLength ?? 0) > 200 || LONG_TEXT.has(ctx.key);
  const attrs = { id, class: 'input', maxlength: s.maxLength, required: ctx.required && (s.minLength ?? 0) > 0 };
  const control = long
    ? h('textarea', { ...attrs, rows: ctx.key === 'markdown' ? 12 : (s.maxLength ?? 0) > 1000 ? 8 : 3, class: `input ${ctx.key === 'markdown' || ctx.key === 'code' ? 'font-mono text-sm' : ''}` })
    : h('input', { ...attrs, type: 'text' });
  control.value = str;
  return {
    el: wrap(ctx, control, id),
    get: () => (control.value === '' && !ctx.required ? undefined : control.value),
  };
}

function numberField(s: JsonSchema, value: unknown, ctx: Ctx): Field {
  const id = uid('f');
  const int = typeOf(s) === 'integer';
  const current = typeof value === 'number' ? value : typeof s.default === 'number' ? s.default : undefined;
  const input = h('input', { id, type: 'number', inputmode: int ? 'numeric' : 'decimal', class: 'input', min: s.minimum, max: s.maximum, step: int ? 1 : 'any', required: ctx.required });
  input.value = current === undefined ? '' : String(current);
  return {
    el: wrap(ctx, input, id),
    get: () => (input.value.trim() === '' ? undefined : Number(input.value)),
  };
}

function booleanField(s: JsonSchema, value: unknown, ctx: Ctx): Field {
  const id = uid('f');
  const input = h('input', { id, type: 'checkbox', class: 'h-5 w-5 accent-[#05c977]' });
  input.checked = typeof value === 'boolean' ? value : s.default === true;
  const el = h('div', { 'data-path': ctx.path }, h('label', { class: 'flex min-h-[44px] cursor-pointer items-center gap-3 text-sm font-semibold', for: id }, input, ctx.label));
  return { el, get: () => input.checked };
}

function stringListField(s: JsonSchema, value: unknown, ctx: Ctx): Field {
  const id = uid('f');
  const lines = Array.isArray(value) ? value.map(String) : [];
  const area = h('textarea', { id, class: 'input', rows: Math.min(Math.max(lines.length + 1, 3), 10) });
  area.value = lines.join('\n');
  const limits = [s.minItems ? `min ${s.minItems}` : '', s.maxItems ? `max ${s.maxItems}` : ''].filter(Boolean).join(', ');
  return {
    el: wrap(ctx, area, id, `One per line${limits ? ` (${limits})` : ''}.`),
    get: () => {
      const text = area.value.replace(/\s+$/, '');
      if (!text) return ctx.required ? [] : undefined;
      return text.split('\n').map((l) => l.replace(/\r$/, ''));
    },
  };
}

function jsonField(value: unknown, ctx: Ctx): Field {
  const id = uid('f');
  const area = h('textarea', { id, class: 'input font-mono text-sm', rows: 5 });
  area.value = value === undefined ? '' : JSON.stringify(value, null, 2);
  return {
    el: wrap(ctx, area, id, 'JSON value.'),
    get: () => {
      if (!area.value.trim()) return undefined;
      try {
        area.removeAttribute('aria-invalid');
        return JSON.parse(area.value) as unknown;
      } catch {
        area.setAttribute('aria-invalid', 'true');
        return area.value;
      }
    },
  };
}

function iconButton(label: string, glyph: string, act: string, onClick: () => void, disabled = false): HTMLButtonElement {
  return h('button', { type: 'button', class: 'btn btn-ghost btn-sm !min-h-[44px] !min-w-[44px] !px-2', 'aria-label': label, title: label, 'data-act': act, disabled, onclick: onClick }, glyph);
}

function arrayField(s: JsonSchema, value: unknown, ctx: Ctx): Field {
  const itemSchema = s.items ?? {};
  const itemLabel = singular(ctx.key);
  const list = h('div', { class: 'space-y-2' });
  const addBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm w-full !min-h-[44px]' }, `+ Add ${itemLabel.toLowerCase()}`);
  let items: Field[] = [];

  const render = (values: unknown[], focusSel?: string) => {
    list.replaceChildren();
    items = values.map((v, i) => {
      const field = buildField(itemSchema, v, { path: join(ctx.path, i), key: ctx.key, label: `${itemLabel} ${i + 1}`, required: true, onChange: ctx.onChange, bare: true });
      const n = `${itemLabel} ${i + 1}`;
      const header = h(
        'div',
        { class: 'mb-2 flex items-center gap-1' },
        h('p', { class: 'flex-1 text-sm font-semibold text-muted' }, n),
        iconButton(`Move ${n} up`, '↑', 'up', () => mutate((vals) => vals.splice(i - 1, 0, vals.splice(i, 1)[0]), `[data-item="${i - 1}"] [data-act="up"]`), i === 0),
        iconButton(`Move ${n} down`, '↓', 'down', () => mutate((vals) => vals.splice(i + 1, 0, vals.splice(i, 1)[0]), `[data-item="${i + 1}"] [data-act="down"]`), i === values.length - 1),
        iconButton(`Remove ${n}`, '✕', 'remove', () => mutate((vals) => vals.splice(i, 1)), values.length <= (s.minItems ?? 0)),
      );
      list.appendChild(h('div', { class: 'rounded-xl border border-line bg-paper/60 p-3', 'data-item': i, role: 'group', 'aria-label': n }, header, field.el));
      return field;
    });
    addBtn.disabled = s.maxItems !== undefined && values.length >= s.maxItems;
    if (focusSel) {
      const target = list.querySelector<HTMLButtonElement>(focusSel);
      (target && !target.disabled ? target : list.querySelector<HTMLElement>('[data-item] [data-act]:not([disabled])') ?? addBtn).focus();
    }
  };
  const current = () => items.map((f) => f.get() ?? defaultFor(itemSchema));
  const mutate = (fn: (vals: unknown[]) => void, focusSel?: string) => {
    const vals = current();
    fn(vals);
    render(vals, focusSel ?? 'button');
    ctx.onChange();
  };
  addBtn.addEventListener('click', () => {
    const vals = current();
    vals.push(defaultFor(itemSchema));
    render(vals);
    list.querySelector<HTMLElement>(`[data-item="${vals.length - 1}"] input, [data-item="${vals.length - 1}"] textarea, [data-item="${vals.length - 1}"] select`)?.focus();
    ctx.onChange();
  });
  render(Array.isArray(value) ? value : []);

  const el = h('fieldset', { 'data-path': ctx.path, class: 'space-y-2 rounded-xl border border-line p-3' }, h('legend', { class: 'px-1 text-sm font-bold' }, ctx.label), list, addBtn);
  return { el, get: () => (items.length || ctx.required ? items.map((f) => f.get() ?? defaultFor(itemSchema)) : undefined) };
}

function objectField(s: JsonSchema, value: unknown, ctx: Ctx): Field {
  const obj = isObj(value) ? value : {};
  const fields = Object.entries(s.properties ?? {}).map(([key, child]) => {
    const field = buildField(child, obj[key], { path: join(ctx.path, key), key, label: humanize(key), required: !!s.required?.includes(key), onChange: ctx.onChange });
    return { key, field };
  });
  const children: Child[] = fields.map((f) => f.field.el);
  const el = ctx.bare
    ? h('div', { class: 'space-y-3', 'data-path': ctx.path }, ...children)
    : h('fieldset', { class: 'space-y-3 rounded-xl border border-line p-3', 'data-path': ctx.path }, h('legend', { class: 'px-1 text-sm font-bold' }, ctx.label, ctx.required ? '' : ' (optional)'), ...children);
  return {
    el,
    get: () => {
      const out: Record<string, unknown> = {};
      let filled = false;
      for (const { key, field } of fields) {
        const v = field.get();
        if (v === undefined) continue;
        out[key] = v;
        // Blank strings/lists and booleans alone don't make an optional object "filled in".
        if (!isBlank(v)) filled = true;
      }
      return filled || ctx.required ? out : undefined;
    },
  };
}

function buildField(s: JsonSchema, value: unknown, ctx: Ctx): Field {
  if (s.enum?.length) return selectField(s.enum, value, ctx, s.default);
  const consts = constOptions(s);
  if (consts) return selectField(consts, value, ctx, s.default);
  switch (typeOf(s)) {
    case 'string':
      return stringField(s, value, ctx);
    case 'number':
    case 'integer':
      return numberField(s, value, ctx);
    case 'boolean':
      return booleanField(s, value, ctx);
    case 'object':
      return s.properties ? objectField(s, value, ctx) : jsonField(value, ctx);
    case 'array': {
      const item = s.items ?? {};
      if (typeOf(item) === 'string' && !item.enum && !item.format) return stringListField(s, value, ctx);
      return arrayField(s, value, ctx);
    }
    default:
      return jsonField(value, ctx);
  }
}

/** Lightweight client-side check so obviously incomplete forms aren't sent; the server stays authoritative. */
export function validate(s: JsonSchema, value: unknown, path = ''): Issue[] {
  const out: Issue[] = [];
  if (value === undefined) return out;
  if (s.properties && isObj(value)) {
    for (const key of s.required ?? []) if (value[key] === undefined) out.push({ path: join(path, key), message: 'Required' });
    for (const [key, child] of Object.entries(s.properties)) out.push(...validate(child, value[key], join(path, key)));
  } else if (typeof value === 'string') {
    if (s.minLength && value.length < s.minLength) out.push({ path, message: s.minLength === 1 ? 'Required' : `At least ${s.minLength} characters` });
    if (s.maxLength !== undefined && value.length > s.maxLength) out.push({ path, message: `At most ${s.maxLength} characters` });
  } else if (typeof value === 'number') {
    if (Number.isNaN(value)) out.push({ path, message: 'Enter a number' });
    else if (typeOf(s) === 'integer' && !Number.isInteger(value)) out.push({ path, message: 'Enter a whole number' });
    else if (s.minimum !== undefined && value < s.minimum) out.push({ path, message: `Minimum is ${s.minimum}` });
    else if (s.maximum !== undefined && value > s.maximum) out.push({ path, message: `Maximum is ${s.maximum}` });
  } else if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) out.push({ path, message: `Add at least ${s.minItems}` });
    if (s.maxItems !== undefined && value.length > s.maxItems) out.push({ path, message: `At most ${s.maxItems} allowed` });
    if (s.items) value.forEach((v, i) => out.push(...validate(s.items!, v, join(path, i))));
  }
  return out;
}

export function buildSchemaForm(schema: JsonSchema, value: Record<string, unknown>, onChange: () => void): SchemaForm {
  const root = objectField(schema, value, { path: '', key: '', label: '', required: true, onChange, bare: true });
  const errorBox = h('div', { role: 'alert', class: 'hidden rounded-xl border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger' });
  const el = h('div', { class: 'space-y-3' }, errorBox, root.el);
  el.addEventListener('input', onChange);
  el.addEventListener('change', onChange);

  const clearErrors = () => {
    errorBox.classList.add('hidden');
    errorBox.replaceChildren();
    el.querySelectorAll('[data-ed-err]').forEach((n) => n.remove());
    el.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
  };

  const showErrors = (issues: Issue[]) => {
    clearErrors();
    if (!issues.length) return;
    const list = h('ul', { class: 'list-disc pl-4' });
    for (const issue of issues) {
      // Attach to the closest rendered field for the path.
      let path = issue.path;
      let target: HTMLElement | null = null;
      while (!target) {
        target = el.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
        if (target || !path) break;
        path = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
      }
      const label = issue.path ? issue.path.split('.').map((p) => (/^\d+$/.test(p) ? `#${Number(p) + 1}` : humanize(p))).join(' › ') : 'Block';
      list.appendChild(h('li', {}, `${label}: ${issue.message}`));
      if (target && target !== root.el) {
        const errId = uid('err');
        target.appendChild(h('p', { id: errId, 'data-ed-err': true, class: 'text-xs font-semibold text-danger' }, issue.message));
        const control = target.querySelector<HTMLElement>(':scope > input, :scope > textarea, :scope > select, :scope > label > input');
        control?.setAttribute('aria-invalid', 'true');
        control?.setAttribute('aria-describedby', errId);
      }
    }
    errorBox.replaceChildren(h('p', { class: 'font-semibold' }, 'Fix these fields to save:'), list);
    errorBox.classList.remove('hidden');
  };

  return { el, value: () => (root.get() as Record<string, unknown>) ?? {}, showErrors, clearErrors };
}
