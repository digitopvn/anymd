import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBindings, Env, Principal } from '../src/env';
import { ENRICHMENT_CREDITS, videoAnalysisCredits } from '../src/billing/plans';
import { applyPreferencesPatch, normalizeStoredPreferences } from '../src/convert/reading-preferences';
import { runConversion } from '../src/convert/service';
import {
  handleVideoQueue, isYoutubeMediaUrl, MAX_ANALYSIS_SECONDS, pickLowestFormat, processVideoAnalysis, processVideoJob, startVideoDownload, videoDownloadMarkdown,
  VIDEO_ANALYSIS_MODEL, VIDEO_MAX_ATTEMPTS, type VideoJobMessage, type VideoJobRow,
} from '../src/convert/youtube-video';
import { DEFAULT_READING_PREFERENCES } from '../src/lib/reading-options';
import { api } from '../src/routes/api';
import { callTool } from './helpers/mcp-client';
import { createTestEnv, seedUser, type TestEnv } from './helpers/sqlite-env';

const VIDEO = 'dQw4w9WgXcQ';
const STREAM = 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=18';

function fakeQueue() {
  const sent: VideoJobMessage[] = [];
  return { sent, queue: { send: async (m: VideoJobMessage) => void sent.push(m) } as unknown as Queue<VideoJobMessage> };
}

function fakeBucket(existing: Record<string, number> = {}) {
  const objects = new Map(Object.entries(existing));
  return {
    objects,
    bucket: {
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key) } : null),
      put: async (key: string, body: ReadableStream) => {
        const size = (await new Response(body).arrayBuffer()).byteLength;
        objects.set(key, size);
        return { size };
      },
    } as unknown as R2Bucket,
  };
}

const providerBody = {
  status: 'OK',
  formats: [
    { itag: 22, url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=22', mimeType: 'video/mp4; codecs="avc1"', qualityLabel: '720p', height: 720, bitrate: 900_000 },
    { itag: 18, url: STREAM, mimeType: 'video/mp4; codecs="avc1, mp4a"', qualityLabel: '360p', height: 360, bitrate: 500_000, contentLength: '4' },
  ],
  adaptiveFormats: [{ itag: 160, url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=160', mimeType: 'video/mp4', qualityLabel: '144p', height: 144 }],
};

// VidCap lists muxed and video-only streams together and labels quality without a height.
const vidcapBody = {
  status: 1,
  data: {
    videoFiles: [
      { itag: 18, url: STREAM, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', qualityLabel: '240p', contentLength: '4', approxDurationMs: '19063' },
      { itag: 160, url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=160', mimeType: 'video/mp4; codecs="avc1.4D400B"', qualityLabel: '144p', contentLength: '2' },
      { itag: 278, url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=278', mimeType: 'video/webm; codecs="vp9"', qualityLabel: '144p' },
    ],
    audioFiles: [],
  },
};

const modelReply = (content = '## Summary\nA man at the zoo.', finish = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason: finish }], usage: { cost: 0.0042 } });

function stubFetch(provider: () => Response = () => Response.json(providerBody), vidcap: () => Response = () => Response.json(vidcapBody), model: () => Response = () => modelReply()) {
  const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://openrouter.ai/api/v1/chat/completions') return model();
    if (url.startsWith('https://vidcap.zuey.me/api/v1/youtube/media?')) return vidcap();
    if (url.startsWith('https://ytstream-download-youtube-videos.p.rapidapi.com/')) return provider();
    if (url === STREAM) return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-length': '4' } });
    if (url.startsWith('https://www.youtube.com/oembed')) return Response.json({ title: 'A video', author_name: 'Channel', author_url: 'https://www.youtube.com/@c', thumbnail_url: '' });
    return new Response('unexpected', { status: 500 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

let t: TestEnv;
let queue: ReturnType<typeof fakeQueue>;
let media: ReturnType<typeof fakeBucket>;

beforeEach(() => {
  queue = fakeQueue();
  media = fakeBucket();
  t = createTestEnv({ VIDEO_QUEUE: queue.queue, MEDIA: media.bucket, RAPIDAPI_KEY: 'test-key', CDN_URL: 'https://cdn.anymd.test' } as Partial<Env>);
  // Node has no FixedLengthStream; a pass-through stream is enough for the in-memory bucket.
  vi.stubGlobal('FixedLengthStream', class extends TransformStream { constructor(_length: number) { super(); } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  t.close();
});

const principalOf = (id: string): Principal => ({ kind: 'api_key', userId: id, role: 'user', scopes: ['convert', 'library:read', 'library:write'], apiKeyId: 'key_1' });
const job = (id: string) => t.db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id) as VideoJobRow;
const charges = (userId: string) => t.db.prepare("SELECT credits FROM usage_events WHERE user_id = ? AND kind = 'video_download'").all(userId) as { credits: number }[];

describe('format choice', () => {
  it('picks the lowest muxed MP4 (with sound) and falls back to video-only adaptive streams', () => {
    expect(pickLowestFormat([...providerBody.formats, ...providerBody.adaptiveFormats])).toMatchObject({ format: { itag: 18 }, audio: true });
    expect(pickLowestFormat(providerBody.adaptiveFormats)).toMatchObject({ format: { itag: 160 }, audio: false });
    expect(pickLowestFormat(vidcapBody.data.videoFiles)).toMatchObject({ format: { itag: 18 }, audio: true });
    expect(pickLowestFormat(vidcapBody.data.videoFiles.slice(1))).toMatchObject({ format: { itag: 160 }, audio: false });
    expect(pickLowestFormat([{ itag: 1, mimeType: 'video/mp4' }])).toBeNull();
  });

  it('only fetches YouTube media hosts over https', () => {
    expect(isYoutubeMediaUrl(STREAM)).toBe(true);
    expect(isYoutubeMediaUrl('http://rr1.googlevideo.com/x')).toBe(false);
    expect(isYoutubeMediaUrl('https://googlevideo.com.evil.test/x')).toBe(false);
    expect(isYoutubeMediaUrl('https://169.254.169.254/latest')).toBe(false);
  });
});

describe('starting a download', () => {
  it('queues one job per video and reuses it on the next read', async () => {
    const user = await seedUser(t, 'user');
    const first = await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`);
    expect(first).toMatchObject({ status: 'queued', reused: false, check_url: expect.stringContaining('/api/v1/videos/vid_') });
    expect(queue.sent).toHaveLength(1);
    const again = await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://www.youtube.com/watch?v=${VIDEO}`);
    expect(again).toMatchObject({ status: 'queued', reused: true, id: (first as { id: string }).id });
    expect(queue.sent).toHaveLength(1);
  });

  it('is skipped, not failed, without the queue or provider key', async () => {
    const user = await seedUser(t, 'user');
    t.env.VIDEO_QUEUE = undefined;
    expect(await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`)).toMatchObject({ status: 'skipped', reason: 'unavailable' });
  });

  it('tells the agent the job id and how to check it', () => {
    const md = videoDownloadMarkdown({ status: 'queued', id: 'vid_x', reused: false, credits: 0, quality: null, cdn_url: null, error: null, check_url: 'https://anymd.test/api/v1/videos/vid_x', analysis: null });
    expect(md).toMatch('`vid_x`');
    expect(md).toMatch('GET https://anymd.test/api/v1/videos/vid_x');
    expect(md).toMatch('get_video_download');
  });
});

describe('queue consumer', () => {
  it('stores the lowest MP4 on the CDN and charges once when ready', async () => {
    stubFetch();
    const user = await seedUser(t, 'user');
    const state = (await startVideoDownload(t.env, principalOf(user.id), 'free', 'mcp', `https://youtu.be/${VIDEO}`)) as { id: string };
    await processVideoJob(t.env, state.id, 1);
    await processVideoJob(t.env, state.id, 2);
    expect(job(state.id)).toMatchObject({ status: 'ready', quality: '360p', bytes: 4, r2_key: `videos/youtube/${VIDEO}/18.mp4`, cdn_url: `https://cdn.anymd.test/videos/youtube/${VIDEO}/18.mp4`, credits: ENRICHMENT_CREDITS.videoDownload });
    expect(media.objects.get(`videos/youtube/${VIDEO}/18.mp4`)).toBe(4);
    expect(charges(user.id)).toEqual([{ credits: ENRICHMENT_CREDITS.videoDownload }]);
  });

  it('uses VidCap first when its key is set', async () => {
    const fetch = stubFetch(() => new Response('should not be called', { status: 500 }));
    t.env.VIDCAP_API_KEY = 'vidcap-key';
    const user = await seedUser(t, 'user');
    const state = (await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`)) as { id: string };
    await processVideoJob(t.env, state.id, 1);
    expect(job(state.id)).toMatchObject({ status: 'ready', quality: '240p', r2_key: `videos/youtube/${VIDEO}/18.mp4` });
    const called = fetch.mock.calls.map(([u]) => String(u));
    expect(called.some((u) => u.includes('vidcap.zuey.me'))).toBe(true);
    expect(called.some((u) => u.includes('ytstream'))).toBe(false);
    const vidcapCall = fetch.mock.calls.find(([u]) => String(u).includes('vidcap.zuey.me'))!;
    expect(vidcapCall[1]?.headers).toMatchObject({ 'X-API-Key': 'vidcap-key' });
  });

  it('falls back to ytstream when VidCap fails', async () => {
    stubFetch(undefined, () => new Response('down', { status: 502 }));
    t.env.VIDCAP_API_KEY = 'vidcap-key';
    const user = await seedUser(t, 'user');
    const state = (await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`)) as { id: string };
    await processVideoJob(t.env, state.id, 1);
    expect(job(state.id)).toMatchObject({ status: 'ready', quality: '360p', r2_key: `videos/youtube/${VIDEO}/18.mp4` });
    expect(charges(user.id)).toEqual([{ credits: ENRICHMENT_CREDITS.videoDownload }]);
  });

  it('is available with only the VidCap key', async () => {
    t.env.RAPIDAPI_KEY = undefined;
    t.env.VIDCAP_API_KEY = 'vidcap-key';
    const user = await seedUser(t, 'user');
    expect(await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`)).toMatchObject({ status: 'queued' });
  });

  it('fails without charging when the video cannot be downloaded', async () => {
    stubFetch(() => Response.json({ status: 'fail' }));
    const user = await seedUser(t, 'user');
    const state = (await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`)) as { id: string };
    await processVideoJob(t.env, state.id, 1);
    expect(job(state.id)).toMatchObject({ status: 'failed', error: 'video_unavailable', credits: 0 });
    expect(charges(user.id)).toEqual([]);
  });

  it('retries transient provider errors, then fails on the last attempt', async () => {
    stubFetch(() => new Response('busy', { status: 503 }));
    const user = await seedUser(t, 'user');
    const state = (await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`)) as { id: string };
    const message = { body: { jobId: state.id }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await handleVideoQueue({ messages: [message] } as unknown as MessageBatch<VideoJobMessage>, t.env);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(job(state.id)).toMatchObject({ status: 'queued', error: 'provider_error' });
    await processVideoJob(t.env, state.id, VIDEO_MAX_ATTEMPTS);
    expect(job(state.id)).toMatchObject({ status: 'failed', error: 'provider_error' });
  });
});

describe('conversion and status channels', () => {
  it('starts a download from a YouTube read only when the saved setting is on', async () => {
    stubFetch();
    const user = await seedUser(t, 'user');
    const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) };
    const read = () => runConversion(t.env, ctx, { url: `https://www.youtube.com/watch?v=${VIDEO}`, channel: 'api', principal: principalOf(user.id), save: false, fresh: true });
    const off = await read();
    expect(off.videoDownload).toBeNull();
    expect(queue.sent).toHaveLength(0);
    t.db.prepare('INSERT INTO reading_preferences (user_id, preferences, updated_at) VALUES (?,?,?)').run(user.id, JSON.stringify({ downloadVideo: true }), 1);
    const on = await read();
    expect(on.videoDownload).toMatchObject({ status: 'queued' });
    expect(on.markdown).toMatch('## Video download');
    expect(queue.sent).toHaveLength(1);
  });

  it('serves the job to its owner over REST and MCP only', async () => {
    const owner = await seedUser(t, 'user');
    const other = await seedUser(t, 'user');
    const state = (await startVideoDownload(t.env, principalOf(owner.id), 'free', 'api', `https://youtu.be/${VIDEO}`)) as { id: string };
    const get = (p: Principal) => {
      const app = new Hono<AppBindings>();
      app.use('*', async (c, next) => { c.set('principal', p); await next(); });
      app.route('/api/v1', api);
      return app.fetch(new Request(`https://anymd.test/api/v1/videos/${state.id}`), t.env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext);
    };
    const mine = await get(principalOf(owner.id));
    expect(mine.status).toBe(200);
    expect(mine.headers.get('Retry-After')).toBe('15');
    expect(await mine.json()).toMatchObject({ id: state.id, status: 'queued', video_id: VIDEO });
    expect((await get(principalOf(other.id))).status).toBe(404);
    const tool = await callTool(t.env, principalOf(owner.id), 'get_video_download', { id: state.id });
    expect(tool.result.structuredContent).toMatchObject({ id: state.id, status: 'queued' });
    const foreign = await callTool(t.env, principalOf(other.id), 'get_video_download', { id: state.id });
    expect(foreign.result.isError).toBe(true);
  });
});

describe('video analysis', () => {
  const analysisCharges = (userId: string) => t.db.prepare("SELECT credits FROM usage_events WHERE user_id = ? AND kind = 'video_analysis'").all(userId) as { credits: number }[];
  const analyzeMessages = () => queue.sent.filter((m) => m.step === 'analyze');

  beforeEach(() => {
    t.env.VIDCAP_API_KEY = 'vidcap-key';
    t.env.OPENROUTER_API_KEY = 'or-key';
  });

  async function readyJobWithAnalysis(model?: () => Response) {
    const fetch = stubFetch(undefined, undefined, model);
    const user = await seedUser(t, 'user');
    const state = (await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`, true)) as { id: string };
    await processVideoJob(t.env, state.id, 1);
    return { fetch, user, id: state.id };
  }

  it('prices by started minute of video', () => {
    expect(videoAnalysisCredits(19)).toBe(30);
    expect(videoAnalysisCredits(60)).toBe(30);
    expect(videoAnalysisCredits(61)).toBe(50);
    expect(videoAnalysisCredits(213)).toBe(90);
  });

  it('is a saved setting that needs video download', () => {
    expect(() => applyPreferencesPatch(DEFAULT_READING_PREFERENCES, { analyzeVideo: true })).toThrow(/analyzeVideo requires downloadVideo/);
    expect(applyPreferencesPatch(DEFAULT_READING_PREFERENCES, { downloadVideo: true, analyzeVideo: true })).toMatchObject({ downloadVideo: true, analyzeVideo: true });
    expect(normalizeStoredPreferences(JSON.stringify({ analyzeVideo: true })).analyzeVideo).toBe(false);
  });

  it('analyzes the stored video after the download and charges each step once', async () => {
    const { fetch, user, id } = await readyJobWithAnalysis();
    expect(job(id)).toMatchObject({ status: 'ready', duration_seconds: 20, analysis_status: 'queued' });
    expect(analyzeMessages()).toEqual([{ jobId: id, step: 'analyze' }]);
    await processVideoAnalysis(t.env, id, 1);
    await processVideoAnalysis(t.env, id, 2);
    expect(job(id)).toMatchObject({ analysis_status: 'ready', analysis_markdown: '## Summary\nA man at the zoo.', analysis_credits: 30, analysis_cost_usd: 0.0042, analysis_error: null });
    expect(charges(user.id)).toEqual([{ credits: ENRICHMENT_CREDITS.videoDownload }]);
    expect(analysisCharges(user.id)).toEqual([{ credits: 30 }]);
    const call = fetch.mock.calls.filter(([u]) => String(u).includes('openrouter.ai'));
    expect(call).toHaveLength(1);
    const body = JSON.parse(String(call[0][1]?.body));
    expect(body.model).toBe(VIDEO_ANALYSIS_MODEL);
    expect(body.messages[1].content[1]).toEqual({ type: 'video_url', video_url: { url: `https://cdn.anymd.test/videos/youtube/${VIDEO}/18.mp4` } });
    const md = videoDownloadMarkdown((await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`, true))!);
    expect(md).toMatch('### Video analysis (AI-generated by `google/gemini-3.8-flash`)');
    expect(md).toMatch('A man at the zoo.');
  });

  it('retries a transient model error, then fails without charging', async () => {
    const { user, id } = await readyJobWithAnalysis(() => new Response('busy', { status: 503 }));
    const message = { body: { jobId: id, step: 'analyze' as const }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await handleVideoQueue({ messages: [message] } as unknown as MessageBatch<VideoJobMessage>, t.env);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(job(id)).toMatchObject({ analysis_status: 'queued', analysis_error: 'analysis_failed' });
    await processVideoAnalysis(t.env, id, VIDEO_MAX_ATTEMPTS);
    expect(job(id)).toMatchObject({ analysis_status: 'failed', analysis_error: 'analysis_failed', analysis_credits: 0 });
    expect(analysisCharges(user.id)).toEqual([]);
  });

  it('does not run the model for videos over the limit or accounts without the credits', async () => {
    const { fetch, user, id } = await readyJobWithAnalysis();
    t.db.prepare('UPDATE video_jobs SET duration_seconds = ? WHERE id = ?').run(MAX_ANALYSIS_SECONDS + 1, id);
    await processVideoAnalysis(t.env, id, 1);
    expect(job(id)).toMatchObject({ analysis_status: 'failed', analysis_error: 'video_too_long' });
    t.db.prepare("UPDATE video_jobs SET duration_seconds = 3600, analysis_status = 'queued', analysis_error = NULL WHERE id = ?").run(id);
    await processVideoAnalysis(t.env, id, 1);
    expect(job(id)).toMatchObject({ analysis_status: 'failed', analysis_error: 'quota_exceeded' });
    expect(fetch.mock.calls.some(([u]) => String(u).includes('openrouter.ai'))).toBe(false);
    expect(analysisCharges(user.id)).toEqual([]);
  });

  it('adds an analysis to a ready job when a later read asks for it', async () => {
    stubFetch();
    const user = await seedUser(t, 'user');
    const state = (await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`)) as { id: string };
    await processVideoJob(t.env, state.id, 1);
    expect(job(state.id).analysis_status).toBeNull();
    const again = await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`, true);
    expect(again).toMatchObject({ reused: true, analysis: { status: 'queued', model: VIDEO_ANALYSIS_MODEL } });
    expect(analyzeMessages()).toEqual([{ jobId: state.id, step: 'analyze' }]);
  });

  it('fails a requested analysis together with its download', async () => {
    stubFetch(() => Response.json({ status: 'fail' }), () => Response.json({ status: 0 }));
    const user = await seedUser(t, 'user');
    const state = (await startVideoDownload(t.env, principalOf(user.id), 'free', 'api', `https://youtu.be/${VIDEO}`, true)) as { id: string };
    await processVideoJob(t.env, state.id, 1);
    expect(job(state.id)).toMatchObject({ status: 'failed', analysis_status: 'failed', analysis_error: 'download_failed' });
  });
});
