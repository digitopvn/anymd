/**
 * Fetches for URLs a caller or a third-party page chose. `fetch` would follow redirects without
 * asking, so the SSRF guard would only see the first hop; here every hop goes back through
 * `normalizeTargetUrl`, the hop count is capped and one deadline covers the whole exchange,
 * including reading the body.
 */
import { normalizeTargetUrl } from './index';
import { ConvertError } from './types';

export const MAX_REDIRECTS = 5;

export interface PublicFetchOptions {
  headers?: Record<string, string>;
  /** Deadline for every hop and the body read together. */
  timeoutMs: number;
  maxRedirects?: number;
  /** Runs before each redirect hop is fetched, e.g. for the opt-out list or the target site's robots.txt. */
  beforeRedirect?: (next: URL) => Promise<void>;
}

export interface PublicFetchResult {
  response: Response;
  /** The URL that answered: the requested one, or the last vetted redirect target. */
  url: URL;
  redirects: number;
}

function redirectTarget(location: string, base: URL): URL {
  let next: URL;
  try {
    next = new URL(location, base);
  } catch {
    throw new ConvertError(`${base.hostname} redirected to an invalid URL`, 502, 'fetch_failed');
  }
  if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new ConvertError(`${base.hostname} redirected to a non-http(s) URL`, 400, 'blocked_host');
  try {
    return normalizeTargetUrl(next.href);
  } catch (err) {
    if (err instanceof ConvertError) throw new ConvertError(`${base.hostname} redirected to an address anymd will not fetch`, 400, 'blocked_host');
    throw err;
  }
}

export async function fetchPublic(url: URL, options: PublicFetchOptions): Promise<PublicFetchResult> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let current = url;
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await fetch(current.href, { headers: options.headers, redirect: 'manual', signal });
    } catch (err) {
      throw fetchFailure(current, err);
    }
    if (response.status < 300 || response.status >= 400 || response.status === 304) return { response, url: current, redirects };
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (!location) throw new ConvertError(`${current.hostname} responded ${response.status} without a redirect target`, 502, 'upstream_status');
    if (redirects >= maxRedirects) throw new ConvertError(`Too many redirects (more than ${maxRedirects})`, 502, 'fetch_failed');
    const next = redirectTarget(location, current);
    await options.beforeRedirect?.(next);
    current = next;
  }
}

export function timedOut(err: unknown): boolean {
  // DOMException is not an Error subclass on every runtime, so judge by name.
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** A network failure or the deadline, as a bounded error that names the host but no internals. */
export function fetchFailure(url: URL, err: unknown): ConvertError {
  if (err instanceof ConvertError) return err;
  if (timedOut(err)) return new ConvertError(`${url.hostname} took too long to respond`, 502, 'fetch_failed');
  return new ConvertError(`Could not reach ${url.hostname}`, 502, 'fetch_failed');
}
