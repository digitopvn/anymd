import type { RoleName, Scope } from '../env';

/**
 * Role templates. A principal's effective scopes are the role's scopes, optionally narrowed by an
 * API key's or OAuth grant's own scope list. Roles never widen what the owning user holds.
 */
export const ROLE_TEMPLATES: Record<RoleName, { label: string; description: string; scopes: Scope[] }> = {
  owner: {
    label: 'Owner',
    description: 'Full control of the site: content, pages, settings and users.',
    scopes: [
      'convert', 'library:read', 'library:write', 'usage:read', 'keys:manage',
      'content:read', 'content:write', 'content:publish',
      'pages:read', 'pages:write', 'pages:publish',
      'settings:write', 'users:read', 'users:write',
    ],
  },
  admin: {
    label: 'Admin',
    description: 'Manage content, pages, offers and read users. Cannot change user roles.',
    scopes: [
      'convert', 'library:read', 'library:write', 'usage:read', 'keys:manage',
      'content:read', 'content:write', 'content:publish',
      'pages:read', 'pages:write', 'pages:publish',
      'settings:write', 'users:read',
    ],
  },
  editor: {
    label: 'Editor',
    description: 'Write and publish blog posts and landing pages.',
    scopes: [
      'convert', 'library:read', 'library:write', 'usage:read', 'keys:manage',
      'content:read', 'content:write', 'content:publish', 'pages:read', 'pages:write', 'pages:publish',
    ],
  },
  author: {
    label: 'Author',
    description: 'Draft posts and pages; an editor publishes them.',
    scopes: ['convert', 'library:read', 'library:write', 'usage:read', 'keys:manage', 'content:read', 'content:write', 'pages:read', 'pages:write'],
  },
  viewer: {
    label: 'Viewer',
    description: 'Read drafts and analytics without changing anything.',
    scopes: ['convert', 'library:read', 'usage:read', 'content:read', 'pages:read'],
  },
  user: {
    label: 'User',
    description: 'A customer: convert, keep a library, manage own keys.',
    scopes: ['convert', 'library:read', 'library:write', 'usage:read', 'keys:manage'],
  },
};

export const ALL_SCOPES = ROLE_TEMPLATES.owner.scopes;

/** API-key presets shown in the dashboard. Each is capped by the owner's role at use time. */
export const KEY_PRESETS: { id: string; label: string; scopes: Scope[] }[] = [
  { id: 'convert-only', label: 'Convert only', scopes: ['convert'] },
  { id: 'library', label: 'Convert + library (agents)', scopes: ['convert', 'library:read', 'library:write'] },
  { id: 'read-only', label: 'Read-only', scopes: ['library:read', 'usage:read'] },
  { id: 'content-editor', label: 'Content editor (AI CMS)', scopes: ['content:read', 'content:write', 'content:publish', 'pages:read', 'pages:write', 'pages:publish'] },
  { id: 'full', label: 'Everything my role allows', scopes: ALL_SCOPES },
];

export function isRole(v: unknown): v is RoleName {
  return typeof v === 'string' && v in ROLE_TEMPLATES;
}

export function scopesForRole(role: RoleName): Scope[] {
  return ROLE_TEMPLATES[role]?.scopes ?? ROLE_TEMPLATES.user.scopes;
}

/** Intersection of requested scopes with what the role allows. */
export function capScopes(role: RoleName, requested: readonly string[] | null | undefined): Scope[] {
  const allowed = new Set(scopesForRole(role));
  if (!requested || requested.length === 0) return [...allowed];
  return requested.filter((s): s is Scope => allowed.has(s as Scope));
}

const RANK: Record<RoleName, number> = { user: 0, viewer: 1, author: 2, editor: 3, admin: 4, owner: 5 };
export function roleAtLeast(role: RoleName, min: RoleName): boolean {
  return RANK[role] >= RANK[min];
}
