import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  ENVIRONMENT: 'staging' | 'production' | 'development';
  PUBLIC_URL: string;
  CDN_URL: string;
  GITHUB_REPO: string;
  /** Which payment provider takes checkouts; the other one stays off even when its secrets are set. */
  BILLING_PROVIDER: 'creem' | 'polar';
  CREEM_SERVER: 'test' | 'production';
  POLAR_SERVER: 'sandbox' | 'production';

  DB: D1Database;
  OAUTH_KV: KVNamespace;
  CACHE: KVNamespace;
  MEDIA: R2Bucket;
  VECTORS: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  RL_ANON: RateLimit;
  RL_AUTH: RateLimit;
  /** Per-site budget for pages anymd fetches itself, shared by all callers. */
  RL_DOMAIN: RateLimit;
  /** Every MCP request, per user + credential. Optional: falls back to RL_AUTH when unbound. */
  RL_MCP?: RateLimit;
  /** Stricter bucket for MCP tools that change state. Optional: falls back to RL_MCP / RL_AUTH. */
  RL_MCP_MUTATION?: RateLimit;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Background YouTube video downloads. Optional: without it (or both VIDCAP_API_KEY and RAPIDAPI_KEY) video download is unavailable. */
  VIDEO_QUEUE?: Queue<import('./convert/youtube-video').VideoJobMessage>;

  // Secrets (all optional; features degrade gracefully when absent)
  ADMIN_EMAILS?: string;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  TYPESAFE_API_KEY?: string;
  VIDCAP_API_KEY?: string;
  GITHUB_TOKEN?: string;
  OPENROUTER_API_KEY?: string;
  RESEND_API_KEY?: string;
  RAPIDAPI_KEY?: string;
  // Social sign-in. A provider shows up only when both its id and secret are set; the callback
  // defaults to `${PUBLIC_URL}/api/auth/oauth/<provider>/callback`.
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_CALLBACK_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CALLBACK_URL?: string;
}

/** The part of ExecutionContext this app uses; Hono's and workers-types' contexts both satisfy it. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Who is calling. Resolved once per request by the auth middleware. */
export interface Principal {
  kind: 'anonymous' | 'session' | 'api_key' | 'oauth';
  userId: string | null;
  role: RoleName;
  scopes: Scope[];
  apiKeyId?: string;
  /** OAuth client the grant was issued to (MCP over OAuth). */
  clientId?: string;
  /** Request correlation id, recorded on audit rows. */
  requestId?: string;
  /** Adapter and operation that is acting, e.g. `mcp:update_user_role` or `api:PATCH /admin/users/:id`. */
  via?: string;
}

export type RoleName = 'owner' | 'admin' | 'editor' | 'author' | 'viewer' | 'user';

export type Scope =
  | 'convert'
  | 'library:read'
  | 'library:write'
  | 'usage:read'
  | 'keys:manage'
  | 'content:read'
  | 'content:write'
  | 'content:publish'
  | 'pages:read'
  | 'pages:write'
  | 'pages:publish'
  | 'settings:read'
  | 'settings:write'
  | 'users:read'
  | 'users:roles:write'
  | 'users:sessions:write'
  | 'users:credentials:write'
  | 'credits:read'
  | 'credits:write'
  | 'billing:read'
  | 'billing:write'
  | 'audit:read'
  | 'system:read'
  | 'optouts:read'
  | 'optouts:write';

export type AppBindings = {
  Bindings: Env;
  Variables: { principal: Principal; user: import('./auth/identity').UserRow | null };
};
