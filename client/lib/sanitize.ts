/**
 * DOMParser-based HTML sanitizer for rendered Markdown. DOMParser documents are inert (no script
 * execution, no resource loads), so the tree is cleaned before any node enters the live page.
 *
 * - untrusted (converted pages): allowlisted attributes only, active/embedding elements dropped,
 *   http(s)/mailto/tel links only, external links open in a new tab without referrer.
 * - trusted (admin-authored posts): keeps markup and embeds, but still drops <script>, event
 *   handlers and script URLs.
 */

const DROP_UNTRUSTED = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base',
  'form', 'button', 'textarea', 'select', 'option', 'noscript', 'template', 'svg', 'math', 'portal', 'dialog',
]);
const DROP_TRUSTED = new Set(['script', 'base', 'meta']);

const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'align', 'start', 'reversed', 'lang', 'dir', 'datetime', 'cite', 'type', 'checked', 'disabled', 'open']);
const URL_ATTRS = new Set(['href', 'src', 'cite', 'action', 'formaction', 'poster', 'background', 'xlink:href', 'data']);

function safeUrl(value: string, image: boolean): boolean {
  // Browsers ignore control characters and whitespace inside schemes ("java\tscript:").
  const v = value.replace(/[\x00-\x20\x7f-\x9f]/g, '').toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:/.test(v)) return true; // relative, #fragment or //host
  if (/^(https?|mailto|tel):/.test(v)) return true;
  return image && /^data:image\/(png|jpe?g|gif|webp|avif);/.test(v);
}

export function sanitizeHtml(html: string, trusted = false): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  const body = doc.body;
  const drop = trusted ? DROP_TRUSTED : DROP_UNTRUSTED;

  for (const el of Array.from(body.querySelectorAll('*'))) {
    if (!body.contains(el)) continue; // inside an already removed subtree
    const tag = el.localName;
    if (drop.has(tag) || (!trusted && tag === 'input' && el.getAttribute('type') !== 'checkbox')) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const bad =
        name.startsWith('on') ||
        name === 'srcdoc' ||
        (URL_ATTRS.has(name) && !safeUrl(attr.value, tag === 'img' && name === 'src')) ||
        (!trusted && !ALLOWED_ATTRS.has(name));
      if (bad) el.removeAttribute(attr.name);
    }
    if (tag === 'input') el.setAttribute('disabled', '');
    if (tag === 'img') {
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
      if (!trusted) el.setAttribute('referrerpolicy', 'no-referrer');
    }
    if (tag === 'a' && !trusted && /^(https?:)?\/\//i.test(el.getAttribute('href') ?? '')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow ugc');
    }
  }

  const frag = document.createDocumentFragment();
  frag.append(...Array.from(body.childNodes));
  return frag;
}
