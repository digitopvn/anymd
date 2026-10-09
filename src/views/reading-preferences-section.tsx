/** Account → Reading defaults: persistent, user-scoped deep reading preferences (plain form POST). */
import type { StoredReadingPreferences } from '../convert/reading-preferences';
import { humanDate } from '../lib/util';
import { ReadingOptionsFields } from './components/reading-options-fields';

export function ReadingPreferencesSection({ stored, notice, error }: { stored: StoredReadingPreferences; notice?: string; error?: string }) {
  return (
    <section id="reading-defaults" class="card mt-4 scroll-mt-24 p-5" aria-labelledby="reading-defaults-title">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="reading-defaults-title" class="font-bold">
          Deep reading defaults
        </h2>
        <p class="text-xs text-muted">{stored.saved && stored.updatedAt ? `Saved ${humanDate(stored.updatedAt)}` : 'Using the safe defaults'}</p>
      </div>
      <p class="mt-1 max-w-3xl text-sm text-muted">
        Deep reading can fetch thread posts, comments and image content. These options may use additional credits. They are off by default and only run when you enable them. Your
        defaults apply to the web converter, URL API, REST, CLI, MCP and WebMCP whenever a request leaves an option out; an option set on the request always wins.{' '}
        <a class="text-link" href="/docs/billing#deep-reading">How deep reading is billed</a>
      </p>
      {notice ? (
        <p class="mt-3 rounded-xl border border-ok-line bg-accent-soft px-4 py-3 text-sm text-accent-ink" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p id="reading-defaults-error" class="mt-3 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <form method="post" action="/dashboard/account/reading" class="mt-4" aria-describedby={error ? 'reading-defaults-error' : undefined}>
        <ReadingOptionsFields values={stored.preferences} idPrefix="account-reading" imagesName="keepImages" />
        <div class="mt-4 flex flex-wrap gap-2">
          <button class="btn btn-dark btn-sm" type="submit" name="action" value="save">
            Save reading defaults
          </button>
          {stored.saved ? (
            <button class="btn btn-ghost btn-sm" type="submit" name="action" value="reset" formnovalidate>
              Reset to safe defaults
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
