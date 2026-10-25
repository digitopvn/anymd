/**
 * Incident diagnostics over records anymd already keeps: background video jobs, feedback
 * publication and billing webhooks. Metadata only: no video analysis text, no feedback title or
 * body (untrusted user text), no storage keys, no secret values (configuration is reported as
 * booleans). Read-only: retrying jobs is not exposed here.
 */
import { z } from 'zod';
import type { Env, Principal } from '../../env';
import { now } from '../../lib/util';
import { MAX_WINDOW_DAYS, usageTotals } from './observability';
import { AdminError, assertScope, clampLimit, decodeCursor, encodeCursor, iso, parseInput, Timestamp } from './shared';
import { redactUrls } from './stats';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Optional integrations, reported as configured or not. Values are never read beyond a presence check. */
const CONFIG_KEYS = [
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'CREEM_API_KEY',
  'CREEM_WEBHOOK_SECRET',
  'VIDCAP_API_KEY',
  'RAPIDAPI_KEY',
  'OPENROUTER_API_KEY',
  'TYPESAFE_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_FEEDBACK_TOKEN',
  'RESEND_API_KEY',
  'GITHUB_CLIENT_ID',
  'GOOGLE_CLIENT_ID',
] as const;

const FEEDBACK_PENDING = ['received', 'publishing', 'pending_retry', 'unknown_remote_state'];

export async function getOperationsHealth(env: Env, actor: Principal) {
  assertScope(actor, 'system:read');
  const ts = now();
  const [video, analysis, feedback, webhookFailures, errors1h, errors24h] = await Promise.all([
    env.DB.prepare(
      `SELECT SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN status = 'downloading' THEN 1 ELSE 0 END) AS running,
         MIN(CASE WHEN status IN ('queued','downloading') THEN created_at END) AS oldest_pending,
         SUM(CASE WHEN status = 'failed' AND updated_at >= ?1 THEN 1 ELSE 0 END) AS failed_24h, SUM(CASE WHEN status = 'ready' AND updated_at >= ?1 THEN 1 ELSE 0 END) AS ready_24h
       FROM video_jobs WHERE status IN ('queued','downloading') OR (status IN ('failed','ready') AND updated_at >= ?1)`,
    )
      .bind(ts - DAY)
      .first<{ queued: number | null; running: number | null; oldest_pending: number | null; failed_24h: number | null; ready_24h: number | null }>(),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN analysis_status = 'queued' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN analysis_status = 'running' THEN 1 ELSE 0 END) AS running,
         MIN(CASE WHEN analysis_status IN ('queued','running') THEN updated_at END) AS oldest_pending,
         SUM(CASE WHEN analysis_status = 'failed' AND updated_at >= ?1 THEN 1 ELSE 0 END) AS failed_24h
       FROM video_jobs WHERE analysis_status IN ('queued','running') OR (analysis_status IS NOT NULL AND updated_at >= ?1)`,
    )
      .bind(ts - DAY)
      .first<{ queued: number | null; running: number | null; oldest_pending: number | null; failed_24h: number | null }>(),
    env.DB.prepare(
      `SELECT status, COUNT(*) AS n, MIN(updated_at) AS oldest FROM feedback_submissions
       WHERE status IN (${FEEDBACK_PENDING.map(() => '?').join(',')}) OR (status = 'failed' AND updated_at >= ?) GROUP BY status`,
    )
      .bind(...FEEDBACK_PENDING, ts - DAY)
      .all<{ status: string; n: number; oldest: number }>(),
    env.DB.prepare("SELECT SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS d1, COUNT(*) AS d7 FROM audit_log WHERE action = 'billing.webhook_failed' AND created_at >= ?")
      .bind(ts - DAY, ts - 7 * DAY)
      .first<{ d1: number | null; d7: number }>(),
    usageTotals(env, ts - HOUR),
    usageTotals(env, ts - DAY),
  ]);
  const age = (at: number | null | undefined) => (at ? Math.round((ts - at) / 1000) : null);
  const pendingFeedback = feedback.results.filter((r) => r.status !== 'failed');
  const oldestFeedback = pendingFeedback.length ? Math.min(...pendingFeedback.map((r) => r.oldest)) : null;
  const queueBound = Boolean(env.VIDEO_QUEUE);
  return {
    generated_at: iso(ts),
    environment: env.ENVIRONMENT,
    video_downloads: {
      queued: video?.queued ?? 0,
      downloading: video?.running ?? 0,
      oldest_pending_age_s: age(video?.oldest_pending),
      failed_24h: video?.failed_24h ?? 0,
      ready_24h: video?.ready_24h ?? 0,
      queue_bound: queueBound,
    },
    video_analysis: { queued: analysis?.queued ?? 0, running: analysis?.running ?? 0, oldest_pending_age_s: age(analysis?.oldest_pending), failed_24h: analysis?.failed_24h ?? 0 },
    feedback_publishing: {
      pending: Object.fromEntries(pendingFeedback.map((r) => [r.status, r.n])),
      oldest_pending_age_s: age(oldestFeedback),
      failed_24h: feedback.results.find((r) => r.status === 'failed')?.n ?? 0,
    },
    billing_webhooks: { failures_24h: webhookFailures?.d1 ?? 0, failures_7d: webhookFailures?.d7 ?? 0 },
    requests: { last_1h: errors1h, last_24h: errors24h },
    configuration: Object.fromEntries(CONFIG_KEYS.map((k) => [k, Boolean(env[k])])),
    notes: 'Counts only. Drill down with list_failed_jobs, get_job, list_billing_events and list_system_usage.',
  };
}

// ─── Failed jobs ────────────────────────────────────────────────────────────

export const JOB_TYPES = ['video_download', 'video_analysis', 'feedback'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const FailedJobQuery = z.object({
  type: z.enum(JOB_TYPES).optional().describe('video_download (default), video_analysis or feedback'),
  since: Timestamp.optional().describe('Default: 7 days ago; at most 30 days ago'),
  userId: z.string().max(80).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

interface VideoRow {
  id: string;
  user_id: string;
  channel: string;
  video_id: string;
  status: string;
  quality: string | null;
  bytes: number | null;
  credits: number;
  error: string | null;
  duration_seconds: number | null;
  analysis_status: string | null;
  analysis_credits: number;
  analysis_error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface FeedbackRow {
  id: string;
  user_id: string;
  type: string;
  channel: string;
  status: string;
  attempt_count: number;
  last_error_code: string | null;
  github_issue_number: number | null;
  created_at: number;
  updated_at: number;
}

const VIDEO_COLS = 'id, user_id, channel, video_id, status, quality, bytes, credits, error, duration_seconds, analysis_status, analysis_credits, analysis_error, created_at, updated_at, completed_at';
const FEEDBACK_COLS = 'id, user_id, type, channel, status, attempt_count, last_error_code, github_issue_number, created_at, updated_at';

function videoJob(r: VideoRow) {
  return {
    id: r.id,
    type: 'video_download',
    user_id: r.user_id,
    channel: r.channel,
    video_id: r.video_id,
    status: r.status,
    quality: r.quality,
    bytes: r.bytes,
    duration_seconds: r.duration_seconds,
    credits: r.credits,
    error: redactUrls(r.error?.slice(0, 300) ?? null),
    analysis: r.analysis_status ? { status: r.analysis_status, credits: r.analysis_credits, error: redactUrls(r.analysis_error?.slice(0, 300) ?? null) } : null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    completed_at: iso(r.completed_at),
  };
}

function feedbackJob(r: FeedbackRow) {
  return {
    id: r.id,
    type: 'feedback',
    user_id: r.user_id,
    channel: r.channel,
    feedback_type: r.type,
    status: r.status,
    attempts: r.attempt_count,
    error_code: r.last_error_code,
    github_issue_number: r.github_issue_number,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export async function listFailedJobs(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'system:read');
  const q = parseInput(FailedJobQuery, raw);
  const type: JobType = q.type ?? 'video_download';
  const limit = clampLimit(q.limit, 25, 100);
  const ts = now();
  const oldest = ts - MAX_WINDOW_DAYS * DAY;
  if (q.since !== undefined && q.since < oldest) throw new AdminError(`since must be within the last ${MAX_WINDOW_DAYS} days.`, 422, 'invalid_request', [{ path: 'since', message: `At most ${MAX_WINDOW_DAYS} days ago` }]);
  const statusCol = type === 'video_analysis' ? 'analysis_status' : 'status';
  const parts = [`${statusCol} = 'failed'`, 'updated_at >= ?'];
  const binds: unknown[] = [q.since ?? ts - 7 * DAY];
  if (q.userId) parts.push('user_id = ?'), binds.push(q.userId);
  const cursor = decodeCursor(q.cursor);
  if (cursor) parts.push('(updated_at < ? OR (updated_at = ? AND id < ?))'), binds.push(cursor.ts, cursor.ts, cursor.id);
  const table = type === 'feedback' ? 'feedback_submissions' : 'video_jobs';
  const cols = type === 'feedback' ? FEEDBACK_COLS : VIDEO_COLS;
  const { results } = await env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE ${parts.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<VideoRow & FeedbackRow>();
  const more = results.length > limit;
  const items = more ? results.slice(0, limit) : results;
  const last = items[items.length - 1];
  return {
    type,
    items: items.map((r) => (type === 'feedback' ? feedbackJob(r) : { ...videoJob(r), type })),
    next_cursor: more && last ? encodeCursor(last.updated_at, last.id) : null,
  };
}

/** One background job by id, looked up across video jobs and feedback submissions. */
export async function getJob(env: Env, actor: Principal, jobId: string) {
  assertScope(actor, 'system:read');
  const [video, feedback] = await Promise.all([
    env.DB.prepare(`SELECT ${VIDEO_COLS} FROM video_jobs WHERE id = ?`).bind(jobId).first<VideoRow>(),
    env.DB.prepare(`SELECT ${FEEDBACK_COLS} FROM feedback_submissions WHERE id = ?`).bind(jobId).first<FeedbackRow>(),
  ]);
  if (video) return videoJob(video);
  if (feedback) return feedbackJob(feedback);
  throw new AdminError('Job not found. List failed jobs with list_failed_jobs.', 404, 'not_found');
}
