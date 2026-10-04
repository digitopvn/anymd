import { ConvertError, type ConvertContext } from './types';

export async function readBounded(response: Response, maxBytes = 5 * 1024 * 1024): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new ConvertError('Upstream response too large', 502, 'upstream_too_large');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new ConvertError('Upstream response too large', 502, 'upstream_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** Hosts and paths are chosen in adapters, never supplied by the caller. */
export async function rapidJson(host: string, path: string, params: Record<string, string>, ctx: ConvertContext): Promise<unknown> {
  if (!ctx.env.RAPIDAPI_KEY) throw new ConvertError('Social provider is not configured', 503, 'provider_unavailable');
  if (ctx.budget && !ctx.budget.canFetch()) throw new ConvertError('Conversion processing limit reached', 408, 'processing_limit');
  if (ctx.budget) ctx.budget.calls++;
  return ctx.tracer.span('social.fetch', async () => {
    try {
      const response = await fetch(`https://${host}${path}?${new URLSearchParams(params)}`, {
        headers: { 'X-RapidAPI-Key': ctx.env.RAPIDAPI_KEY!, 'X-RapidAPI-Host': host },
        redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, (ctx.budget?.deadline ?? Date.now() + 15_000) - Date.now()))),
      });
      if (response.status === 401 || response.status === 403) throw new ConvertError('Social provider subscription is unavailable', 503, 'provider_unavailable');
      if (response.status === 404) throw new ConvertError('Post not found or private', 404, 'not_found');
      if (!response.ok) throw new ConvertError('Social provider request failed', 502, 'upstream_error');
      return JSON.parse(new TextDecoder().decode(await readBounded(response)));
    } catch (e) {
      if (e instanceof ConvertError) throw e;
      throw new ConvertError('Social provider timed out or returned invalid data', 502, 'upstream_error');
    }
  });
}
