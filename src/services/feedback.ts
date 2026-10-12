/**
 * Product feedback published as a public GitHub issue. One service behind four adapters (Dashboard,
 * REST, MCP, CLI): validation, secret scrubbing, authorization, near-duplicate and rate limits,
 * idempotency, persistence and the publish state machine all live here.
 *
 * States: received → publishing → created, with pending_retry (GitHub said "later", nothing was
 * created), unknown_remote_state (the response was lost, so the issue may exist), needs_review and
 * failed. GitHub issue creation is not idempotent: before any retry after an ambiguous failure the
 * issue is looked up by its Feedback ID, and when GitHub cannot say, nothing is posted again.
 */
import { z } from 'zod';
import type { Env, Principal } from '../env';
import { cleanText, neutralizeMentions, quoteUserText, safePublicUrl, scrubText, type BlockKind, type RedactKind } from '../lib/feedback-scrub';
import { createFeedbackIssue, ensureFeedbackLabel, feedbackConfigured, FEEDBACK_LABEL, FEEDBACK_REPO, findIssueByFeedbackId, markerLine } from '../lib/github-feedback';
import { sha256 } from '../lib/util';

export const FEEDBACK_TYPES = ['bug', 'feature', 'improvement', 'question', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export type FeedbackChannel = 'dashboard' | 'api' | 'mcp' | 'cli';
export type FeedbackStatus = 'created' | 'pending' | 'needs_review' | 'failed';
type DbStatus = 'received' | 'publishing' | 'created' | 'pending_retry' | 'unknown_remote_state' | 'needs_review' | 'failed';

export const FEEDBACK_LIMITS = { title: [10, 160], description: [20, 10000], section: 3000, referenceUrl: 2000, contextPage: 200 } as const;
const LEASE_MS = 60_000;
/** After an ambiguous POST, how long to wait before a lookup that finds nothing allows a new POST. */
const RECONCILE_GRACE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const DEDUPE_WINDOW_MS = 30 * 24 * 3600_000;

const optionalText = z.string().max(FEEDBACK_LIMITS.section).optional();

/** What the user writes; the draft is previewed before it is confirmed. */
export const FeedbackDraftSchema = z.object({
  type: z.enum(FEEDBACK_TYPES),
  title: z.string().trim().min(FEEDBACK_LIMITS.title[0]).max(FEEDBACK_LIMITS.title[1]),
  description: z.string().trim().min(FEEDBACK_LIMITS.description[0]).max(FEEDBACK_LIMITS.description[1]),
  steps_to_reproduce: optionalText,
  expected_behavior: optionalText,
  actual_behavior: optionalText,
  reference_url: z.string().max(FEEDBACK_LIMITS.referenceUrl).optional(),
  context_page: z.string().max(FEEDBACK_LIMITS.contextPage).optional(),
});
export type FeedbackDraft = z.infer<typeof FeedbackDraftSchema>;

export const IDEMPOTENCY_KEY = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits and . _ : - only');

/** A submission: the draft plus explicit public consent and a stable client-generated key. */
export const FeedbackInputSchema = FeedbackDraftSchema.extend({
  confirm_public: z.boolean().refine((v) => v === true, 'confirm_public must be true: the report becomes a public GitHub issue'),
  idempotency_key: IDEMPOTENCY_KEY,
});
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;

export class FeedbackError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export interface FeedbackRecord {
  id: string;
  status: FeedbackStatus;
  type: FeedbackType;
  title: string;
  channel: FeedbackChannel;
  github: { repo: string; number: number; url: string } | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface Row {
  id: string;
  user_id: string;
  type: string;
  title: string;
  sanitized_body: string;
  channel: string;
  idempotency_key: string;
  payload_hash: string;
  content_hash: string;
  status: DbStatus;
  github_issue_number: number | null;
  github_issue_url: string | null;
  attempt_count: number;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  publishing_lease_until: number | null;
  publicly_confirmed_at: number;
}

const publicStatus = (s: DbStatus): FeedbackStatus => (s === 'created' ? 'created' : s === 'needs_review' ? 'needs_review' : s === 'failed' ? 'failed' : 'pending');

export function toRecord(row: Row): FeedbackRecord {
  return {
    id: row.id,
    status: publicStatus(row.status),
    type: row.type as FeedbackType,
    title: row.title,
    channel: row.channel as FeedbackChannel,
    github: row.github_issue_number && row.github_issue_url ? { repo: FEEDBACK_REPO, number: row.github_issue_number, url: row.github_issue_url } : null,
    error: row.last_error_code,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

// ─── Issue construction ─────────────────────────────────────────────────────

/** Opaque and deterministic per account + key, so a preview can show the exact id and a lost row can be reconciled. */
export async function feedbackIdFor(userId: string, idempotencyKey: string): Promise<string> {
  return `fb_${(await sha256(`anymd-feedback:${userId}:${idempotencyKey}`)).slice(0, 20)}`;
}

export interface BuiltIssue {
  title: string;
  body: string;
  label: typeof FEEDBACK_LABEL;
  repo: typeof FEEDBACK_REPO;
  /** Fields holding a high-confidence secret; the submission is refused until the user edits them. */
  blocked: { field: string; kinds: BlockKind[] }[];
  redacted: RedactKind[];
}

const SECTION_LABELS: [keyof FeedbackDraft, string][] = [
  ['steps_to_reproduce', 'Steps to reproduce'],
  ['expected_behavior', 'Expected behavior'],
  ['actual_behavior', 'Actual behavior'],
];

/** Exactly what will be published. Pure: no network, no storage. */
export function buildIssue(draft: FeedbackDraft, meta: { feedbackId: string; channel: FeedbackChannel }): BuiltIssue {
  const blocked: BuiltIssue['blocked'] = [];
  const redacted = new Set<RedactKind>();
  const field = (name: string, value: string | undefined, quote = true): string => {
    const raw = cleanText(value ?? '');
    if (!raw) return '';
    const r = scrubText(raw);
    if (r.blocked.length) blocked.push({ field: name, kinds: r.blocked });
    r.redacted.forEach((k) => redacted.add(k));
    const safe = neutralizeMentions(r.text);
    return quote ? quoteUserText(safe) : safe.replace(/</g, '&lt;');
  };
  const title = field('title', draft.title, false).replace(/\s+/g, ' ');
  const description = field('description', draft.description);
  const parts = [`## Feedback\n\n**Category:** ${draft.type}\n**Source:** ${meta.channel}\n${markerLine(meta.feedbackId)}`, `### Description\n\n${description}`];
  for (const [key, label] of SECTION_LABELS) {
    const text = field(key, draft[key] as string | undefined);
    if (text) parts.push(`### ${label}\n\n${text}`);
  }
  let reference = '';
  if (draft.reference_url?.trim()) {
    reference = safePublicUrl(draft.reference_url) ?? '';
    if (!reference) throw new FeedbackError(422, 'invalid_reference_url', 'reference_url must be a public http(s) URL without credentials.');
  }
  const page = field('context_page', draft.context_page, false).replace(/\s+/g, ' ');
  if (reference || page) parts.push(`### Public reference\n\n${[reference, page ? `Page: ${page}` : ''].filter(Boolean).join('\n')}`);
  parts.push('---\nSubmitted via AnyMD feedback; user confirmed public publication.');
  return { title: `[${draft.type}] ${title}`, body: parts.join('\n\n'), label: FEEDBACK_LABEL, repo: FEEDBACK_REPO, blocked, redacted: [...redacted] };
}

export function assertPublishable(built: BuiltIssue): void {
  if (!built.blocked.length) return;
  throw new FeedbackError(422, 'secret_detected', 'The report looks like it contains a credential, so it was not sent. Remove it and try again; the report would be public.', {
    fields: built.blocked.map((b) => ({ field: b.field, kinds: b.kinds })),
  });
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function hashes(draft: FeedbackDraft): Promise<{ payload: string; content: string }> {
  const fields = [draft.type, draft.title, draft.description, draft.steps_to_reproduce, draft.expected_behavior, draft.actual_behavior, draft.reference_url, draft.context_page].map((v) => cleanText(v ?? ''));
  return { payload: await sha256(JSON.stringify(fields)), content: await sha256(`${squash(draft.title)}|${squash(draft.description)}`) };
}

// ─── Limits and moderation ──────────────────────────────────────────────────

const intEnv = (v: string | undefined, fallback: number) => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

async function countSince(env: Env, userId: string | null, since: number): Promise<number> {
  const row = userId
    ? await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback_submissions WHERE user_id = ? AND created_at > ? AND status != 'failed'").bind(userId, since).first<{ n: number }>()
    : await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback_submissions WHERE created_at > ? AND status != 'failed'").bind(since).first<{ n: number }>();
  return row?.n ?? 0;
}

async function enforceLimits(env: Env, userId: string, at: number): Promise<void> {
  const [minute, day, week, hourAll] = await Promise.all([
    countSince(env, userId, at - 60_000),
    countSince(env, userId, at - 24 * 3600_000),
    countSince(env, userId, at - 7 * 24 * 3600_000),
    countSince(env, null, at - 3600_000),
  ]);
  if (minute >= 1) throw new FeedbackError(429, 'feedback_rate_limited', 'Wait a minute before sending more feedback.', undefined, 60);
  if (day >= intEnv(env.FEEDBACK_DAILY_LIMIT, 3)) throw new FeedbackError(429, 'feedback_rate_limited', 'Daily feedback limit reached. Try again tomorrow.', { window: 'day' }, 3600);
  if (week >= intEnv(env.FEEDBACK_WEEKLY_LIMIT, 10)) throw new FeedbackError(429, 'feedback_rate_limited', 'Weekly feedback limit reached. Try again later.', { window: 'week' }, 3600);
  if (hourAll >= intEnv(env.FEEDBACK_GLOBAL_HOURLY_LIMIT, 60)) throw new FeedbackError(429, 'feedback_busy', 'Feedback intake is busy right now. Try again in a few minutes.', undefined, 600);
}

/** Honest holding pen for submissions that look like abuse; they are never reported as created. */
async function reviewReason(env: Env, userId: string, draft: FeedbackDraft, at: number): Promise<string | null> {
  const text = `${draft.title} ${draft.description} ${draft.steps_to_reproduce ?? ''} ${draft.expected_behavior ?? ''} ${draft.actual_behavior ?? ''}`;
  if ((text.match(/https?:\/\//g) ?? []).length > 5) return 'many_links';
  const words = text.toLowerCase().match(/\p{L}[\p{L}\p{N}']*/gu) ?? [];
  if (words.length >= 30 && new Set(words).size / words.length < 0.2) return 'repetitive';
  const minAge = intEnv(env.FEEDBACK_MIN_ACCOUNT_AGE_HOURS, 0);
  if (minAge) {
    const u = await env.DB.prepare('SELECT created_at FROM users WHERE id = ?').bind(userId).first<{ created_at: number }>();
    if (u && at - u.created_at < minAge * 3600_000) return 'new_account';
  }
  return null;
}

// ─── Persistence ────────────────────────────────────────────────────────────

const byKey = (env: Env, userId: string, key: string) => env.DB.prepare('SELECT * FROM feedback_submissions WHERE user_id = ? AND idempotency_key = ?').bind(userId, key).first<Row>();
const byId = (env: Env, id: string) => env.DB.prepare('SELECT * FROM feedback_submissions WHERE id = ?').bind(id).first<Row>();

async function setState(env: Env, id: string, s: { status: DbStatus; error?: string | null; number?: number; url?: string; leaseUntil?: number | null; updatedAt?: number }): Promise<void> {
  await env.DB.prepare(
    'UPDATE feedback_submissions SET status = ?, last_error_code = ?, github_issue_number = COALESCE(?, github_issue_number), github_issue_url = COALESCE(?, github_issue_url), publishing_lease_until = ?, updated_at = ? WHERE id = ?',
  )
    .bind(s.status, s.error ?? null, s.number ?? null, s.url ?? null, s.leaseUntil ?? null, s.updatedAt ?? Date.now(), id)
    .run();
}

/** Compare-and-set claim: only one concurrent caller moves a row into `publishing`. */
async function claim(env: Env, row: Row, bumpAttempt: boolean): Promise<boolean> {
  const at = Date.now();
  const r = await env.DB.prepare(
    "UPDATE feedback_submissions SET status = 'publishing', publishing_lease_until = ?, attempt_count = attempt_count + ?, updated_at = ? WHERE id = ? AND status = ? AND updated_at = ? AND (status != 'publishing' OR publishing_lease_until < ?)",
  )
    .bind(at + LEASE_MS, bumpAttempt ? 1 : 0, at, row.id, row.status, row.updated_at, at)
    .run();
  return Number(r.meta?.changes ?? 0) === 1;
}

// ─── State machine ──────────────────────────────────────────────────────────

interface Outcome {
  record: FeedbackRecord;
  http: 201 | 202;
  replayed: boolean;
  retryAfter?: number;
}

const outcomeOf = (row: Row, replayed: boolean, retryAfter?: number): Outcome => ({ record: toRecord(row), http: row.status === 'created' ? 201 : 202, replayed, retryAfter });

async function fresh(env: Env, id: string): Promise<Row> {
  const row = await byId(env, id);
  if (!row) throw new FeedbackError(503, 'persistence_failed', 'Feedback state could not be read. Retry with the same idempotency key.', undefined, 30);
  return row;
}

async function markCreated(env: Env, row: Row, issue: { number: number; url: string }, labeled: boolean): Promise<Row> {
  try {
    await setState(env, row.id, { status: labeled ? 'created' : 'needs_review', error: labeled ? null : 'label_missing', number: issue.number, url: issue.url });
  } catch {
    // The issue exists but the row still says `publishing`; a retry with the same key reconciles it.
    throw new FeedbackError(503, 'persistence_failed', 'The report was published but its record could not be saved. Retry with the same idempotency key to finish.', undefined, 30);
  }
  return fresh(env, row.id);
}

/**
 * Look the issue up by Feedback ID and settle the row; allow a new POST only once GitHub has had
 * time to show it. `since` is when the remote state became uncertain (not the claim time, which
 * moves on every attempt and would keep the grace period from ever elapsing).
 */
async function reconcile(env: Env, row: Row, since: number): Promise<Row> {
  const found = await findIssueByFeedbackId(env, row.id, row.created_at);
  if (found.found === true) {
    const labeled = found.issue.labeled || (await ensureFeedbackLabel(env, found.issue.number));
    return markCreated(env, row, found.issue, labeled);
  }
  if (found.found === false && Date.now() - since >= RECONCILE_GRACE_MS) {
    await setState(env, row.id, { status: 'pending_retry', error: 'not_found_on_github', leaseUntil: Date.now() });
  } else {
    // Keep the original timestamp so repeated lookups do not restart the grace period.
    await setState(env, row.id, { status: 'unknown_remote_state', error: 'unconfirmed_remote_state', updatedAt: since });
  }
  return fresh(env, row.id);
}

function backoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(attempt - 1, 0), 3600_000);
}

async function publish(env: Env, row: Row): Promise<Row> {
  if (!(await claim(env, row, true))) return fresh(env, row.id); // someone else holds it
  const claimed = await fresh(env, row.id);
  if (claimed.attempt_count > MAX_ATTEMPTS) {
    await setState(env, row.id, { status: 'failed', error: 'max_attempts' });
    return fresh(env, row.id);
  }
  const r = await createFeedbackIssue(env, { title: row.title, body: row.sanitized_body });
  if (r.ok) return markCreated(env, claimed, r, r.labeled);
  switch (r.kind) {
    case 'rate_limited':
      await setState(env, row.id, { status: 'pending_retry', error: 'github_rate_limited', leaseUntil: Date.now() + r.retryAfter * 1000 });
      break;
    case 'misconfigured':
      await setState(env, row.id, { status: 'failed', error: 'integration_misconfigured' });
      break;
    case 'invalid':
      await setState(env, row.id, { status: 'failed', error: 'upstream_invalid_request' });
      break;
    case 'ambiguous':
      await setState(env, row.id, { status: 'unknown_remote_state', error: 'unconfirmed_remote_state' });
      return reconcile(env, await fresh(env, row.id), Date.now());
  }
  return fresh(env, row.id);
}

/** Move a stored row forward as far as it safely can go, whatever state it is in. */
async function advance(env: Env, row: Row): Promise<Row> {
  const at = Date.now();
  switch (row.status) {
    case 'created':
    case 'needs_review':
      return row;
    case 'received':
      return publish(env, row);
    case 'pending_retry':
      return (row.publishing_lease_until ?? 0) <= at ? publish(env, row) : row;
    case 'publishing':
      if ((row.publishing_lease_until ?? 0) >= at) return row; // another request is publishing it
      if (!(await claim(env, row, false))) return fresh(env, row.id);
      return reconcile(env, await fresh(env, row.id), row.updated_at);
    case 'unknown_remote_state':
      if (!(await claim(env, row, false))) return fresh(env, row.id);
      return reconcile(env, await fresh(env, row.id), row.updated_at);
    case 'failed':
      // Only an integration problem that may have been fixed is worth another try.
      if (row.last_error_code === 'integration_misconfigured' && feedbackConfigured(env) && row.attempt_count <= MAX_ATTEMPTS) {
        await setState(env, row.id, { status: 'pending_retry', error: row.last_error_code, leaseUntil: at });
        return publish(env, await fresh(env, row.id));
      }
      return row;
  }
}

function failureFor(row: Row): FeedbackError | null {
  if (row.status !== 'failed') return null;
  switch (row.last_error_code) {
    case 'integration_misconfigured':
      return new FeedbackError(503, 'integration_misconfigured', 'Feedback publishing is not configured correctly right now. Nothing was published; try again later.', undefined, 300);
    case 'upstream_invalid_request':
      return new FeedbackError(502, 'upstream_invalid_request', 'GitHub rejected the report. Nothing was published.');
    default:
      return new FeedbackError(502, row.last_error_code ?? 'publish_failed', 'The report could not be published after several attempts.');
  }
}

function settle(row: Row, replayed: boolean): Outcome {
  const failure = failureFor(row);
  if (failure) throw failure;
  const retryAfter = row.status === 'pending_retry' ? Math.max(Math.ceil(((row.publishing_lease_until ?? 0) - Date.now()) / 1000), 30) : row.status === 'created' || row.status === 'needs_review' ? undefined : 30;
  return outcomeOf(row, replayed, retryAfter);
}

// ─── Public API ─────────────────────────────────────────────────────────────

function requireWriter(principal: Principal): string {
  if (!principal.userId) throw new FeedbackError(401, 'unauthorized', 'Sign in to send feedback.');
  if (!principal.scopes.includes('feedback:write')) throw new FeedbackError(403, 'forbidden', 'Missing scope: feedback:write', { required: ['feedback:write'] });
  return principal.userId;
}

/** The exact issue for a draft, without storing or publishing anything. */
export async function previewFeedback(principal: Principal, draft: FeedbackDraft, channel: FeedbackChannel, idempotencyKey?: string): Promise<BuiltIssue & { feedback_id: string | null }> {
  const userId = requireWriter(principal);
  const id = idempotencyKey ? await feedbackIdFor(userId, idempotencyKey) : null;
  const built = buildIssue(draft, { feedbackId: id ?? 'fb_<assigned on submit>', channel });
  return { ...built, feedback_id: id };
}

export async function submitFeedback(env: Env, principal: Principal, input: FeedbackInput, channel: FeedbackChannel): Promise<Outcome> {
  const userId = requireWriter(principal);
  const h = await hashes(input);

  // A replay returns what was stored, whatever the integration or the scrub rules look like today.
  const existing = await byKey(env, userId, input.idempotency_key);
  if (existing) {
    if (existing.payload_hash !== h.payload) throw new FeedbackError(409, 'idempotency_conflict', 'This idempotency key was already used with different content. Use a new key for a new report.');
    return settle(await advance(env, existing), true);
  }

  if (!feedbackConfigured(env)) throw new FeedbackError(503, 'feedback_unavailable', 'Feedback publishing is not available on this deployment. Nothing was sent.', undefined, 300);
  const id = await feedbackIdFor(userId, input.idempotency_key);
  const built = buildIssue(input, { feedbackId: id, channel });
  assertPublishable(built);

  const at = Date.now();
  const dup = await env.DB.prepare("SELECT * FROM feedback_submissions WHERE content_hash = ? AND status NOT IN ('failed') AND created_at > ? ORDER BY created_at DESC LIMIT 1").bind(h.content, at - DEDUPE_WINDOW_MS).first<Row>();
  if (dup) {
    const own = dup.user_id === userId;
    throw new FeedbackError(409, 'duplicate_feedback', own ? 'You already sent this report. Use its existing record instead of sending it again.' : 'Someone already reported this. Add your details to the existing issue instead.', {
      ...(own ? { id: dup.id } : {}),
      ...(dup.status === 'created' && dup.github_issue_url ? { github: { repo: FEEDBACK_REPO, number: dup.github_issue_number, url: dup.github_issue_url } } : {}),
    });
  }

  await enforceLimits(env, userId, at);
  const hold = await reviewReason(env, userId, input, at);

  // The limits are re-checked inside the insert itself, so parallel requests cannot all pass a stale count.
  const count = "(SELECT COUNT(*) FROM feedback_submissions WHERE created_at > ? AND status != 'failed'";
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO feedback_submissions (id, user_id, type, title, sanitized_body, channel, idempotency_key, payload_hash, content_hash, status, last_error_code, created_at, updated_at, publicly_confirmed_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
     WHERE ${count} AND user_id = ?) < 1 AND ${count} AND user_id = ?) < ? AND ${count} AND user_id = ?) < ? AND ${count}) < ?`,
  )
    .bind(
      id, userId, input.type, built.title, built.body, channel, input.idempotency_key, h.payload, h.content, hold ? 'needs_review' : 'received', hold, at, at, at,
      at - 60_000, userId, at - 24 * 3600_000, userId, intEnv(env.FEEDBACK_DAILY_LIMIT, 3), at - 7 * 24 * 3600_000, userId, intEnv(env.FEEDBACK_WEEKLY_LIMIT, 10), at - 3600_000, intEnv(env.FEEDBACK_GLOBAL_HOURLY_LIMIT, 60),
    )
    .run();
  const stored = await byKey(env, userId, input.idempotency_key);
  if (!stored) {
    // Nothing was written: either a limit was reached by a concurrent request, or storage failed.
    await enforceLimits(env, userId, Date.now());
    throw new FeedbackError(429, 'feedback_rate_limited', 'Too many reports at once. Try again in a minute.', undefined, 60);
  }
  if (Number(insert.meta?.changes ?? 0) === 0) {
    // A concurrent request with the same key won the insert: it publishes, this one only reports.
    if (stored.payload_hash !== h.payload) throw new FeedbackError(409, 'idempotency_conflict', 'This idempotency key was already used with different content. Use a new key for a new report.');
    return settle(await advance(env, stored), true);
  }
  if (hold) return outcomeOf(stored, false);
  return settle(await advance(env, stored), false);
}

export async function listFeedback(env: Env, userId: string, opts: { limit?: number; before?: number } = {}): Promise<{ items: FeedbackRecord[]; next_cursor: number | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const { results } = await env.DB.prepare('SELECT * FROM feedback_submissions WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?')
    .bind(userId, opts.before ?? Number.MAX_SAFE_INTEGER, limit + 1)
    .all<Row>();
  const page = results.slice(0, limit);
  return { items: page.map(toRecord), next_cursor: results.length > limit ? page[page.length - 1].created_at : null };
}

/** One of the caller's own submissions; anyone else's is "not found". */
export async function getFeedback(env: Env, userId: string, id: string): Promise<FeedbackRecord> {
  const row = await env.DB.prepare('SELECT * FROM feedback_submissions WHERE id = ? AND user_id = ?').bind(id, userId).first<Row>();
  if (!row) throw new FeedbackError(404, 'not_found', 'Feedback not found');
  return toRecord(row);
}

/** Scheduled retry: settle rows that are waiting for GitHub, a lease to expire or a lookup. */
export async function processPendingFeedback(env: Env, limit = 10): Promise<number> {
  if (!feedbackConfigured(env)) return 0;
  const at = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT * FROM feedback_submissions WHERE (status = 'pending_retry' AND COALESCE(publishing_lease_until, 0) <= ?1) OR (status = 'publishing' AND COALESCE(publishing_lease_until, 0) < ?1) OR (status = 'unknown_remote_state' AND updated_at < ?2) OR (status = 'received' AND updated_at < ?2) OR (status = 'failed' AND last_error_code = 'integration_misconfigured' AND updated_at < ?2 AND attempt_count <= ?3) ORDER BY updated_at LIMIT ?4",
  )
    .bind(at, at - 120_000, MAX_ATTEMPTS, limit)
    .all<Row>();
  let settled = 0;
  for (const row of results) {
    try {
      const next = await advance(env, row);
      if (next.status === 'created') settled += 1;
    } catch (err) {
      console.error('feedback retry', row.id, err instanceof FeedbackError ? err.code : 'error');
    }
  }
  return settled;
}
