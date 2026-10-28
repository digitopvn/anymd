/**
 * Failed authentication with a presented credential: an API key that does not resolve, an OAuth
 * token that is invalid, expired, revoked or bound to another resource, or a valid token whose
 * account is suspended or gone. Each failure is logged as one structured line (never the
 * credential itself) and counted against a per-IP budget, so a client hammering anymd with bad
 * credentials gets 429 instead of an endless stream of 401s.
 *
 * Requests without any credential (a host's first contact, which discovers OAuth from the 401
 * challenge) are not failures and are never counted.
 */
import type { Env } from '../env';

/** RL_AUTH runs a 60-second window; failures share it under their own key prefix. */
export const AUTH_FAILURE_RETRY_AFTER = 60;

export type AuthFailureReason = 'invalid_api_key' | 'invalid_token' | 'account_suspended' | 'account_missing';

export interface AuthFailure {
  credential: 'api_key' | 'oauth';
  reason: AuthFailureReason;
  /** Known only when the token itself was valid (suspended or deleted account). */
  userId?: string;
  clientId?: string;
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
}

/**
 * Log the failure and spend one unit of the caller's failure budget. Resolves `true` when the budget
 * is exhausted and the caller should answer 429. A limiter outage fails open.
 */
export async function recordAuthFailure(env: Env, request: Request, failure: AuthFailure): Promise<boolean> {
  const url = new URL(request.url);
  console.warn(
    JSON.stringify({
      event: 'auth_failure',
      credential: failure.credential,
      reason: failure.reason,
      method: request.method,
      path: url.pathname,
      ray: request.headers.get('cf-ray') ?? undefined,
      user_id: failure.userId,
      client_id: failure.clientId,
    }),
  );
  try {
    const { success } = await env.RL_AUTH.limit({ key: `authfail:${clientIp(request)}` });
    return !success;
  } catch (err) {
    console.error('auth failure limiter unavailable', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Whether the request presents a credential (bearer token or `X-API-Key`). */
export function presentsCredential(request: Request): boolean {
  const auth = request.headers.get('authorization') ?? '';
  return (auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim().length > 0) || Boolean(request.headers.get('x-api-key')?.trim());
}
