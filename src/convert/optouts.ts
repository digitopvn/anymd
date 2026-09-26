/**
 * Site opt-outs: domains whose owners asked us not to fetch them. An entry covers the domain and
 * every subdomain, and is enforced before the shared cache so nothing already cached is served either.
 */
import type { Env } from '../env';

export interface SiteOptout {
  domain: string;
  reason: string;
  created_by: string | null;
  created_at: number;
}

/** Lowercase hostname without a leading `www.`, or null when the input is not a usable domain. */
export function normalizeOptoutDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host)) return null;
  return host;
}

/** The hostname and each parent domain with at least two labels: a.b.example.com → a.b.example.com, b.example.com, example.com. */
export function optoutCandidates(hostname: string): string[] {
  const labels = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '').split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

export async function findOptout(env: Env, hostname: string): Promise<SiteOptout | null> {
  const candidates = optoutCandidates(hostname);
  if (!candidates.length) return null;
  return env.DB.prepare(`SELECT * FROM site_optouts WHERE domain IN (${candidates.map(() => '?').join(',')}) LIMIT 1`)
    .bind(...candidates)
    .first<SiteOptout>();
}

export async function listOptouts(env: Env): Promise<SiteOptout[]> {
  const { results } = await env.DB.prepare('SELECT * FROM site_optouts ORDER BY created_at DESC').all<SiteOptout>();
  return results;
}

export async function addOptout(env: Env, domain: string, reason: string, createdBy: string | null): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO site_optouts (domain, reason, created_by, created_at) VALUES (?,?,?,?)').bind(domain, reason, createdBy, Date.now()).run();
}

export async function removeOptout(env: Env, domain: string): Promise<void> {
  await env.DB.prepare('DELETE FROM site_optouts WHERE domain = ?').bind(domain).run();
}
