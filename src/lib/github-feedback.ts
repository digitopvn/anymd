/**
 * Publishing feedback to GitHub. Server-side only: the token never leaves this module, and the
 * target repository and label are constants, never read from a request. GitHub does not make issue
 * creation idempotent, so a lost response is reported as `ambiguous` and callers reconcile by the
 * opaque Feedback ID in the issue body instead of posting again.
 */
import type { Env } from '../env';

export const FEEDBACK_REPO = 'digitopvn/anymd';
export const FEEDBACK_LABEL = 'ai-handle';
const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 10_000;
const ISSUE_URL = /^https:\/\/github\.com\/digitopvn\/anymd\/issues\/(\d+)$/;

export function feedbackConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_FEEDBACK_TOKEN);
}

export type PublishResult =
  | { ok: true; number: number; url: string; labeled: boolean }
  /** Definitely not created: safe to try again later. */
  | { ok: false; kind: 'rate_limited'; retryAfter: number }
  | { ok: false; kind: 'misconfigured' | 'invalid' }
  /** The request may or may not have created the issue: reconcile before any retry. */
  | { ok: false; kind: 'ambiguous'; status?: number };

export interface RemoteIssue {
  number: number;
  url: string;
  labeled: boolean;
}

function headers(env: Env): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'anymd.cc-feedback',
    Authorization: `Bearer ${env.GITHUB_FEEDBACK_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

interface IssueJson {
  number?: number;
  html_url?: string;
  body?: string | null;
  pull_request?: unknown;
  labels?: ({ name?: string } | string)[];
}

/** The issue must live at github.com/digitopvn/anymd/issues/<its number>; anything else is not trusted. */
export function validateIssue(json: IssueJson | null | undefined): RemoteIssue | null {
  if (!json || typeof json.number !== 'number' || typeof json.html_url !== 'string') return null;
  const m = ISSUE_URL.exec(json.html_url);
  if (!m || Number(m[1]) !== json.number) return null;
  const labeled = (json.labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === FEEDBACK_LABEL);
  return { number: json.number, url: json.html_url, labeled };
}

function retryAfterSeconds(res: Response): number {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(Math.ceil(header), 3600);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(Math.ceil(reset - Date.now() / 1000), 1), 3600);
  return 60;
}

export async function ensureFeedbackLabel(env: Env, number: number): Promise<boolean> {
  try {
    const res = await fetch(`${API}/repos/${FEEDBACK_REPO}/issues/${number}/labels`, {
      method: 'POST',
      headers: headers(env),
      body: JSON.stringify({ labels: [FEEDBACK_LABEL] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const labels = (await res.json().catch(() => [])) as { name?: string }[];
    return Array.isArray(labels) && labels.some((l) => l?.name === FEEDBACK_LABEL);
  } catch {
    return false;
  }
}

/** Create the issue with exactly one label. The response is validated before it is trusted. */
export async function createFeedbackIssue(env: Env, issue: { title: string; body: string }): Promise<PublishResult> {
  if (!feedbackConfigured(env)) return { ok: false, kind: 'misconfigured' };
  let res: Response;
  try {
    res = await fetch(`${API}/repos/${FEEDBACK_REPO}/issues`, {
      method: 'POST',
      headers: headers(env),
      body: JSON.stringify({ title: issue.title, body: issue.body, labels: [FEEDBACK_LABEL] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: 'ambiguous' };
  }
  if (res.status === 201) {
    const created = validateIssue((await res.json().catch(() => null)) as IssueJson | null);
    // A 201 whose body cannot be trusted still means an issue may exist: never post again blindly.
    if (!created) return { ok: false, kind: 'ambiguous', status: 201 };
    const labeled = created.labeled || (await ensureFeedbackLabel(env, created.number));
    return { ok: true, number: created.number, url: created.url, labeled };
  }
  if (res.status === 429 || (res.status === 403 && (res.headers.has('retry-after') || res.headers.get('x-ratelimit-remaining') === '0'))) {
    return { ok: false, kind: 'rate_limited', retryAfter: retryAfterSeconds(res) };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, kind: 'misconfigured' };
  if (res.status === 422 || res.status === 400) return { ok: false, kind: 'invalid' };
  // 5xx (a gateway can fail after the write) and anything unexpected.
  return { ok: false, kind: 'ambiguous', status: res.status };
}

/** The line the issue body carries so a submission can be found again without trusting a response. */
export function markerLine(feedbackId: string): string {
  return `**Feedback ID:** ${feedbackId}`;
}

function bodyHasMarker(body: string | null | undefined, feedbackId: string): boolean {
  return typeof body === 'string' && body.split('\n').some((line) => line.trim() === markerLine(feedbackId));
}

export type Reconciled = { found: true; issue: RemoteIssue } | { found: false } | { found: 'unknown' };

/**
 * Look for an issue carrying this Feedback ID: every issue since the submission (a strongly
 * consistent listing), then search. `unknown` means GitHub could not be asked, so nothing may be assumed.
 */
export async function findIssueByFeedbackId(env: Env, feedbackId: string, sinceMs: number): Promise<Reconciled> {
  if (!feedbackConfigured(env)) return { found: 'unknown' };
  try {
    // No label filter: the issue may have been created unlabeled. `since` bounds the window to what this submission could have produced.
    const since = new Date(Math.max(sinceMs - 60_000, 0)).toISOString();
    const list = await fetch(`${API}/repos/${FEEDBACK_REPO}/issues?state=all&sort=created&direction=desc&per_page=100&since=${encodeURIComponent(since)}`, { headers: headers(env), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!list.ok) return { found: 'unknown' };
    const items = (await list.json()) as IssueJson[];
    const listing = Array.isArray(items) ? items : [];
    for (const item of listing) {
      if (item.pull_request || !bodyHasMarker(item.body, feedbackId)) continue;
      const issue = validateIssue(item);
      if (issue) return { found: true, issue };
    }
    const q = encodeURIComponent(`repo:${FEEDBACK_REPO} is:issue in:body "${feedbackId}"`);
    const search = await fetch(`${API}/search/issues?q=${q}&per_page=5`, { headers: headers(env), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!search.ok) return { found: 'unknown' };
    const hits = ((await search.json()) as { items?: IssueJson[] }).items ?? [];
    for (const item of hits) {
      if (item.pull_request || !bodyHasMarker(item.body, feedbackId)) continue;
      const issue = validateIssue(item);
      if (issue) return { found: true, issue };
    }
    // The listing is strongly consistent: only a complete one (fewer than a full page) proves absence. Search can lag.
    return listing.length < 100 ? { found: false } : { found: 'unknown' };
  } catch {
    return { found: 'unknown' };
  }
}
