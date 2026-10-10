/** Key/value site settings read by public pages. Cached in KV for a minute; writes go through `services/admin/settings`. */
import type { Env } from '../env';

const CACHE_KEY = 'settings:v1';

export async function getSettings(env: Env): Promise<Record<string, string>> {
  const cached = await env.CACHE.get<Record<string, string>>(CACHE_KEY, 'json').catch(() => null);
  if (cached) return cached;
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const out = Object.fromEntries(results.map((r) => [r.key, r.value]));
  await env.CACHE.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: 60 }).catch(() => undefined);
  return out;
}

/** Drop the cached copy after a write so public pages pick the change up on their next read. */
export async function invalidateSettingsCache(env: Env): Promise<void> {
  await env.CACHE.delete(CACHE_KEY).catch(() => undefined);
}
