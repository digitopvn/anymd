/** OAuth consent: which scopes a connection receives, including the opt-in admin access presets. */
import type { RoleName, Scope } from '../env';
import { capScopes, isOAuthAdminPreset, OAUTH_ADMIN_PRESET_IDS, oauthAdminPresetScopes, oauthConsentScopes, roleAtLeast, type OAuthAdminPresetId } from './roles';

/** Admin access presets this role may add on the consent screen (none below admin). */
export function consentAdminPresets(role: RoleName): OAuthAdminPresetId[] {
  return roleAtLeast(role, 'admin') ? [...OAUTH_ADMIN_PRESET_IDS] : [];
}

/**
 * Scopes granted when the user approves consent: the client's requested scopes (capped by role,
 * least-privilege default when it asked for none), plus the admin preset the user explicitly chose.
 * `adminAccess` is raw form input: anything that is not a known preset, or a preset chosen by a role
 * below admin, adds nothing. `allowDelete` is the raw "also allow deleting" checkbox: only the value
 * `'1'` adds `library:delete`. The result is re-capped by the role, so it can never exceed it.
 */
export function consentGrantScopes(role: RoleName, requested: readonly string[], adminAccess: unknown, allowDelete?: unknown): Scope[] {
  const { granted } = oauthConsentScopes(role, requested);
  const extra: Scope[] = allowDelete === '1' ? ['library:delete'] : [];
  if (isOAuthAdminPreset(adminAccess) && consentAdminPresets(role).includes(adminAccess)) extra.push(...oauthAdminPresetScopes(role, adminAccess));
  return extra.length ? capScopes(role, [...granted, ...extra]) : granted;
}

/** Whether the consent screen offers the "also allow deleting" checkbox: the role can delete and the grant would not. */
export function consentOffersDelete(role: RoleName, granted: readonly Scope[]): boolean {
  return !granted.includes('library:delete') && capScopes(role, ['library:delete']).length > 0;
}
