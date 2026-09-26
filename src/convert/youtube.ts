/**
 * YouTube adapter — inherited from nextlevelbuilder/defuddle.
 * Metadata via oEmbed; transcript via RapidAPI youtube-transcript3, falling back to VidCap.
 */
import { countWords, ConvertError, type ConvertContext, type ConvertResult, type SourceAdapter } from './types';

const YOUTUBE_URL_PATTERN =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/live\/)/;

export function parseVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1) || null;
    if (parsed.pathname.startsWith('/shorts/') || parsed.pathname.startsWith('/live/')) {
      return parsed.pathname.split('/')[2] || null;
    }
    return parsed.searchParams.get('v') || null;
  } catch {
    return null;
  }
}

interface OEmbedData {
  title: string;
  author_name: string;
  author_url: string;
  thumbnail_url: string;
}

async function fetchOEmbed(videoUrl: string): Promise<OEmbedData> {
  const resp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
  if (resp.status === 404 || resp.status === 401) throw new ConvertError('Video not found or private', 404, 'not_found');
  if (!resp.ok) throw new ConvertError(`YouTube oEmbed error: ${resp.status}`, 502, 'upstream_error');
  return resp.json() as Promise<OEmbedData>;
}

interface VidCapResponse {
  status: number;
  data: { sourceId: string; content: string; ext: string };
}

async function fetchTranscript(videoUrl: string, apiKey: string, lang?: string): Promise<string | null> {
  const params = new URLSearchParams({ url: videoUrl });
  if (lang) params.set('locale', lang);
  const resp = await fetch(`https://vidcap.xyz/api/v1/youtube/caption?${params}`, {
    headers: { Accept: 'application/json', 'X-API-Key': apiKey },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as VidCapResponse;
  if (data.status !== 1 || !data.data?.content) return null;
  return formatTranscript(data.data.content);
}

interface RapidSegment {
  text: string;
  offset: string | number;
}

/** RapidAPI "youtube-transcript3": [{ text, offset (s), duration, lang }] with HTML-encoded text. */
async function fetchRapidTranscript(videoId: string, apiKey: string, lang?: string): Promise<string | null> {
  const params = new URLSearchParams({ videoId });
  if (lang) params.set('lang', lang.slice(0, 2));
  const resp = await fetch(`https://youtube-transcript3.p.rapidapi.com/api/transcript?${params}`, {
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'youtube-transcript3.p.rapidapi.com' },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { success?: boolean; transcript?: RapidSegment[] };
  if (!data.success || !data.transcript?.length) return null;
  const raw = data.transcript.map((seg) => `[at ${Number(seg.offset) || 0} seconds] ${seg.text}`).join(' ');
  return formatTranscript(raw) || null;
}

/** Convert VidCap format "[at X seconds] text" into readable markdown with timestamps. */
export function formatTranscript(raw: string): string {
  const decoded = raw
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const segmentRegex = /\[at ([\d.]+) seconds?\]\s*([\s\S]*?)(?=\[at [\d.]+ seconds?\]|$)/g;
  const segments: { start: number; text: string }[] = [];
  let match;
  while ((match = segmentRegex.exec(decoded)) !== null) {
    const text = match[2].trim();
    if (text) segments.push({ start: parseFloat(match[1]), text });
  }
  if (segments.length === 0) return '';
  const lines = ['## Transcript', ''];
  for (const group of groupBySentence(segments)) {
    lines.push(`**${formatTimestamp(group.start)}** · ${group.text}`, '');
  }
  return lines.join('\n');
}

const SENTENCE_END = /[.!?]["'’”)]*\s*$/;
const GROUP_GAP_SECONDS = 20;

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function groupBySentence(segments: { start: number; text: string }[]): { start: number; text: string }[] {
  const groups: { start: number; text: string }[] = [];
  let buffer = '';
  let bufferStart = 0;
  let lastStart = 0;
  const flush = () => {
    if (buffer.trim()) {
      groups.push({ start: bufferStart, text: buffer.trim() });
      buffer = '';
    }
  };
  for (const seg of segments) {
    if (buffer && seg.start - lastStart > GROUP_GAP_SECONDS) flush();
    if (!buffer) bufferStart = seg.start;
    buffer += (buffer ? ' ' : '') + seg.text;
    lastStart = seg.start;
    if (SENTENCE_END.test(seg.text)) flush();
  }
  flush();
  return groups;
}

async function convertYoutube(url: URL, ctx: ConvertContext): Promise<ConvertResult> {
  const videoId = parseVideoId(url.href);
  if (!videoId) throw new ConvertError('Invalid YouTube URL', 400, 'invalid_url');
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const vidcapKey = ctx.env.VIDCAP_API_KEY || '';
  const rapidKey = ctx.env.RAPIDAPI_KEY || '';
  const loadTranscript = async (): Promise<string | null> => {
    if (rapidKey) {
      const t = await fetchRapidTranscript(videoId, rapidKey, ctx.language).catch(() => null);
      if (t) return t;
    }
    return vidcapKey ? fetchTranscript(canonicalUrl, vidcapKey, ctx.language).catch(() => null) : null;
  };

  const [oembed, transcript] = await Promise.all([
    ctx.tracer.span('youtube.oembed', () => fetchOEmbed(canonicalUrl)),
    rapidKey || vidcapKey ? ctx.tracer.span('youtube.transcript', loadTranscript) : Promise.resolve(null),
  ]);

  const thumb = oembed.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const parts = [`[![${oembed.title.replace(/[[\]]/g, '')}](${thumb})](${canonicalUrl})`];
  parts.push(`**Channel:** [${oembed.author_name}](${oembed.author_url})`);
  if (transcript) parts.push(transcript);
  else parts.push('> Transcript unavailable for this video.');
  const content = parts.join('\n\n');

  return {
    title: oembed.title || '',
    author: oembed.author_name || '',
    published: '',
    description: oembed.title || '',
    domain: 'youtube.com',
    content,
    wordCount: countWords(content),
    source: url.href,
    sourceKind: 'youtube',
    image: thumb,
    site: 'YouTube',
  };
}

export const youtubeAdapter: SourceAdapter = {
  kind: 'youtube',
  matches: (url) => YOUTUBE_URL_PATTERN.test(url.href),
  convert: convertYoutube,
};
