/**
 * Bridge to the Markdown renderer in md-preview.js. The renderer bundles `marked`, so pages load
 * it on demand instead of shipping it in site.js.
 */

export interface MarkdownRenderer {
  /** Render Markdown to a sanitized fragment. `trusted` relaxes sanitizing for admin-authored content. */
  render(markdown: string, trusted?: boolean): DocumentFragment;
}

declare global {
  interface Window {
    anymdMarkdown?: MarkdownRenderer;
  }
}

const SRC = '/assets/js/md-preview.js';
let pending: Promise<MarkdownRenderer> | null = null;

export function loadMarkdownRenderer(): Promise<MarkdownRenderer> {
  if (window.anymdMarkdown) return Promise.resolve(window.anymdMarkdown);
  if (pending) return pending;
  pending = new Promise<MarkdownRenderer>((resolve, reject) => {
    const fail = () => reject(new Error('Preview unavailable. Could not load the Markdown renderer.'));
    const timer = window.setTimeout(fail, 15000);
    const done = () => {
      clearTimeout(timer);
      if (window.anymdMarkdown) resolve(window.anymdMarkdown);
      else fail();
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', () => {
      clearTimeout(timer);
      fail();
    }, { once: true });
    if (!existing) {
      script.src = SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  // Allow a retry after a failed load.
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
