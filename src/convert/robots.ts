/**
 * robots.txt support (RFC 9309) for pages anymd fetches itself. The product token is `anymd`;
 * without a group for it, the `*` group applies.
 */
import type { Env } from '../env';
import { USER_AGENT } from './types';

export const ROBOTS_TOKEN = 'anymd';
const MAX_ROBOTS_BYTES = 500 * 1024;
const OK_TTL = 24 * 3600;
const ERROR_TTL = 600;

interface Rule {
  allow: boolean;
  path: string;
}

/** Rules that apply to `token`: its own group(s) if any, else the `*` group(s). */
export function robotsRules(text: string, token = ROBOTS_TOKEN): Rule[] {
  const own: Rule[] = [];
  const star: Rule[] = [];
  let agents: string[] = [];
  let inRules = false;
  let hasOwn = false;
  for (const raw of text.slice(0, MAX_ROBOTS_BYTES).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      // A user-agent line after rules starts a new group.
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      if (value.toLowerCase() === token) hasOwn = true;
      continue;
    }
    if (key !== 'allow' && key !== 'disallow') continue;
    inRules = true;
    // An empty Disallow allows everything; it adds no rule.
    if (!value) continue;
    const rule = { allow: key === 'allow', path: value };
    if (agents.includes(token)) own.push(rule);
    if (agents.includes('*')) star.push(rule);
  }
  return hasOwn ? own : star;
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${re}${anchored ? '$' : ''}`).test(path);
}

function normalizePath(p: string): string {
  // Compare in a canonical percent-encoded form so /caf%C3%A9 and /café match.
  try {
    return encodeURI(decodeURI(p));
  } catch {
    return p;
  }
}

/** Longest matching rule wins; on a tie, Allow wins. No matching rule means allowed. */
export function isPathAllowed(rules: Rule[], pathAndQuery: string): boolean {
  if (pathAndQuery === '/robots.txt') return true;
  const target = normalizePath(pathAndQuery);
  let best: Rule | null = null;
  for (const r of rules) {
    if (!ruleMatches(normalizePath(r.path), target)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

type RobotsState = { status: 'ok'; text: string } | { status: 'allow_all' } | { status: 'unreachable' };

async function loadRobots(env: Env, origin: string): Promise<RobotsState> {
  const key = `robots:${origin}`;
  const cached = await env.CACHE.get<RobotsState>(key, 'json');
  if (cached) return cached;
  let state: RobotsState;
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(5000) });
    if (res.ok) state = { status: 'ok', text: (await res.text()).slice(0, MAX_ROBOTS_BYTES) };
    // RFC 9309: a missing robots.txt (4xx) allows everything; a server or network error means "assume disallowed".
    else state = res.status >= 400 && res.status < 500 ? { status: 'allow_all' } : { status: 'unreachable' };
  } catch {
    state = { status: 'unreachable' };
  }
  await env.CACHE.put(key, JSON.stringify(state), { expirationTtl: state.status === 'unreachable' ? ERROR_TTL : OK_TTL });
  return state;
}

/** 'allowed', 'disallowed' by the site's rules, or 'unreachable' when robots.txt itself could not be read. */
export async function robotsVerdict(env: Env, url: URL): Promise<'allowed' | 'disallowed' | 'unreachable'> {
  const state = await loadRobots(env, url.origin);
  if (state.status === 'allow_all') return 'allowed';
  if (state.status === 'unreachable') return 'unreachable';
  return isPathAllowed(robotsRules(state.text), url.pathname + url.search) ? 'allowed' : 'disallowed';
}
