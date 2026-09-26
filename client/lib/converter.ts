/** The URL converter island (home page, dashboard, page-builder block). Works as a plain GET form without JS. */
import { ApiFailure, convertUrl, type ConvertPayload } from './api';
import { copyText, isAiTarget, sendMarkdownToAi } from './clipboard';
import { $, $$, closestTarget, reducedMotion, setupTabs } from './dom';
import { loadMarkdownRenderer } from './markdown';

const KIND_LABELS: Record<string, string> = {
  web: 'Web page',
  x: 'X post',
  youtube: 'YouTube',
  github: 'GitHub',
  hackernews: 'Hacker News',
  reddit: 'Reddit',
  pdf: 'PDF',
  image: 'Image',
  document: 'Document',
  text: 'Text',
};

const fmt = new Intl.NumberFormat('en-US');

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function inlineTokens(line: string): string {
  return escapeHtml(line)
    .replace(/`[^`]+`/g, (m) => `<span class="tk-code">${m}</span>`)
    .replace(/\*\*[^*]+\*\*/g, (m) => `<span class="tk-b">${m}</span>`)
    .replace(/!?\[[^\]]*\]\([^)\s]+\)/g, (m) => `<span class="tk-link">${m}</span>`);
}

/** Light Markdown syntax colouring for the raw view. All source text is HTML-escaped first. */
export function highlightMarkdown(md: string): string {
  const lines = md.split('\n');
  let frontmatter = lines[0] === '---';
  let fence = false;
  return lines
    .map((line, i) => {
      if (frontmatter) {
        if (i > 0 && line === '---') frontmatter = false;
        return `<span class="tk-fm">${escapeHtml(line)}</span>`;
      }
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        return `<span class="tk-code">${escapeHtml(line)}</span>`;
      }
      if (fence) return `<span class="tk-code">${escapeHtml(line)}</span>`;
      if (/^#{1,6}\s/.test(line)) return `<span class="tk-h">${escapeHtml(line)}</span>`;
      if (line.startsWith('>')) return `<span class="tk-q">${inlineTokens(line)}</span>`;
      return inlineTokens(line);
    })
    .join('\n');
}

function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function download(d: ConvertPayload): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([d.markdown], { type: 'text/markdown;charset=utf-8' }));
  a.download = `${slugify(d.title || d.domain) || 'anymd'}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function ratio(d: ConvertPayload): string {
  const src = Number(d.source_bytes) || 0;
  const md = new Blob([d.markdown]).size;
  if (!src || !md || src <= md) return '—';
  return `${(src / md).toFixed(src / md >= 10 ? 0 : 1)}×`;
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.className = 'font-semibold underline underline-offset-2';
  return a;
}

function errorNodes(err: unknown): (string | Node)[] {
  const e = err instanceof ApiFailure ? err : new ApiFailure(0, 'unknown', 'Something went wrong. Try again.');
  if (e.code === 'anonymous_limit') return ["You've used today's free conversions. ", link('/signup', 'Create a free account'), ' for 500 credits every month.'];
  if (e.status === 429) {
    const wait = 'Too many conversions in a short time. Wait a minute and try again';
    return e.anonymous ? [`${wait}, or `, link('/signup', 'create a free account'), ' for higher limits.'] : [`${wait}.`];
  }
  if (e.status === 402) return [`${e.message} `, link('/pricing', 'See plans')];
  return [e.message];
}

function initConverter(root: HTMLElement): void {
  const form = $<HTMLFormElement>('[data-converter-form]', root);
  const input = form?.querySelector<HTMLInputElement>('input[name="url"]');
  const submit = $<HTMLButtonElement>('[data-converter-submit]', root);
  const result = $('[data-converter-result]', root);
  const errorBox = $('[data-converter-error]', root);
  if (!form || !input || !submit || !result || !errorBox) return;

  const outputs: Record<string, HTMLElement | null> = {
    md: $('[data-output-md]', root),
    preview: $('[data-output-preview]', root),
    json: $('[data-output-json]', root),
  };
  const submitContent = Array.from(submit.childNodes);
  let current: ConvertPayload | null = null;
  let previewed: ConvertPayload | null = null;
  let busy = false;

  const stat = (name: string, value: string) => {
    const el = $(`[data-stat="${name}"]`, root);
    if (el) el.textContent = value;
  };

  async function renderPreview(): Promise<void> {
    const el = outputs.preview;
    const data = current;
    if (!el || !data || previewed === data) return;
    previewed = data;
    el.textContent = 'Rendering preview…';
    try {
      const renderer = await loadMarkdownRenderer();
      if (current === data) el.replaceChildren(renderer.render(data.content, false));
    } catch (err) {
      previewed = null;
      el.textContent = err instanceof Error ? err.message : 'Preview unavailable.';
    }
  }

  const tabs = $$('[data-view]', root);
  const selectView = setupTabs(tabs, (tab) => {
    const view = tab.dataset.view;
    for (const [name, el] of Object.entries(outputs)) el?.classList.toggle('hidden', name !== view);
    if (view === 'preview') void renderPreview();
  });

  function render(d: ConvertPayload, headers: Headers): void {
    if (outputs.md) outputs.md.innerHTML = highlightMarkdown(d.markdown);
    if (outputs.json) outputs.json.textContent = JSON.stringify(d, null, 2);
    outputs.preview?.replaceChildren();
    const credits = Number(headers.get('X-Anymd-Credits') ?? d.credits) || 0;
    const cached = (headers.get('X-Anymd-Cache') ?? (d.cached ? 'hit' : 'miss')) === 'hit';
    const kind = headers.get('X-Anymd-Kind') || d.kind;
    const ms = d.duration_ms;
    stat('kind', `${KIND_LABELS[kind] ?? kind} · ${credits} credit${credits === 1 ? '' : 's'}`);
    stat('words', fmt.format(d.word_count));
    stat('ratio', ratio(d));
    stat('time', `${ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`}${cached ? ' · cached' : ''}`);
    // Already in the library: no need to pitch saving it.
    $('[data-save-cta]', root)?.classList.toggle('hidden', Boolean(d.document_id));
  }

  const setBusy = (on: boolean): void => {
    busy = on;
    submit.disabled = on;
    root.setAttribute('aria-busy', String(on));
    if (on) submit.textContent = 'Converting…';
    else submit.replaceChildren(...submitContent);
  };

  const showError = (err: unknown): void => {
    errorBox.replaceChildren(...(err ? errorNodes(err) : []));
    errorBox.classList.toggle('hidden', !err);
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (busy) return;
    if (!url) {
      input.focus();
      return;
    }
    setBusy(true);
    showError(null);
    try {
      const { data, headers } = await convertUrl(url);
      current = data;
      previewed = null;
      render(data, headers);
      result.classList.remove('hidden');
      selectView(tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0]);
      result.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    } catch (err) {
      current = null;
      result.classList.add('hidden');
      showError(err);
    } finally {
      setBusy(false);
    }
  });

  for (const btn of $$('[data-example]', root)) {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.example ?? '';
      submit.click();
    });
  }

  root.addEventListener('click', (e) => {
    const action = closestTarget(e, '[data-result-action]')?.dataset.resultAction;
    if (!action || !current) return;
    if (action === 'copy') void copyText(current.markdown, 'Markdown copied');
    else if (action === 'download') download(current);
    else if (isAiTarget(action)) sendMarkdownToAi(action, current.markdown, current.url);
  });
}

export function initConverters(): void {
  $$('[data-converter]').forEach(initConverter);
}
