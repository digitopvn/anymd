import type { RoleName, Scope } from '../env';

/** Scopes every customer account holds. Anything outside this set is "elevated" (staff) access. */
const CUSTOMER: Scope[] = ['convert', 'library:read', 'library:write', 'usage:read', 'keys:manage'];
const CONTENT_READ: Scope[] = ['content:read', 'pages:read'];
const CONTENT_WRITE: Scope[] = ['content:write', 'pages:write'];
const CONTENT_PUBLISH: Scope[] = ['content:publish', 'pages:publish'];

/** Read-only operational visibility shared by admins and owners. */
const ADMIN_READ: Scope[] = ['settings:read', 'optouts:read', 'users:read', 'credits:read', 'billing:read', 'audit:read', 'system:read'];
/** Day-to-day admin writes: site settings, opt-outs and support actions on lower-ranked accounts. */
const ADMIN_WRITE: Scope[] = ['settings:write', 'optouts:write', 'users:sessions:write', 'users:credentials:write'];
/** Owner-only: authorization changes and anything that moves money or allowance. */
const OWNER_ONLY: Scope[] = ['users:roles:write', 'credits:write', 'billing:write'];

/**
 * Role templates. A principal's effective scopes are the role's scopes, optionally narrowed by an
 * API key's or OAuth grant's own scope list. Keys and grants never widen what the owning user holds.
 */
export const ROLE_TEMPLATES: Record<RoleName, { label: string; description: string; scopes: Scope[] }> = {
  owner: {
    label: 'Owner',
    description: 'Full control: everything an admin can do, plus role changes, credit grants and billing.',
    scopes: [...CUSTOMER, ...CONTENT_READ, ...CONTENT_WRITE, ...CONTENT_PUBLISH, ...ADMIN_READ, ...ADMIN_WRITE, ...OWNER_ONLY],
  },
  admin: {
    label: 'Admin',
    description: 'Run content, pages, settings and opt-outs; read users, audit, billing and system health; revoke access of lower roles. Cannot change roles or grant credits.',
    scopes: [...CUSTOMER, ...CONTENT_READ, ...CONTENT_WRITE, ...CONTENT_PUBLISH, ...ADMIN_READ, ...ADMIN_WRITE],
  },
  editor: {
    label: 'Editor',
    description: 'Write and publish blog posts and landing pages.',
    scopes: [...CUSTOMER, ...CONTENT_READ, ...CONTENT_WRITE, ...CONTENT_PUBLISH],
  },
  author: {
    label: 'Author',
    description: 'Draft posts and pages; an editor publishes them.',
    scopes: [...CUSTOMER, ...CONTENT_READ, ...CONTENT_WRITE],
  },
  viewer: {
    label: 'Viewer',
    description: 'Read drafts and analytics without changing anything.',
    scopes: ['convert', 'library:read', 'usage:read', ...CONTENT_READ],
  },
  user: {
    label: 'User',
    description: 'A customer: convert, keep a library, manage own keys.',
    scopes: CUSTOMER,
  },
};

export const ALL_SCOPES: Scope[] = ROLE_TEMPLATES.owner.scopes;

/** Scopes that reach other users' data or site-wide state. Shown as elevated on the consent screen. */
export const ELEVATED_SCOPES: ReadonlySet<Scope> = new Set(ALL_SCOPES.filter((s) => !CUSTOMER.includes(s)));

/** Admin control-plane scopes (everything outside customer and content work). */
export const ADMIN_SCOPES: ReadonlySet<Scope> = new Set([...ADMIN_READ, ...ADMIN_WRITE, ...OWNER_ONLY]);

/** What an OAuth client gets when it asks for no scopes: read the web and recall the library. */
export const OAUTH_DEFAULT_SCOPES: Scope[] = ['convert', 'library:read'];

/** Human labels for consent screens, key forms and docs. */
export const SCOPE_LABELS: Record<Scope, string> = {
  convert: 'Convert URLs to Markdown (uses your credits)',
  'library:read': 'Read and search your library',
  'library:write': 'Save and delete library documents',
  'usage:read': 'Read your usage and traces',
  'keys:manage': 'Manage your API keys and connected apps',
  'content:read': 'Read blog posts',
  'content:write': 'Write blog posts',
  'content:publish': 'Publish blog posts',
  'pages:read': 'Read landing pages',
  'pages:write': 'Edit landing pages',
  'pages:publish': 'Publish landing pages',
  'settings:read': 'Read site settings',
  'settings:write': 'Change site settings',
  'users:read': 'Read every user account and its credentials inventory',
  'users:roles:write': 'Change user roles',
  'users:sessions:write': 'Sign users out and suspend accounts',
  'users:credentials:write': "Revoke other users' API keys and OAuth grants",
  'credits:read': 'Read credit grants',
  'credits:write': 'Grant and revoke credits',
  'billing:read': 'Read subscriptions and billing diagnostics',
  'billing:write': 'Change billing (reserved; no tool uses it yet)',
  'audit:read': 'Read and export the audit log',
  'system:read': 'Read system-wide usage, errors and traces',
  'optouts:read': 'Read site opt-outs',
  'optouts:write': 'Block and unblock domains',
};

/** API-key presets shown in the dashboard. Each is capped by the owner's role at use time. */
export const KEY_PRESETS: { id: string; label: string; scopes: Scope[] }[] = [
  { id: 'convert-only', label: 'Convert only', scopes: ['convert'] },
  { id: 'library', label: 'Convert + library (agents)', scopes: ['convert', 'library:read', 'library:write'] },
  { id: 'read-only', label: 'Read-only', scopes: ['library:read', 'usage:read'] },
  { id: 'content-editor', label: 'Content editor (AI CMS)', scopes: ['content:read', 'content:write', 'content:publish', 'pages:read', 'pages:write', 'pages:publish'] },
  { id: 'admin-read-only', label: 'Admin read-only (monitoring agent)', scopes: [...ADMIN_READ, ...CONTENT_READ] },
  { id: 'support', label: 'Support agent', scopes: ['users:read', 'users:sessions:write', 'users:credentials:write', 'credits:read', 'credits:write', 'billing:read', 'audit:read'] },
  { id: 'site-ops', label: 'Site operations', scopes: ['settings:read', 'settings:write', 'optouts:read', 'optouts:write', 'audit:read', 'system:read'] },
  { id: 'full', label: 'Everything my role allows', scopes: ALL_SCOPES },
];

export function isRole(v: unknown): v is RoleName {
  return typeof v === 'string' && v in ROLE_TEMPLATES;
}

export function scopesForRole(role: RoleName): Scope[] {
  return ROLE_TEMPLATES[role]?.scopes ?? ROLE_TEMPLATES.user.scopes;
}

/**
 * Translate stored or requested scope names into current ones. `users:write` (before roles,
 * sessions and credentials were split) means `users:roles:write`; `settings:write` implies
 * `settings:read` so credentials made before the split can still read what they write.
 */
export function expandScopes(requested: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of requested) {
    if (s === 'users:write') out.add('users:roles:write');
    else out.add(s);
    if (s === 'settings:write') out.add('settings:read');
  }
  return [...out];
}

/**
 * Intersection of requested scopes with what the role allows. `null`/`undefined` means "the whole
 * role" (browser sessions); an empty list grants nothing.
 */
export function capScopes(role: RoleName, requested: readonly string[] | null | undefined): Scope[] {
  const allowed = scopesForRole(role);
  if (requested == null) return [...allowed];
  const wanted = new Set(expandScopes(requested));
  return allowed.filter((s) => wanted.has(s));
}

/**
 * Scopes an OAuth consent grants: the requested scopes capped by the role, or the least-privilege
 * default when the client asked for none. Never falls back to "everything the role allows".
 */
export function oauthConsentScopes(role: RoleName, requested: readonly string[]): { granted: Scope[]; unavailable: string[] } {
  const wanted = requested.length ? expandScopes(requested) : OAUTH_DEFAULT_SCOPES;
  let granted = capScopes(role, wanted);
  if (!granted.length) granted = capScopes(role, OAUTH_DEFAULT_SCOPES);
  const unavailable = wanted.filter((s) => !granted.includes(s as Scope));
  return { granted, unavailable };
}

/**
 * Effective scopes of an OAuth token. Grants issued before least-privilege consent (no `v` in
 * their props) could hold every scope of the role without asking; they keep only non-admin scopes
 * and must be re-authorized to reach the admin control plane.
 */
export function oauthPrincipalScopes(role: RoleName, grantScopes: readonly string[], grantVersion: number | undefined): Scope[] {
  const capped = capScopes(role, grantScopes);
  return grantVersion && grantVersion >= OAUTH_GRANT_VERSION ? capped : capped.filter((s) => !ADMIN_SCOPES.has(s));
}

/** Bumped when the meaning of a stored OAuth grant changes. */
export const OAUTH_GRANT_VERSION = 2;

const RANK: Record<RoleName, number> = { user: 0, viewer: 1, author: 2, editor: 3, admin: 4, owner: 5 };
export function roleAtLeast(role: RoleName, min: RoleName): boolean {
  return RANK[role] >= RANK[min];
}
