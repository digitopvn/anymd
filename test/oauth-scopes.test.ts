import { describe, expect, it } from 'vitest';
import {
  ADMIN_SCOPES,
  ALL_SCOPES,
  capScopes,
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
      expect(granted).toEqual(OAUTH_DEFAULT_SCOPES);
      expect(granted.some((s) => ADMIN_SCOPES.has(s))).toBe(false);
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

describe('OAuth principal scopes', () => {
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

  it('offers least-privilege admin key presets', () => {
    const preset = (id: string) => KEY_PRESETS.find((p) => p.id === id)?.scopes ?? [];
    expect(preset('admin-read-only').every((s) => s.endsWith(':read'))).toBe(true);
    expect(preset('support')).toContain('users:sessions:write');
    expect(preset('support')).not.toContain('users:roles:write');
  });
});
