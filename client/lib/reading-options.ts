/**
 * Reading option controls (`[data-reading-options]`) in the converter and on the account page:
 * progressive disclosure of bounded fields, the image-analysis dependency on kept images, the live
 * credit estimate, and reading/diffing values for one-time converter overrides.
 */
import { creditEstimateText, DEFAULT_READING_PREFERENCES, READING_LIMITS, type ReadingPreferences } from '../../src/lib/reading-options';
import type { ConversionOptions } from './api';
import { $, $$ } from './dom';

const TOGGLES = ['expandThread', 'includeComments', 'analyzeImages'] as const;
const NUMBERS = ['maxThreadPosts', 'maxComments', 'maxImages', 'maxCredits'] as const;

const field = (root: HTMLElement, name: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
const imagesToggle = (root: HTMLElement) => field(root, 'images') ?? field(root, 'keepImages');

function numberValue(input: HTMLInputElement | null, key: (typeof NUMBERS)[number]): number {
  const n = Number(input?.value);
  const { min, max } = READING_LIMITS[key];
  return Number.isInteger(n) && n >= min && n <= max ? n : DEFAULT_READING_PREFERENCES[key];
}

/** Current values as reading preferences (out-of-range numbers read as the default for the estimate only). */
export function readPreferences(root: HTMLElement): ReadingPreferences {
  const out = { ...DEFAULT_READING_PREFERENCES };
  for (const key of TOGGLES) out[key] = Boolean(field(root, key)?.checked);
  for (const key of NUMBERS) out[key] = numberValue(field(root, key), key);
  out.keepImages = imagesToggle(root)?.checked ?? true;
  return out;
}

export function applyPreferences(root: HTMLElement, prefs: ReadingPreferences): void {
  for (const key of TOGGLES) { const el = field(root, key); if (el) el.checked = prefs[key]; }
  for (const key of NUMBERS) { const el = field(root, key); if (el) el.value = String(prefs[key]); }
  const images = imagesToggle(root);
  if (images) images.checked = prefs.keepImages;
  sync(root);
}

/** Request options for the fields that differ from `initial`: untouched fields follow saved defaults. */
export function changedOptions(initial: ReadingPreferences, current: ReadingPreferences): ConversionOptions {
  const out: ConversionOptions = {};
  for (const key of [...TOGGLES, ...NUMBERS]) if (initial[key] !== current[key]) (out as Record<string, unknown>)[key] = current[key];
  if (initial.keepImages !== current.keepImages) out.removeImages = !current.keepImages;
  return out;
}

/** Disable bounded fields whose toggle is off, and image analysis while images are removed. */
function sync(root: HTMLElement): void {
  const images = imagesToggle(root);
  const analyze = field(root, 'analyzeImages');
  if (images && analyze) {
    if (!images.checked) analyze.checked = false;
    analyze.disabled = !images.checked;
  }
  for (const input of $$<HTMLInputElement>('input[data-requires]', root)) {
    const toggle = field(root, input.dataset.requires ?? '');
    input.disabled = Boolean(toggle && (!toggle.checked || toggle.disabled));
    input.setAttribute('aria-disabled', String(input.disabled));
  }
  const estimate = $('[data-credit-estimate]', root);
  if (estimate) estimate.textContent = creditEstimateText(readPreferences(root));
}

export function initReadingOptions(): void {
  for (const root of $$('[data-reading-options]')) {
    sync(root);
    root.addEventListener('change', () => sync(root));
    root.addEventListener('input', () => sync(root));
  }
}
