/** Clipboard and "send to AI" helpers. */
import { errorMessage, toast } from './dom';

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

async function writeText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or document not focused: try the legacy path below.
    }
  }
  if (!legacyCopy(text)) throw new Error('Could not copy. Select the text and copy it manually.');
}

/**
 * Copy text and confirm with a toast. Accepts a promise so content fetched after the click
 * (a page's Markdown) still counts as part of the user gesture where ClipboardItem allows it.
 */
export async function copyText(text: string | Promise<string>, done = 'Copied'): Promise<boolean> {
  try {
    if (typeof text === 'string') {
      await writeText(text);
    } else if (navigator.clipboard?.write && typeof ClipboardItem === 'function' && window.isSecureContext) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      } catch {
        await writeText(await text);
      }
    } else {
      await writeText(await text);
    }
    toast(done);
    return true;
  } catch (err) {
    toast(errorMessage(err, 'Could not copy.'));
    return false;
  }
}

const AI_URLS = {
  chatgpt: 'https://chatgpt.com/?q=',
  claude: 'https://claude.ai/new?q=',
  gemini: 'https://gemini.google.com/app?q=',
} as const;

export type AiTarget = keyof typeof AI_URLS;
export const isAiTarget = (v: unknown): v is AiTarget => typeof v === 'string' && Object.prototype.hasOwnProperty.call(AI_URLS, v);

/**
 * Open an AI chat prefilled with `prompt`. `clipboard` (if given) is copied first. Gemini does
 * not reliably honour `?q=`, so its prompt always goes to the clipboard as a fallback.
 */
export function sendToAi(target: AiTarget, prompt: string, clipboard?: string): void {
  const url = AI_URLS[target] + encodeURIComponent(prompt);
  if (clipboard) void copyText(clipboard, 'Markdown copied. Paste it into the chat.');
  else if (target === 'gemini') void copyText(prompt, 'Prompt copied. Paste it if Gemini opens empty.');
  const win = window.open(url, '_blank');
  if (win) win.opener = null;
  else location.assign(url);
}

/** Send a Markdown document: inline when it fits in a URL, otherwise via the clipboard. */
export function sendMarkdownToAi(target: AiTarget, markdown: string, label: string): void {
  const from = label ? ` from ${label}` : '';
  const inline = `Here is a Markdown document${from}:\n\n${markdown}\n\nHelp me with it.`;
  if (encodeURIComponent(inline).length <= 6000) return sendToAi(target, inline);
  sendToAi(target, `I'm pasting a Markdown document${from} below. Help me with it.\n\n`, markdown);
}
