/**
 * Idempotency for admin writes, sharing the `idempotency_keys` table with page ops. A key is scoped
 * to the acting user and operation: replaying it with the same payload returns the stored result
 * (`replayed: true`) without running the write again; reusing it with a different payload is a 422.
 *
 * The first request claims the key with a pending row before running, so a concurrent retry with
 * the same key never runs (or audits) the write twice: it gets the stored result once the first
 * finishes, or `409 idempotency_in_progress` while it is still running. A failed write releases its
 * claim; a claim left by a crashed (or very slow) request can be taken over after PENDING_TTL_MS.
 * Each claim carries its holder's token, so a holder that lost its claim to a takeover can neither
 * release nor overwrite the new holder's claim when it finishes late.
 */
import type { Env } from '../../env';
import { now, randomToken, sha256 } from '../../lib/util';
import { AdminError, type Actor } from './shared';

const principalKey = (actor: Actor) => `admin:${actor.userId}`;
const PENDING = '__pending__';
const isPending = (response: string) => response === PENDING || response.startsWith(`${PENDING}:`);
export const PENDING_TTL_MS = 60_000;

interface StoredKey {
  op: string;
  payload_hash: string;
  response: string;
  created_at: number;
}

export async function withIdempotency<T extends object>(
  env: Env,
  actor: Actor,
  op: string,
  key: string | null | undefined,
  payload: unknown,
  run: () => Promise<T>,
): Promise<T & { replayed: boolean }> {
  if (!key) return { ...(await run()), replayed: false };
  const principal = principalKey(actor);
  const hash = await sha256(JSON.stringify({ op, payload }));
  const ts = now();
  const mine = `${PENDING}:${randomToken(12)}`;
  const claim = await env.DB.prepare('INSERT OR IGNORE INTO idempotency_keys (key,principal,op,payload_hash,response,created_at) VALUES (?,?,?,?,?,?)')
    .bind(key, principal, op, hash, mine, ts)
    .run();
  if (!claim.meta.changes) {
    const prior = await env.DB.prepare('SELECT op, payload_hash, response, created_at FROM idempotency_keys WHERE key = ? AND principal = ?').bind(key, principal).first<StoredKey>();
    if (!prior) throw new AdminError('This idempotencyKey is being released by a failed attempt. Retry shortly.', 409, 'idempotency_in_progress', { retryAfter: 1 });
    if (prior.op !== op || prior.payload_hash !== hash) {
      throw new AdminError('idempotencyKey was already used with a different request. Use a new key for a new change.', 422, 'idempotency_mismatch');
    }
    if (!isPending(prior.response)) return { ...(JSON.parse(prior.response) as T), replayed: true };
    // Take over a claim abandoned by a crashed request; otherwise the first request is still running.
    const takeover = await env.DB.prepare('UPDATE idempotency_keys SET created_at = ?, response = ? WHERE key = ? AND principal = ? AND response = ? AND created_at = ? AND created_at < ?')
      .bind(ts, mine, key, principal, prior.response, prior.created_at, ts - PENDING_TTL_MS)
      .run();
    if (!takeover.meta.changes) {
      throw new AdminError('A request with this idempotencyKey is still running. Retry shortly to get its result.', 409, 'idempotency_in_progress', { retryAfter: 1 });
    }
  }
  let result: T;
  try {
    result = await run();
  } catch (err) {
    // Release the claim (only if still ours) so the caller can retry the same key after fixing the cause.
    await env.DB.prepare('DELETE FROM idempotency_keys WHERE key = ? AND principal = ? AND response = ?').bind(key, principal, mine).run().catch(() => undefined);
    throw err;
  }
  // Store the result only while the claim is still ours; a request that took it over stores its own.
  await env.DB.prepare('UPDATE idempotency_keys SET response = ? WHERE key = ? AND principal = ? AND response = ?').bind(JSON.stringify(result), key, principal, mine).run();
  return { ...result, replayed: false };
}
