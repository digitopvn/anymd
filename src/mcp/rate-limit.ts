/**
 * MCP rate limits, separate from the REST middleware. Every request counts against a per-user,
 * per-credential bucket (RL_MCP); tools that change anymd state also count against a stricter
 * mutation bucket (RL_MCP_MUTATION), both per credential and per user, so minting more keys or
 * registering more OAuth clients does not multiply how fast one account can change things. Both
 * bindings are optional and fall back to RL_AUTH, so a deployment without them is still limited.
 */
import type { Env, Principal, RateLimit } from '../env';

/** Both buckets are configured with a 60-second period in wrangler.jsonc. */
export const MCP_RATE_PERIOD_SECONDS = 60;

export type McpBucket = 'request' | 'mutation';

export interface RateLimited {
  bucket: McpBucket;
  retryAfter: number;
}

/** User plus the credential in use, so one leaked key or misbehaving client cannot drain the others. */
export function mcpRateKey(p: Principal): string {
  const credential = p.apiKeyId ? `k:${p.apiKeyId}` : p.clientId ? `c:${p.clientId}` : p.kind;
  return `${p.userId ?? 'anon'}:${credential}`;
}

/** The whole account, across every credential. */
export function mcpUserRateKey(p: Principal): string {
  return `user:${p.userId ?? 'anon'}`;
}

function binding(env: Env, bucket: McpBucket): RateLimit | undefined {
  return bucket === 'mutation' ? (env.RL_MCP_MUTATION ?? env.RL_MCP ?? env.RL_AUTH) : (env.RL_MCP ?? env.RL_AUTH);
}

/**
 * Null when allowed. `per` picks the credential bucket (default) or the account-wide one. A limiter
 * outage fails open: availability beats a hard dependency on the binding.
 */
export async function checkMcpRate(env: Env, p: Principal, bucket: McpBucket, per: 'credential' | 'user' = 'credential'): Promise<RateLimited | null> {
  const limiter = binding(env, bucket);
  // Only reachable without any binding in local tooling; production always binds RL_AUTH.
  if (!limiter) return null;
  try {
    const { success } = await limiter.limit({ key: `mcp:${bucket}:${per === 'user' ? mcpUserRateKey(p) : mcpRateKey(p)}` });
    return success ? null : { bucket, retryAfter: MCP_RATE_PERIOD_SECONDS };
  } catch (err) {
    console.error('mcp rate limiter unavailable', bucket, err instanceof Error ? err.message : String(err));
    return null;
  }
}
