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

export class CallbackUrlError extends Error {
  constructor(message: string, readonly reason: 'invalid_url' | 'blocked_host' | 'unresolvable' | 'resolver_unavailable') {
    super(message);
  }
}

const MAX_URL_LENGTH = 2048;

function ipv4Octets(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return out.every((n) => n >= 0 && n <= 255) ? out : null;
}

export function isPublicIpv4(s: string): boolean {
  const o = ipv4Octets(s);
  if (!o) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** Eight 16-bit groups, or null when not an IPv6 address. Accepts an embedded IPv4 tail. */
function ipv6Groups(s: string): number[] | null {
  let addr = s.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!addr.includes(':')) return null;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    addr = addr.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.every((g) => Number.isInteger(g)) ? groups : null;
}

export function isPublicIpv6(s: string): boolean {
  const g = ipv6Groups(s);
  if (!g) return false;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry an IPv4 address: judge that.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicIpv4(v4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicIpv4(v4(g[6], g[7]));
  // Only global unicast (2000::/3) is routable; within it, exclude the special-purpose blocks.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 (Teredo, benchmarking, ORCHID, …)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 can tunnel to any IPv4 address
  if (g[0] === 0x3fff && g[1] < 0x1000) return false; // documentation (3fff::/20)
  return true;
}

export function isPublicAddress(s: string): boolean {
  return s.includes(':') ? isPublicIpv6(s) : isPublicIpv4(s);
}

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
