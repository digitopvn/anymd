/**
 * SSRF guard for MCP Events callback URLs. A callback must be `https`, carry no credentials, not
 * point at this service, and resolve (over DNS-over-HTTPS) only to globally routable addresses per
 * the IANA special-purpose registries. The check runs at subscribe time and again before every
 * delivery, so a host that later rebinds to a private address is refused at delivery.
 *
 * Residual risk: a Worker cannot pin the connection to the address it checked, so a rebinding
 * window between the check and the connection remains; Cloudflare's egress cannot reach private
 * networks of this account, and `global_fetch_strictly_public` keeps requests to our own zone public.
 */
import type { Env } from '../env';
import { ipv4Octets, isPublicAddress } from '../lib/ip';

export { isPublicAddress, isPublicIpv4, isPublicIpv6 } from '../lib/ip';

export class CallbackUrlError extends Error {
  constructor(message: string, readonly reason: 'invalid_url' | 'blocked_host' | 'unresolvable' | 'resolver_unavailable') {
    super(message);
  }
}

const MAX_URL_LENGTH = 2048;

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.corp', '.intranet'];

/** Shape checks only (no DNS). Returns the normalized URL. */
export function parseCallbackUrl(env: Pick<Env, 'PUBLIC_URL'>, raw: unknown): URL {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL_LENGTH) throw new CallbackUrlError('delivery.url must be an https URL of at most 2048 characters', 'invalid_url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackUrlError('delivery.url is not a valid URL', 'invalid_url');
  }
  if (url.protocol !== 'https:') throw new CallbackUrlError('delivery.url must use https', 'invalid_url');
  if (url.username || url.password) throw new CallbackUrlError('delivery.url must not carry credentials', 'invalid_url');
  if (url.hash) throw new CallbackUrlError('delivery.url must not carry a fragment', 'invalid_url');
  // A trailing dot names the same host (`anymd.cc.`), so compare without it.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const literal = ipv4Octets(host) !== null || host.includes(':');
  if (literal ? !isPublicAddress(host) : !host.includes('.') || host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new CallbackUrlError('delivery.url must be a public host', 'blocked_host');
  }
  let own = '';
  try {
    own = new URL(env.PUBLIC_URL).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    /* No public URL configured (tests). */
  }
  if (own && (host === own || host.endsWith(`.${own}`))) throw new CallbackUrlError('delivery.url must not point at this service', 'blocked_host');
  return url;
}

const DOH = 'https://cloudflare-dns.com/dns-query';

async function resolve(host: string, type: 'A' | 'AAAA'): Promise<string[]> {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { Accept: 'application/dns-json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) }).catch(() => null);
  // Our resolver failing says nothing about the callback host: callers must not blame the endpoint.
  if (!res || !res.ok) throw new CallbackUrlError('Could not resolve the callback host', 'resolver_unavailable');
  const body = (await res.json().catch(() => null)) as { Status?: number; Answer?: { type: number; data: string }[] } | null;
  if (!body || (body.Status !== 0 && body.Status !== 3)) throw new CallbackUrlError('Could not resolve the callback host', 'resolver_unavailable');
  const want = type === 'A' ? 1 : 28;
  return (body.Answer ?? []).filter((a) => a.type === want).map((a) => a.data);
}

/**
 * Full check: shape, then every A/AAAA answer must be public. Throws CallbackUrlError otherwise.
 * IP-literal hosts were already judged by the shape check.
 */
export async function assertPublicCallback(env: Pick<Env, 'PUBLIC_URL'>, raw: string): Promise<URL> {
  const url = parseCallbackUrl(env, raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipv4Octets(host) !== null || host.includes(':')) return url;
  const addresses = [...(await resolve(host, 'A')), ...(await resolve(host, 'AAAA'))];
  if (!addresses.length) throw new CallbackUrlError('The callback host does not resolve', 'unresolvable');
  if (!addresses.every(isPublicAddress)) throw new CallbackUrlError('delivery.url resolves to a non-public address', 'blocked_host');
  return url;
}
