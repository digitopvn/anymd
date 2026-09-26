/** Live preview iframe: reloads without losing scroll, and maps clicks on blocks back to the editor. */

const PREVIEW_CSS = `
[data-block-id]{cursor:pointer;transition:outline-color .15s}
[data-block-id]:hover{outline:2px dashed rgba(5,201,119,.55);outline-offset:-2px}
[data-block-id][data-ed-selected]{outline:3px solid #05c977;outline-offset:-3px}
`;

export class Preview {
  private url = '';
  private scrollY = 0;
  private selected: string | null = null;
  private timer = 0;

  constructor(
    private frame: HTMLIFrameElement,
    private onPick: (id: string) => void,
  ) {
    frame.addEventListener('load', () => this.attach());
  }

  /** Navigates to `url` (or reloads it) keeping the current scroll position. */
  load(url: string): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.navigate(url), 120);
  }

  private navigate(url: string): void {
    const win = this.win();
    if (win) this.scrollY = win.scrollY;
    this.url = url;
    // location.replace keeps the editor's own history clean; fall back to src for cross-origin frames.
    try {
      if (win && this.frame.getAttribute('src')) win.location.replace(url);
      else this.frame.src = url;
    } catch {
      this.frame.src = url;
    }
  }

  select(id: string | null, scroll = false): void {
    this.selected = id;
    const doc = this.doc();
    if (!doc) return;
    doc.querySelectorAll('[data-ed-selected]').forEach((n) => n.removeAttribute('data-ed-selected'));
    if (!id) return;
    const el = doc.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.setAttribute('data-ed-selected', '');
    if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  private win(): Window | null {
    try {
      const w = this.frame.contentWindow;
      return w && w.location.href !== 'about:blank' ? w : null;
    } catch {
      return null; // cross-origin
    }
  }

  private doc(): Document | null {
    try {
      return this.frame.contentDocument;
    } catch {
      return null;
    }
  }

  private attach(): void {
    const doc = this.doc();
    const win = this.win();
    if (!doc || !win || !this.url) return;
    const style = doc.createElement('style');
    style.textContent = PREVIEW_CSS;
    doc.head.appendChild(style);
    if (this.scrollY) win.scrollTo(0, this.scrollY);
    this.select(this.selected);
    // Capture phase so block links/buttons don't navigate the preview away.
    doc.addEventListener(
      'click',
      (e) => {
        // Elements from the frame's realm fail `instanceof Element` here, so duck-type instead.
        const t = e.target as Element | null;
        const target = t && typeof t.closest === 'function' ? t : null;
        const block = target?.closest('[data-block-id]');
        if (target?.closest('a, button, form')) e.preventDefault();
        if (!block) return;
        e.preventDefault();
        const id = block.getAttribute('data-block-id');
        if (id) this.onPick(id);
      },
      true,
    );
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
  }
}
