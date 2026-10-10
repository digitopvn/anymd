/**
 * Reading option controls shared by the converter's per-request panel and the account's saved
 * defaults. Base conversion and extra-credit enrichment are separate fieldsets; every option that
 * may spend credits carries its price next to it (from `ENRICHMENT_CREDITS`). Bounded numbers
 * are tied to their toggle with `data-requires`; the client disables them while the toggle is
 * off (progressive disclosure). Without JS every field stays usable. The YouTube video download is
 * a saved account setting only, so the converter's per-request panel leaves it out.
 */
import { ENRICHMENT_CREDITS, VIDEO_ANALYSIS_CREDITS } from '../../billing/plans';
import { DEFAULT_READING_PREFERENCES, READING_LIMITS, creditEstimateText, type ReadingLimitKey, type ReadingPreferences } from '../../lib/reading-options';

type ToggleKey = 'expandThread' | 'includeComments' | 'analyzeImages';

/** Field values to render. Bounded numbers may be the raw text a user submitted (re-rendered after a 422). */
export type ReadingFormValues = Omit<ReadingPreferences, ReadingLimitKey> & Record<ReadingLimitKey, number | string>;

const credits = (n: number) => `${n} credit${n === 1 ? '' : 's'}`;

export const READING_HINTS: Record<ToggleKey, string> = {
  expandThread: `+${credits(ENRICHMENT_CREDITS.threadPost)} per additional X thread post`,
  includeComments: `+${credits(ENRICHMENT_CREDITS.commentBatch)} per started batch of ${ENRICHMENT_CREDITS.commentsPerBatch} comments`,
  analyzeImages: `+${credits(ENRICHMENT_CREDITS.image)} per analyzed image`,
};

/**
 * `explicitOff` adds a hidden `name=0` after the checkbox. Browsers omit unticked boxes, and an
 * omitted option follows the saved preference, so without it a no-JS user could not turn a saved
 * enrichment off. The server reads the first value, so a ticked box (`1`) wins over the fallback.
 */
function Toggle({ id, name, checked, label, hint, explicitOff }: { id: string; name: string; checked: boolean; label: string; hint: string; explicitOff: boolean }) {
  return (
    <div class="flex items-start gap-2">
      <input id={id} class="mt-1 size-4 shrink-0 accent-[var(--color-accent)]" type="checkbox" name={name} value="1" checked={checked} aria-describedby={`${id}-hint`} data-reading-toggle={name} />
      {explicitOff ? <input type="hidden" name={name} value="0" /> : null}
      <div class="min-w-0">
        <label for={id} class="font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} class="text-xs text-muted">
          {hint}
        </p>
      </div>
    </div>
  );
}

function Bounded({ id, name, value, label, requires }: { id: string; name: ReadingLimitKey; value: number | string; label: string; requires?: ToggleKey }) {
  const { min, max } = READING_LIMITS[name];
  return (
    <div class={requires ? 'pl-6' : ''}>
      <label for={id} class="text-xs font-semibold">
        {label} <span class="font-normal text-muted">({min}–{max})</span>
      </label>
      <input id={id} class="input mt-1 !min-h-9 w-full max-w-[9rem] !py-1" type="number" inputmode="numeric" name={name} min={min} max={max} step={1} value={String(value)} required data-requires={requires} />
    </div>
  );
}

/** Numbers for the estimate: unparseable text reads as the default (the server rejects it anyway). */
function estimateValues(values: ReadingFormValues): ReadingPreferences {
  const out = { ...values } as ReadingPreferences;
  for (const key of Object.keys(READING_LIMITS) as ReadingLimitKey[]) {
    const n = Number(values[key]);
    out[key] = Number.isFinite(n) && String(values[key]).trim() !== '' ? n : DEFAULT_READING_PREFERENCES[key];
  }
  return out;
}

/**
 * `imagesName` differs by form: the converter submits the URL API's `images=1|0` and sends every
 * toggle explicitly (a one-time override must be able to say "off"); the account form saves
 * `keepImages=1`, where an unticked box already means off.
 */
export function ReadingOptionsFields({ values, idPrefix, imagesName }: { values: ReadingFormValues; idPrefix: string; imagesName: 'images' | 'keepImages' }) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const explicitOff = imagesName === 'images';
  return (
    <div class="grid gap-4" data-reading-options>
      <fieldset class="grid gap-3 rounded-xl border border-line p-3">
        <legend class="px-1 text-sm font-semibold">Base conversion · no extra credits</legend>
        <Toggle id={id('keep-images')} name={imagesName} checked={values.keepImages} label="Keep image/media URLs" hint="Image and media links from the source stay in the Markdown. Included in the base price." explicitOff={explicitOff} />
      </fieldset>
      <fieldset class="grid gap-3 rounded-xl border border-line p-3">
        <legend class="px-1 text-sm font-semibold">Deep reading · may use extra credits, off by default</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="grid gap-2">
            <Toggle id={id('expand-thread')} name="expandThread" checked={values.expandThread} label="Expand X threads" hint={READING_HINTS.expandThread} explicitOff={explicitOff} />
            <Bounded id={id('max-thread-posts')} name="maxThreadPosts" value={values.maxThreadPosts} label="Max thread posts" requires="expandThread" />
          </div>
          <div class="grid gap-2">
            <Toggle id={id('include-comments')} name="includeComments" checked={values.includeComments} label="Include comments & replies" hint={READING_HINTS.includeComments} explicitOff={explicitOff} />
            <Bounded id={id('max-comments')} name="maxComments" value={values.maxComments} label="Max comments" requires="includeComments" />
          </div>
          <div class="grid gap-2">
            <Toggle id={id('analyze-images')} name="analyzeImages" checked={values.analyzeImages} label="Read text & details in images" hint={`${READING_HINTS.analyzeImages}. Needs kept images.`} explicitOff={explicitOff} />
            <Bounded id={id('max-images')} name="maxImages" value={values.maxImages} label="Max analyzed images" requires="analyzeImages" />
          </div>
          <Bounded id={id('max-credits')} name="maxCredits" value={values.maxCredits} label="Max credits per conversion" />
        </div>
      </fieldset>
      {explicitOff ? null : (
        <fieldset class="grid gap-3 rounded-xl border border-line p-3">
          <legend class="px-1 text-sm font-semibold">YouTube video · extra credits, off by default</legend>
          <Toggle
            id={id('download-video')}
            name="downloadVideo"
            checked={values.downloadVideo}
            label="Download YouTube videos to the anymd CDN"
            hint={`+${credits(ENRICHMENT_CREDITS.videoDownload)} per video, charged only when the download is ready. Runs in the background: the read returns a job id to check.`}
            explicitOff={false}
          />
          <Toggle
            id={id('analyze-video')}
            name="analyzeVideo"
            checked={values.analyzeVideo}
            label="Analyze downloaded videos with AI (Gemini 3.8 Flash)"
            hint={`+${credits(VIDEO_ANALYSIS_CREDITS.base)} plus ${credits(VIDEO_ANALYSIS_CREDITS.perMinute)} per started minute of video, charged only when the analysis is ready. Needs video download; videos up to 60 minutes.`}
            explicitOff={false}
          />
        </fieldset>
      )}
      <p class="text-sm" data-credit-estimate aria-live="polite">
        {creditEstimateText(estimateValues(values))}
      </p>
    </div>
  );
}
