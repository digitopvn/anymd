/** Dashboard and admin enhancements: confirmations, library document actions, new API key. */
import { request } from './lib/api';
import { copyText, isAiTarget, sendMarkdownToAi } from './lib/clipboard';
import { $, closestTarget, errorMessage, toast } from './lib/dom';

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;

function initConfirm(): void {
  // Submit buttons carrying data-confirm (e.g. "Delete" inside the post editor form).
  document.addEventListener(
    'click',
    (e) => {
      const btn = closestTarget(e, 'button[data-confirm], input[data-confirm]');
      if (btn && !confirm(btn.dataset.confirm || 'Are you sure?')) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  // Whole forms carrying data-confirm (revoke key, disconnect app).
  document.addEventListener('submit', (e) => {
    const form = e.target instanceof HTMLFormElement ? e.target : null;
    const message = form?.getAttribute('data-confirm');
    if (message != null && !confirm(message || 'Are you sure?')) e.preventDefault();
  });
}

export function parseTags(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)));
}

function initDocument(root: HTMLElement): void {
  const id = root.dataset.docId;
  if (!id) return;
  const endpoint = `/api/v1/library/${encodeURIComponent(id)}`;
  const title = root.dataset.title ?? '';

  const form = $<HTMLFormElement>('[data-tags-form]', root);
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[name="tags"]');
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const tags = parseTags(input?.value ?? '');
    if (tags.length > MAX_TAGS) return toast(`Use at most ${MAX_TAGS} tags.`);
    if (tags.some((t) => t.length > MAX_TAG_LENGTH)) return toast(`Tags can be at most ${MAX_TAG_LENGTH} characters.`);
    if (button) button.disabled = true;
    try {
      await request(endpoint, { method: 'PATCH', body: { tags } });
      toast(tags.length ? 'Tags saved' : 'Tags cleared');
    } catch (err) {
      toast(errorMessage(err, 'Could not save tags.'));
    } finally {
      if (button) button.disabled = false;
    }
  });

  root.addEventListener('click', async (e) => {
    const btn = closestTarget<HTMLButtonElement>(e, '[data-doc-action]');
    const action = btn?.dataset.docAction;
    if (!btn || !action) return;
    const markdown = $('[data-raw-md]', root)?.textContent ?? '';
    if (action === 'copy') {
      void copyText(markdown, 'Markdown copied');
    } else if (isAiTarget(action)) {
      sendMarkdownToAi(action, markdown, title);
    } else if (action === 'delete') {
      if (!confirm(`Delete “${title || 'this document'}” from your library? This can't be undone.`)) return;
      btn.disabled = true;
      try {
        await request(endpoint, { method: 'DELETE' });
        location.assign('/dashboard/library');
      } catch (err) {
        toast(errorMessage(err, 'Could not delete the document.'));
        btn.disabled = false;
      }
    }
  });
}

function initNewKey(box: HTMLElement): void {
  // The key is shown in a POST response; turning the history entry into a GET means a refresh
  // doesn't resubmit the form and mint a second key.
  try {
    history.replaceState(history.state, '', location.href);
  } catch {
    // History API unavailable: the browser's resubmit prompt still guards the refresh.
  }
  const code = box.querySelector('code');
  code?.addEventListener('click', () => {
    const selection = getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  box.querySelector<HTMLElement>('[data-copy]')?.focus();
}

/** Social search time filter: custom dates use the browser's time zone, and the date fields show only for "Custom range". */
function initSocialFilters(period: HTMLSelectElement): void {
  const form = period.form;
  if (!form) return;
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    // Without Intl the server reads custom dates as UTC.
  }
  const tz = form.querySelector<HTMLInputElement>('[data-social-tz]');
  const label = form.querySelector<HTMLElement>('[data-social-tz-label]');
  // Dates already filled in were read in the zone the form carries; only an empty range takes the browser's zone.
  const filled = [...form.querySelectorAll<HTMLInputElement>('input[type="date"]')].some((el) => el.value);
  if (zone && tz && !filled) tz.value = zone;
  if (tz && label) label.textContent = tz.value;
  const custom = form.querySelectorAll<HTMLElement>('[data-social-custom]');
  const sync = () => custom.forEach((el) => { el.hidden = period.value !== 'custom'; });
  period.addEventListener('change', sync);
  sync();
}

/** Every social search page costs credits: one submit per click, so a double-click never spends a cursor twice. */
function initSocialForms(): void {
  document.querySelectorAll<HTMLFormElement>('form[data-social-form]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (form.dataset.submitting) return e.preventDefault();
      form.dataset.submitting = '1';
      form.querySelectorAll<HTMLButtonElement>('button[type="submit"]').forEach((b) => b.setAttribute('aria-busy', 'true'));
    });
  });
}

/** Runs on every page; each part only acts when its hooks exist. */
export function initDashboard(): void {
  if ($('[data-confirm]')) initConfirm();
  const doc = $('[data-document]');
  if (doc) initDocument(doc);
  const key = $('[data-new-key]');
  if (key) initNewKey(key);
  const period = $('[data-social-period]');
  if (period instanceof HTMLSelectElement) initSocialFilters(period);
  if ($('[data-social-form]')) initSocialForms();
}
