/**
 * Outbound fetch of a user-supplied URL. Redirects are followed by hand so every hop passes
 * `normalizeTargetUrl` again (a public page cannot bounce the Worker to a private or own host),
 * and one deadline covers every hop plus the body read.
 */
import { normalizeTargetUrl } from './index';
import { ConvertError } from './types';

export const MAX_REDIRECTS = 5;

export interface PublicFetchOptions {
  headers?: Record<string, string>;
  /** Shared by every hop and by the caller's body read. */
  signal: AbortSignal;
  /** Runs before each redirect hop is fetched (opt-out, politeness checks). May throw. */
  beforeHop?: (next: URL) => Promise<void>;
}

/** A timeout signal capped by the conversion's own deadline, when it has one. */
export function fetchDeadline(maxMs: number, deadline?: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, Math.min(maxMs, (deadline ?? Date.now() + maxMs) - Date.now())));
}

export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** The final response and the URL it came from (the source to cite). */
export async function fetchPublic(start: URL, options: PublicFetchOptions): Promise<{ response: Response; url: URL }> {
  let url = normalizeTargetUrl(start.href);
  for (let hop = 0; ; hop++) {
    const response = await fetch(url.href, { headers: options.headers, redirect: 'manual', signal: options.signal });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return { response, url };
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new ConvertError(`Too many redirects (max ${MAX_REDIRECTS})`, 502, 'too_many_redirects');
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new ConvertError('The page redirected to an invalid URL', 502, 'invalid_redirect');
    }
    if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new ConvertError('The page redirected to a non-http(s) URL', 502, 'invalid_redirect');
    try {
      next = normalizeTargetUrl(next.href);
    } catch (err) {
      if (err instanceof ConvertError && err.code === 'blocked_host') throw new ConvertError('The page redirected to a blocked address', 400, 'blocked_host');
      throw new ConvertError('The page redirected to an invalid URL', 502, 'invalid_redirect');
    }
    if (options.beforeHop) await options.beforeHop(next);
    url = next;
  }
}
