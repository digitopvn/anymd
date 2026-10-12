/** Dashboard pages for product feedback: compose, review the exact public issue, confirm, and list your own. */
import { FEEDBACK_LIMITS, FEEDBACK_TYPES, type BuiltIssue, type FeedbackRecord } from '../services/feedback';
import { renderMarkdown } from '../lib/markdown';
import { humanDate } from '../lib/util';
import { Icon } from './components/icons';

export interface FeedbackFormValues {
  type: string;
  title: string;
  description: string;
  steps_to_reproduce: string;
  expected_behavior: string;
  actual_behavior: string;
  reference_url: string;
  context_page: string;
  idempotency_key: string;
}

const TYPE_LABELS: Record<string, string> = { bug: 'Bug report', feature: 'Feature request', improvement: 'Improvement', question: 'Question', other: 'Other' };
const STATUS_TEXT: Record<FeedbackRecord['status'], { label: string; cls: string }> = {
  created: { label: 'Published', cls: 'text-accent-ink' },
  pending: { label: 'Queued, not published yet', cls: 'text-muted' },
  needs_review: { label: 'Waiting for review', cls: 'text-muted' },
  failed: { label: 'Failed', cls: 'text-danger' },
};

export function FeedbackTabs({ current }: { current: 'new' | 'mine' }) {
  const tab = (href: string, label: string, on: boolean) => (
    <a href={href} class={`chip ${on ? '!border-ink !bg-ink !text-paper' : ''}`} aria-current={on ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <nav class="mb-4 flex gap-2" aria-label="Feedback">
      {tab('/dashboard/feedback', 'New feedback', current === 'new')}
      {tab('/dashboard/feedback/mine', 'My feedback', current === 'mine')}
    </nav>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: unknown }) {
  return (
    <div>
      <label class="label" for={id}>
        {label}
      </label>
      {children as never}
      {hint ? <p class="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function FeedbackFormPage({ values, preview, reviewed, error }: { values: FeedbackFormValues; preview?: BuiltIssue; reviewed?: string; error?: string }) {
  const sectionHint = `Up to ${FEEDBACK_LIMITS.section} characters.`;
  return (
    <>
      <FeedbackTabs current="new" />
      <div class="mb-4 rounded-xl border border-line bg-card px-4 py-3 text-sm" role="note">
        <strong>This becomes a public GitHub issue.</strong> Anyone can read it, and it stays on GitHub even if you later delete your account. Do not include passwords, API keys, cookies, private URLs or personal data; we scan for them but cannot catch everything. This is about anymd itself; it is not a rating of search results.
      </div>
      {error ? (
        <p class="mb-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <form method="post" action="/dashboard/feedback" class="card space-y-4 p-5" data-feedback-form>
        <input type="hidden" name="idempotency_key" value={values.idempotency_key} />
        <Field id="fb-type" label="Type">
          <select id="fb-type" name="type" class="input" required>
            {FEEDBACK_TYPES.map((t) => (
              <option value={t} selected={values.type === t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fb-title" label="Title" hint={`${FEEDBACK_LIMITS.title[0]}–${FEEDBACK_LIMITS.title[1]} characters.`}>
          <input id="fb-title" name="title" class="input" value={values.title} minlength={FEEDBACK_LIMITS.title[0]} maxlength={FEEDBACK_LIMITS.title[1]} required />
        </Field>
        <Field id="fb-description" label="Description" hint={`${FEEDBACK_LIMITS.description[0]}–${FEEDBACK_LIMITS.description[1]} characters. Markdown is fine.`}>
          <textarea id="fb-description" name="description" class="input min-h-[140px]" minlength={FEEDBACK_LIMITS.description[0]} maxlength={FEEDBACK_LIMITS.description[1]} required>
            {values.description}
          </textarea>
        </Field>
        <details open={Boolean(values.steps_to_reproduce || values.expected_behavior || values.actual_behavior)}>
          <summary class="cursor-pointer text-sm font-semibold">Bug details (optional)</summary>
          <div class="mt-3 space-y-4">
            <Field id="fb-steps" label="Steps to reproduce" hint={sectionHint}>
              <textarea id="fb-steps" name="steps_to_reproduce" class="input min-h-[90px]" maxlength={FEEDBACK_LIMITS.section}>
                {values.steps_to_reproduce}
              </textarea>
            </Field>
            <Field id="fb-expected" label="Expected behavior" hint={sectionHint}>
              <textarea id="fb-expected" name="expected_behavior" class="input min-h-[70px]" maxlength={FEEDBACK_LIMITS.section}>
                {values.expected_behavior}
              </textarea>
            </Field>
            <Field id="fb-actual" label="Actual behavior" hint={sectionHint}>
              <textarea id="fb-actual" name="actual_behavior" class="input min-h-[70px]" maxlength={FEEDBACK_LIMITS.section}>
                {values.actual_behavior}
              </textarea>
            </Field>
          </div>
        </details>
        <div class="grid gap-4 sm:grid-cols-2">
          <Field id="fb-url" label="Public reference URL (optional)" hint="Public http(s) pages only. Query strings and fragments are removed.">
            <input id="fb-url" name="reference_url" type="url" class="input" value={values.reference_url} maxlength={FEEDBACK_LIMITS.referenceUrl} placeholder="https://anymd.cc/dashboard/social" />
          </Field>
          <Field id="fb-page" label="Page (optional)">
            <input id="fb-page" name="context_page" class="input" value={values.context_page} maxlength={FEEDBACK_LIMITS.contextPage} placeholder="/dashboard/social" />
          </Field>
        </div>
        {preview ? (
          <section class="rounded-xl border border-line bg-paper p-4" aria-labelledby="fb-preview-title" data-feedback-preview>
            <h2 id="fb-preview-title" class="font-bold">
              Exactly what will be published
            </h2>
            <p class="mt-1 text-xs text-muted">
              Repository <code>{preview.repo}</code> · label <code>{preview.label}</code> · the Feedback ID is derived from this form and is the same after you publish.
            </p>
            {preview.redacted.length ? <p class="mt-2 text-sm text-muted">Redacted automatically: {preview.redacted.join(', ').replaceAll('_', ' ')}.</p> : null}
            <p class="mt-3 font-semibold">{preview.title}</p>
            <div class="prose-md mt-2 max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.body).html }} />
            <details class="mt-3">
              <summary class="cursor-pointer text-sm font-semibold">Raw Markdown</summary>
              <pre class="md-output mt-2 overflow-x-auto !whitespace-pre-wrap text-[12px]">{preview.body}</pre>
            </details>
            <input type="hidden" name="reviewed" value={reviewed ?? ''} />
            <label class="mt-4 flex cursor-pointer items-start gap-2.5 text-sm">
              <input type="checkbox" name="confirm_public" value="yes" class="mt-0.5 accent-[#05c977]" required />
              <span>I understand this report will be public.</span>
            </label>
          </section>
        ) : null}
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-ghost" type="submit" name="action" value="preview">
            <Icon name="eye" size={16} /> {preview ? 'Update preview' : 'Preview public issue'}
          </button>
          {preview ? (
            <button class="btn btn-dark" type="submit" name="action" value="submit">
              <Icon name="send" size={16} /> Publish on GitHub
            </button>
          ) : null}
        </div>
      </form>
    </>
  );
}

export function FeedbackResultPage({ record }: { record: FeedbackRecord }) {
  const s = STATUS_TEXT[record.status];
  return (
    <>
      <FeedbackTabs current="new" />
      <div class="card p-5" role="status" data-feedback-result={record.status}>
        <p class={`font-bold ${s.cls}`}>{s.label}</p>
        {record.github ? (
          <>
            <p class="mt-1 text-sm text-muted">Your report is public as GitHub issue #{record.github.number}.</p>
            <div class="mt-3 flex flex-col gap-2 sm:flex-row">
              <code class="min-w-0 flex-1 break-all rounded-xl bg-night px-4 py-3 font-mono text-sm text-[#7fe3d6]">{record.github.url}</code>
              <button type="button" class="btn btn-primary" data-copy={record.github.url}>
                <Icon name="copy" size={16} /> Copy
              </button>
              <a class="btn btn-ghost" href={record.github.url} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={16} /> Open
              </a>
            </div>
          </>
        ) : record.status === 'pending' ? (
          <p class="mt-1 text-sm text-muted">GitHub did not confirm it yet, so it is not published. We keep trying automatically; the status here updates when it is.</p>
        ) : record.status === 'needs_review' ? (
          <p class="mt-1 text-sm text-muted">A person will look at this before it is published.</p>
        ) : null}
        {record.status === 'needs_review' && record.github ? <p class="mt-2 text-sm text-muted">The issue exists but could not be labeled automatically; a maintainer will fix that.</p> : null}
        <p class="mt-3 font-mono text-xs text-muted">{record.id}</p>
        <div class="mt-4 flex gap-2">
          <a class="btn btn-ghost btn-sm" href="/dashboard/feedback/mine">
            My feedback
          </a>
          <a class="btn btn-ghost btn-sm" href="/dashboard/feedback">
            Send more
          </a>
        </div>
      </div>
    </>
  );
}

export function MyFeedbackPage({ items, nextCursor }: { items: FeedbackRecord[]; nextCursor: number | null }) {
  return (
    <>
      <FeedbackTabs current="mine" />
      {items.length ? (
        <div class="card divide-y divide-line">
          {items.map((r) => (
            <div class="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between" data-feedback-id={r.id}>
              <div class="min-w-0">
                <p class="truncate font-semibold">{r.title}</p>
                <p class="text-xs text-muted">
                  {humanDate(Date.parse(r.created_at))} · {r.type} · via {r.channel} · <span class={STATUS_TEXT[r.status].cls}>{STATUS_TEXT[r.status].label}</span>
                </p>
              </div>
              {r.github ? (
                <a class="text-sm font-semibold text-accent-ink hover:underline" href={r.github.url} target="_blank" rel="noopener noreferrer">
                  #{r.github.number}
                </a>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div class="card p-6 text-sm text-muted">
          You have not sent any feedback yet. <a class="font-semibold text-accent-ink hover:underline" href="/dashboard/feedback">Send some</a>.
        </div>
      )}
      {nextCursor ? (
        <p class="mt-4">
          <a class="btn btn-ghost btn-sm" href={`/dashboard/feedback/mine?before=${nextCursor}`}>
            Older
          </a>
        </p>
      ) : null}
    </>
  );
}
