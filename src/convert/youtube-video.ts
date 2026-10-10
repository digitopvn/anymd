/**
 * Background YouTube video download to the anymd CDN. Opt-in through the `downloadVideo` reading
 * preference (off by default). A conversion only creates a job and enqueues it; the queue consumer
 * resolves the lowest-quality MP4 through VidCap (falling back to RapidAPI ytstream), streams it into
 * R2 and charges credits only when the file is stored. Callers poll the job by id (REST, MCP).
 */
import type { Env, Principal } from '../env';
import { ENRICHMENT_CREDITS } from '../billing/plans';
import { ingestPolarUsage } from '../billing/polar';
import { canSpend, recordUsage, type Channel } from '../lib/usage';
import { newId, now } from '../lib/util';
import { parseVideoId } from './youtube';

export interface VideoJobMessage {
  jobId: string;
}

export type VideoJobStatus = 'queued' | 'downloading' | 'ready' | 'failed';

export interface VideoJobRow {
  id: string;
  user_id: string;
  api_key_id: string | null;
  channel: string;
  video_id: string;
  source_url: string;
  status: VideoJobStatus;
  quality: string | null;
  bytes: number | null;
  r2_key: string | null;
  cdn_url: string | null;
  credits: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/** Why no job was started although the preference is on. */
export type VideoSkipReason = 'unavailable' | 'quota_exceeded' | 'internal';

export type VideoDownloadState =
  | { status: 'skipped'; reason: VideoSkipReason; credits: number }
  | { status: VideoJobStatus; id: string; reused: boolean; credits: number; quality: string | null; cdn_url: string | null; error: string | null; check_url: string };

export const VIDCAP_API_BASE = 'https://vidcap.zuey.me/api/v1';
export const YTSTREAM_HOST = 'ytstream-download-youtube-videos.p.rapidapi.com';
/** Larger files fail with `video_too_large` instead of filling R2. */
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
/** A queued or downloading job older than this is treated as lost and a new one may start. */
const STALE_JOB_MS = 60 * 60 * 1000;
/** Queue deliveries per job, including the first; keep in sync with `max_retries` in wrangler.jsonc. */
export const VIDEO_MAX_ATTEMPTS = 3;

export function videoDownloadAvailable(env: Env): boolean {
  return Boolean(env.VIDEO_QUEUE && (env.VIDCAP_API_KEY || env.RAPIDAPI_KEY));
}

export function videoCheckUrl(env: Env, id: string): string {
  return `${env.PUBLIC_URL}/api/v1/videos/${id}`;
}

export function getVideoJob(env: Env, userId: string, id: string): Promise<VideoJobRow | null> {
  return env.DB.prepare('SELECT * FROM video_jobs WHERE id = ? AND user_id = ?').bind(id, userId).first<VideoJobRow>();
}

/** Public shape of a job: what REST and MCP return. */
export function videoJobPayload(env: Env, job: VideoJobRow) {
  return {
    id: job.id,
    status: job.status,
    video_id: job.video_id,
    source_url: job.source_url,
    quality: job.quality,
    bytes: job.bytes,
    cdn_url: job.cdn_url,
    credits: job.credits,
    error: job.error,
    check_url: videoCheckUrl(env, job.id),
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  };
}

function stateOf(env: Env, job: VideoJobRow, reused: boolean): VideoDownloadState {
  return { status: job.status, id: job.id, reused, credits: job.credits, quality: job.quality, cdn_url: job.cdn_url, error: job.error, check_url: videoCheckUrl(env, job.id) };
}

/**
 * Starts (or reuses) the caller's download job for a YouTube URL. A ready or in-flight job for the
 * same video is returned instead of a new one, so repeated reads never pay twice. Never throws:
 * the conversion it belongs to has already succeeded.
 */
export async function startVideoDownload(env: Env, principal: Principal, plan: string, channel: Channel, url: string): Promise<VideoDownloadState | null> {
  const videoId = parseVideoId(url);
  if (!videoId || !principal.userId) return null;
  const userId = principal.userId;
  const cost = ENRICHMENT_CREDITS.videoDownload;
  try {
    const existing = await env.DB.prepare(
      "SELECT * FROM video_jobs WHERE user_id = ? AND video_id = ? AND (status = 'ready' OR (status IN ('queued','downloading') AND updated_at > ?)) ORDER BY created_at DESC LIMIT 1",
    ).bind(userId, videoId, now() - STALE_JOB_MS).first<VideoJobRow>();
    if (existing) return stateOf(env, existing, true);
    if (!videoDownloadAvailable(env)) return { status: 'skipped', reason: 'unavailable', credits: cost };
    if (!(await canSpend(env, userId, plan, cost)).ok) return { status: 'skipped', reason: 'quota_exceeded', credits: cost };
    const ts = now();
    const job: VideoJobRow = {
      id: newId('vid_'), user_id: userId, api_key_id: principal.apiKeyId ?? null, channel, video_id: videoId,
      source_url: `https://www.youtube.com/watch?v=${videoId}`, status: 'queued', quality: null, bytes: null, r2_key: null, cdn_url: null,
      credits: 0, error: null, created_at: ts, updated_at: ts, completed_at: null,
    };
    await env.DB.prepare('INSERT INTO video_jobs (id,user_id,api_key_id,channel,video_id,source_url,status,credits,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(job.id, job.user_id, job.api_key_id, job.channel, job.video_id, job.source_url, job.status, 0, ts, ts).run();
    try {
      await env.VIDEO_QUEUE!.send({ jobId: job.id });
    } catch (err) {
      await failJob(env, job.id, 'queue_unavailable');
      throw err;
    }
    return stateOf(env, job, false);
  } catch (err) {
    console.error('video download start', err);
    return { status: 'skipped', reason: 'internal', credits: cost };
  }
}

/** Markdown appended to the conversion so an agent knows the job id and how to collect the result. */
export function videoDownloadMarkdown(state: VideoDownloadState): string {
  const lines = ['## Video download', ''];
  if (state.status === 'skipped') {
    const why = {
      unavailable: 'video download is not available on this server right now',
      quota_exceeded: `this account does not have the ${state.credits} credits a video download costs`,
      internal: 'the download job could not be started; read the URL again to retry',
    }[state.reason];
    lines.push(`> Video download is on in your settings, but ${why}.`);
    return lines.join('\n');
  }
  if (state.status === 'ready') {
    lines.push(`- Video${state.quality ? ` (${state.quality} MP4)` : ''}: ${state.cdn_url}`, `- Job: \`${state.id}\` (status: \`ready\`)`);
    return lines.join('\n');
  }
  if (state.status === 'failed') {
    lines.push(`- Job: \`${state.id}\` (status: \`failed\`${state.error ? `, error: \`${state.error}\`` : ''}). No credits were charged.`);
    return lines.join('\n');
  }
  lines.push(
    'The lowest-quality MP4 of this video is being downloaded to the anymd CDN in the background.',
    '',
    `- Job: \`${state.id}\` (status: \`${state.status}\`)`,
    `- Check: \`GET ${state.check_url}\` with your API key, or the MCP tool \`get_video_download\` with \`{"id": "${state.id}"}\`.`,
    `- Poll every 15 to 30 seconds until \`status\` is \`ready\` (the MP4 is at \`cdn_url\`) or \`failed\` (see \`error\`). ${ENRICHMENT_CREDITS.videoDownload} credits are charged only when it is ready.`,
  );
  return lines.join('\n');
}

// ─── Queue consumer ───────────────────────────────────────────────────────────

/** A failure that will not go away on retry; the job fails at once. */
export class VideoJobError extends Error {
  constructor(readonly code: string, readonly retryable = false) {
    super(code);
  }
}

export interface StreamFormat {
  itag?: number;
  url?: string;
  mimeType?: string;
  qualityLabel?: string;
  quality?: string;
  height?: number;
  bitrate?: number;
  contentLength?: string | number;
}

/** Height in pixels: providers give `height`, or only a label such as `240p`. */
function heightOf(f: StreamFormat): number {
  return f.height ?? (Number.parseInt(f.qualityLabel ?? '', 10) || Infinity);
}

/**
 * The smallest MP4 that still has sound: streams whose codecs include audio (`mp4a`) win, lowest
 * height first; video-only MP4 streams are the fallback when no muxed MP4 exists.
 */
export function pickLowestFormat(formats: StreamFormat[]): { format: StreamFormat; audio: boolean } | null {
  const mp4 = formats.filter((f) => typeof f?.url === 'string' && /^video\/mp4/i.test(f.mimeType ?? ''));
  const size = (f: StreamFormat) => Number(f.contentLength) || Infinity;
  const order = (a: StreamFormat, b: StreamFormat) => heightOf(a) - heightOf(b) || size(a) - size(b) || (a.bitrate ?? Infinity) - (b.bitrate ?? Infinity);
  const muxed = mp4.filter((f) => /mp4a/i.test(f.mimeType ?? '')).sort(order);
  if (muxed.length) return { format: muxed[0], audio: true };
  const videoOnly = mp4.sort(order);
  return videoOnly.length ? { format: videoOnly[0], audio: false } : null;
}

/** Stream URLs come from the provider, not the caller; only YouTube's media hosts are fetched. */
export function isYoutubeMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname.endsWith('.googlevideo.com') || u.hostname.endsWith('.youtube.com'));
  } catch {
    return false;
  }
}

/** Calls a format provider and maps transport failures to job errors. */
async function providerJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new VideoJobError('provider_timeout', true);
  }
  if (response.status === 401 || response.status === 403) throw new VideoJobError('provider_unavailable');
  if (response.status === 404) throw new VideoJobError('video_not_found');
  if (!response.ok) throw new VideoJobError('provider_error', true);
  return response.json().catch(() => null);
}

interface VideoProvider {
  name: string;
  formats(videoId: string): Promise<StreamFormat[]>;
}

/** Configured providers in order: VidCap first, RapidAPI ytstream as the fallback. */
function videoProviders(env: Env): VideoProvider[] {
  const providers: VideoProvider[] = [];
  const vidcapKey = env.VIDCAP_API_KEY;
  if (vidcapKey) {
    providers.push({
      name: 'vidcap',
      async formats(videoId) {
        const url = `${VIDCAP_API_BASE}/youtube/media?${new URLSearchParams({ url: `https://www.youtube.com/watch?v=${videoId}` })}`;
        const data = (await providerJson(url, { 'X-API-Key': vidcapKey })) as { status?: number; data?: { videoFiles?: StreamFormat[] } } | null;
        if (!data || data.status !== 1) throw new VideoJobError('video_unavailable');
        return data.data?.videoFiles ?? [];
      },
    });
  }
  const rapidKey = env.RAPIDAPI_KEY;
  if (rapidKey) {
    providers.push({
      name: 'ytstream',
      async formats(videoId) {
        const url = `https://${YTSTREAM_HOST}/dl?${new URLSearchParams({ id: videoId })}`;
        const data = (await providerJson(url, { 'X-RapidAPI-Key': rapidKey, 'X-RapidAPI-Host': YTSTREAM_HOST })) as { status?: string; formats?: StreamFormat[]; adaptiveFormats?: StreamFormat[] } | null;
        if (!data || (data.status && data.status !== 'OK')) throw new VideoJobError('video_unavailable');
        return [...(data.formats ?? []), ...(data.adaptiveFormats ?? [])];
      },
    });
  }
  return providers;
}

async function resolveFormat(provider: VideoProvider, videoId: string): Promise<{ format: StreamFormat; audio: boolean }> {
  const picked = pickLowestFormat(await provider.formats(videoId));
  if (!picked) throw new VideoJobError('no_downloadable_format');
  if (!isYoutubeMediaUrl(picked.format.url!)) throw new VideoJobError('invalid_stream_url');
  return picked;
}

/**
 * Tries each provider until one stream is stored. A stream URL is signed for the provider that
 * issued it, so a failed download also moves on to the next provider. When all fail, the error is
 * retryable if any provider failed transiently.
 */
async function downloadVideo(env: Env, videoId: string) {
  const providers = videoProviders(env);
  if (!providers.length) throw new VideoJobError('provider_unavailable');
  const errors: VideoJobError[] = [];
  for (const provider of providers) {
    try {
      const picked = await resolveFormat(provider, videoId);
      return { picked, ...(await storeVideo(env, videoId, picked)) };
    } catch (err) {
      if (!(err instanceof VideoJobError)) throw err;
      console.warn('video provider failed', provider.name, err.code);
      errors.push(err);
    }
  }
  throw errors.find((e) => e.retryable) ?? errors[0];
}

function failJob(env: Env, id: string, code: string) {
  const ts = now();
  return env.DB.prepare("UPDATE video_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('queued','downloading')").bind(code, ts, ts, id).run();
}

/** Copies the chosen stream into R2. Objects are shared per video and format, so a second user reuses the file. */
async function storeVideo(env: Env, videoId: string, picked: { format: StreamFormat; audio: boolean }): Promise<{ key: string; bytes: number }> {
  const key = `videos/youtube/${videoId}/${picked.format.itag ?? 'lowest'}.mp4`;
  const head = await env.MEDIA.head(key);
  if (head) return { key, bytes: head.size };
  const declared = Number(picked.format.contentLength);
  if (declared > MAX_VIDEO_BYTES) throw new VideoJobError('video_too_large');
  let response: Response;
  try {
    response = await fetch(picked.format.url!, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  } catch {
    throw new VideoJobError('download_timeout', true);
  }
  if (!response.ok || !response.body) throw new VideoJobError('download_failed', response.status >= 500 || response.status === 429);
  const length = Number(response.headers.get('content-length')) || declared;
  if (!length) throw new VideoJobError('unknown_video_size');
  if (length > MAX_VIDEO_BYTES) {
    await response.body.cancel();
    throw new VideoJobError('video_too_large');
  }
  // R2 needs a stream of known length; FixedLengthStream also rejects a body that over- or under-runs.
  const sized = new FixedLengthStream(length);
  const [put] = await Promise.all([
    env.MEDIA.put(key, sized.readable, { httpMetadata: { contentType: 'video/mp4', cacheControl: 'public, max-age=31536000, immutable' } }),
    response.body.pipeTo(sized.writable),
  ]);
  return { key, bytes: put?.size ?? length };
}

/**
 * Runs one job delivery. Returns normally when the job reached a final state (ready or failed) or
 * was already final; throws when the delivery should be retried.
 */
export async function processVideoJob(env: Env, jobId: string, attempt: number): Promise<void> {
  const job = await env.DB.prepare('SELECT * FROM video_jobs WHERE id = ?').bind(jobId).first<VideoJobRow>();
  if (!job || job.status === 'ready' || job.status === 'failed') return;
  const started = now();
  await env.DB.prepare("UPDATE video_jobs SET status = 'downloading', updated_at = ? WHERE id = ?").bind(started, jobId).run();
  try {
    const { picked, key, bytes } = await downloadVideo(env, job.video_id);
    const label = picked.format.qualityLabel || picked.format.quality || (picked.format.height ? `${picked.format.height}p` : 'lowest');
    const quality = picked.audio ? label : `${label}, no audio`;
    const cost = ENRICHMENT_CREDITS.videoDownload;
    const ts = now();
    const done = await env.DB.prepare("UPDATE video_jobs SET status = 'ready', quality = ?, bytes = ?, r2_key = ?, cdn_url = ?, credits = ?, error = NULL, updated_at = ?, completed_at = ? WHERE id = ? AND status = 'downloading'")
      .bind(quality, bytes, key, `${env.CDN_URL}/${key}`, cost, ts, ts, jobId).run();
    // Charge exactly once: only the delivery that moved the job to ready records usage.
    if (!done.meta.changes) return;
    const principal: Principal = { kind: job.api_key_id ? 'api_key' : 'session', userId: job.user_id, role: 'user', scopes: [], apiKeyId: job.api_key_id ?? undefined };
    await recordUsage(env, { principal, channel: job.channel as Channel, kind: 'video_download', target: job.source_url, status: 'ok', httpStatus: 200, credits: cost, durationMs: ts - started, bytesOut: bytes, traceId: jobId });
    await ingestPolarUsage(env, job.user_id, cost, 'video_download').catch(() => undefined);
  } catch (err) {
    const e = err instanceof VideoJobError ? err : new VideoJobError('internal', true);
    if (e.retryable && attempt < VIDEO_MAX_ATTEMPTS) {
      await env.DB.prepare("UPDATE video_jobs SET status = 'queued', error = ?, updated_at = ? WHERE id = ? AND status = 'downloading'").bind(e.code, now(), jobId).run();
      throw err;
    }
    if (!(err instanceof VideoJobError)) console.error('video download', jobId, err);
    await failJob(env, jobId, e.code);
  }
}

/** Queue handler: one job per message; failed deliveries are retried by the queue with a delay. */
export async function handleVideoQueue(batch: MessageBatch<VideoJobMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processVideoJob(env, message.body.jobId, message.attempts);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 30 * message.attempts });
    }
  }
}
