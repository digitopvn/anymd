/** Key/value site settings edited in Admin → Settings. Cached in KV for a minute. */
import type { Env } from '../env';
import { now } from './util';

const CACHE_KEY = 'settings:v1';

export async function getSettings(env: Env): Promise<Record<string, string>> {
  const cached = await env.CACHE.get<Record<string, string>>(CACHE_KEY, 'json').catch(() => null);
  if (cached) return cached;
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const out = Object.fromEntries(results.map((r) => [r.key, r.value]));
  await env.CACHE.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: 60 }).catch(() => undefined);
  return out;
}

export async function putSettings(env: Env, values: Record<string, string>): Promise<void> {
  const ts = now();
  const stmts = Object.entries(values).map(([k, v]) =>
    v.trim()
      ? env.DB.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').bind(k, v.trim(), ts)
      : env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(k),
  );
  if (stmts.length) await env.DB.batch(stmts);
  await env.CACHE.delete(CACHE_KEY);
}
