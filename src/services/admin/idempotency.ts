/**
 * Idempotency for admin writes, sharing the `idempotency_keys` table with page ops. A key is scoped
 * to the acting user and operation: replaying it with the same payload returns the stored result
 * (`replayed: true`) without running the write again; reusing it with a different payload is a 422.
 */
import type { Env } from '../../env';
import { now, sha256 } from '../../lib/util';
import { AdminError, type Actor } from './shared';

const principalKey = (actor: Actor) => `admin:${actor.userId}`;

export async function withIdempotency<T extends object>(
  env: Env,
  actor: Actor,
  op: string,
  key: string | null | undefined,
  payload: unknown,
  run: () => Promise<T>,
): Promise<T & { replayed: boolean }> {
  if (!key) return { ...(await run()), replayed: false };
  const hash = await sha256(JSON.stringify({ op, payload }));
  const prior = await env.DB.prepare('SELECT op, payload_hash, response FROM idempotency_keys WHERE key = ? AND principal = ?')
    .bind(key, principalKey(actor))
    .first<{ op: string; payload_hash: string; response: string }>();
  if (prior) {
    if (prior.op !== op || prior.payload_hash !== hash) {
      throw new AdminError('idempotencyKey was already used with a different request. Use a new key for a new change.', 422, 'idempotency_mismatch');
    }
    return { ...(JSON.parse(prior.response) as T), replayed: true };
  }
  const result = await run();
  // INSERT OR IGNORE: a concurrent identical request may have stored its result first; both results are equivalent.
  await env.DB.prepare('INSERT OR IGNORE INTO idempotency_keys (key,principal,op,payload_hash,response,created_at) VALUES (?,?,?,?,?,?)')
    .bind(key, principalKey(actor), op, hash, JSON.stringify(result), now())
    .run();
  return { ...result, replayed: false };
}
