import { describe, expect, it } from 'vitest';
import {
  ADMIN_SCOPES,
  ALL_SCOPES,
  capScopes,
  ELEVATED_SCOPES,
  expandScopes,
  KEY_PRESETS,
  OAUTH_DEFAULT_SCOPES,
  OAUTH_GRANT_VERSION,
  oauthConsentScopes,
  oauthPrincipalScopes,
  ROLE_TEMPLATES,
  scopesForRole,
} from '../src/auth/roles';
import type { RoleName } from '../src/env';

const ROLES = Object.keys(ROLE_TEMPLATES) as RoleName[];

describe('OAuth consent scopes', () => {
  it('gives a client that requests nothing the least-privilege baseline, for every role', () => {
    for (const role of ROLES) {
      const { granted } = oauthConsentScopes(role, []);
      expect(granted).toEqual(capScopes(role, OAUTH_DEFAULT_SCOPES));
      expect(granted.some((s) => ELEVATED_SCOPES.has(s))).toBe(false);
    }
  });

  it('grants requested admin scopes only when the role includes them', () => {
    expect(oauthConsentScopes('owner', ['users:read', 'credits:write']).granted).toEqual(['users:read', 'credits:write']);
    const admin = oauthConsentScopes('admin', ['users:read', 'credits:write']);
    expect(admin.granted).toEqual(['users:read']);
    expect(admin.unavailable).toEqual(['credits:write']);
    const user = oauthConsentScopes('user', ['users:read']);
    expect(user.granted).toEqual(OAUTH_DEFAULT_SCOPES);
    expect(user.unavailable).toEqual(['users:read']);
  });

  it('keeps owner credentials capped by the owner role', () => {
    expect(oauthConsentScopes('owner', ['not:a-scope', 'convert']).granted).toEqual(['convert']);
    expect(capScopes('owner', null)).toEqual(ALL_SCOPES);
  });
});

describe('OAuth baseline', () => {
  it('lets a default connection read, save and recall its own library, and nothing elevated', () => {
    expect(OAUTH_DEFAULT_SCOPES).toEqual(['convert', 'library:read', 'library:write']);
    expect(OAUTH_DEFAULT_SCOPES.some((s) => ELEVATED_SCOPES.has(s))).toBe(false);
  });

  it('shows keys:manage as elevated on the consent screen, since it manages long-lived credentials', () => {
    expect(ELEVATED_SCOPES.has('keys:manage')).toBe(true);
    for (const s of ADMIN_SCOPES) expect(ELEVATED_SCOPES.has(s), s).toBe(true);
  });
});

describe('OAuth principal scopes', () => {
  it('resolves a legacy grant stored with no scopes to the role\'s non-elevated scopes, not to nothing', () => {
    for (const role of ROLES) {
      const scopes = oauthPrincipalScopes(role, [], undefined);
      expect(scopes, role).toEqual(scopesForRole(role).filter((s) => !ELEVATED_SCOPES.has(s)));
      expect(scopes, role).toEqual(expect.arrayContaining(['convert', 'library:read']));
      expect(scopes.some((s) => ELEVATED_SCOPES.has(s)), role).toBe(false);
    }
    expect(oauthPrincipalScopes('user', [], undefined)).toEqual(['convert', 'library:read', 'library:write', 'usage:read']);
    // A current grant that holds nothing still holds nothing.
    expect(oauthPrincipalScopes('owner', [], OAUTH_GRANT_VERSION)).toEqual([]);
  });

  it('narrows to the token\'s own scopes when it was downscoped, and holds nothing when the token scope is empty', () => {
    const grant = ['convert', 'library:read', 'settings:read', 'settings:write'];
    expect(oauthPrincipalScopes('owner', grant, OAUTH_GRANT_VERSION, ['convert', 'settings:read'])).toEqual(['convert', 'settings:read']);
    // A downscope that matched nothing yields an empty token scope: no access, not the whole grant.
    expect(oauthPrincipalScopes('owner', ['convert', 'users:read'], OAUTH_GRANT_VERSION, [])).toEqual([]);
    expect(oauthPrincipalScopes('owner', grant, undefined, [])).toEqual([]);
    // Unknown token scopes leave the grant in charge; a legacy empty grant's tokens are empty too.
    expect(oauthPrincipalScopes('owner', grant, OAUTH_GRANT_VERSION)).toEqual(capScopes('owner', grant));
    expect(oauthPrincipalScopes('user', [], undefined, [])).toEqual(['convert', 'library:read', 'library:write', 'usage:read']);
    // A token never widens the grant.
    expect(oauthPrincipalScopes('owner', ['convert'], OAUTH_GRANT_VERSION, ['convert', 'users:read'])).toEqual(['convert']);
    // Legacy token scope names are translated before narrowing.
    expect(oauthPrincipalScopes('owner', ['users:roles:write'], OAUTH_GRANT_VERSION, ['users:write'])).toEqual(['users:roles:write']);
  });

  it('re-caps a grant by the current role, so a demotion takes effect immediately', () => {
    const grant = ['convert', 'users:read', 'settings:write'];
    expect(oauthPrincipalScopes('admin', grant, OAUTH_GRANT_VERSION).sort()).toEqual([...grant, 'settings:read'].sort());
    expect(oauthPrincipalScopes('user', grant, OAUTH_GRANT_VERSION)).toEqual(['convert']);
  });

  it('drops admin scopes from grants issued before least-privilege consent', () => {
    const legacy = scopesForRole('owner');
    const scopes = oauthPrincipalScopes('owner', legacy, undefined);
    expect(scopes.some((s) => ADMIN_SCOPES.has(s))).toBe(false);
    expect(scopes).toContain('convert');
    expect(scopes).toContain('pages:write');
  });
});

describe('scope vocabulary', () => {
  it('maps the legacy users:write scope to users:roles:write and lets settings:write read', () => {
    expect(expandScopes(['users:write'])).toContain('users:roles:write');
    expect(expandScopes(['settings:write'])).toEqual(expect.arrayContaining(['settings:write', 'settings:read']));
    expect(capScopes('owner', ['users:write'])).toEqual(['users:roles:write']);
  });

  it('treats an explicit empty request as nothing, not as the whole role', () => {
    expect(capScopes('owner', [])).toEqual([]);
  });

  it('keeps owner-only powers away from admins', () => {
    for (const s of ['users:roles:write', 'credits:write', 'billing:write'] as const) {
      expect(scopesForRole('owner')).toContain(s);
      expect(scopesForRole('admin')).not.toContain(s);
    }
    expect(scopesForRole('admin')).toEqual(expect.arrayContaining(['users:read', 'audit:read', 'system:read', 'settings:write', 'optouts:write', 'users:sessions:write']));
  });

  it('keeps keys:manage (saved reading defaults, own keys) out of narrow presets and OAuth defaults', () => {
    const preset = (id: string) => KEY_PRESETS.find((p) => p.id === id)?.scopes ?? [];
    for (const role of ROLES) expect(scopesForRole(role).includes('keys:manage'), role).toBe(role !== 'viewer');
    for (const id of ['convert-only', 'library', 'read-only']) expect(preset(id), id).not.toEqual(expect.arrayContaining(['keys:manage']));
    expect(OAUTH_DEFAULT_SCOPES).not.toEqual(expect.arrayContaining(['keys:manage']));
    for (const role of ROLES) expect(oauthConsentScopes(role, []).granted, role).not.toEqual(expect.arrayContaining(['keys:manage']));
  });

  it('offers least-privilege admin key presets', () => {
    const preset = (id: string) => KEY_PRESETS.find((p) => p.id === id)?.scopes ?? [];
    expect(preset('admin-read-only').every((s) => s.endsWith(':read'))).toBe(true);
    expect(preset('support')).toContain('users:sessions:write');
    expect(preset('support')).not.toContain('users:roles:write');
  });
});
