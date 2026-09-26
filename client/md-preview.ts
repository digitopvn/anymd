/**
 * Markdown renderer (marked + sanitizer). Registers `window.anymdMarkdown` for other scripts
 * (the converter loads this file on demand) and powers the post editor's Preview tab.
 */
import { Marked } from 'marked';
import type { MarkdownRenderer } from './lib/markdown';
import { sanitizeHtml } from './lib/sanitize';

const marked = new Marked({ gfm: true, breaks: false });

const renderer: MarkdownRenderer = {
  render(markdown, trusted = false) {
    return sanitizeHtml(marked.parse(markdown, { async: false }) as string, trusted);
  },
};

window.anymdMarkdown = renderer;

function initPostEditor(root: HTMLElement): void {
  const source = root.querySelector<HTMLTextAreaElement>('[data-md-source]');
  const preview = root.querySelector<HTMLElement>('[data-md-preview]');
  if (!source || !preview) return;
  let rendered: string | null = null;
  const render = () => {
    if (rendered === source.value) return;
    rendered = source.value;
    try {
      // Admin-authored content: trusted mode keeps embeds but still strips scripts and handlers.
      preview.replaceChildren(source.value.trim() ? renderer.render(source.value, true) : 'Nothing to preview yet.');
    } catch (err) {
      rendered = null;
      preview.textContent = `Preview failed: ${err instanceof Error ? err.message : 'unknown error'}`;
    }
  };
  // site.js announces tab switches; the direct click listener covers the case where it isn't loaded yet.
  root.addEventListener('tabs:change', (e) => {
    if ((e as CustomEvent<{ id?: string }>).detail?.id === 'preview') render();
  });
  root.querySelector('[data-tab="preview"]')?.addEventListener('click', render);
  if (!preview.closest('.hidden')) render();
}

function boot(): void {
  document.querySelectorAll<HTMLElement>('[data-post-editor]').forEach(initPostEditor);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
