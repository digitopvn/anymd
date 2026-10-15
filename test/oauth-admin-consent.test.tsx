import { describe, expect, it } from 'vitest';
import { consentAdminPresets, consentGrantScopes } from '../src/auth/consent';
import { KEY_PRESETS, OAUTH_DEFAULT_SCOPES, oauthConsentScopes, ROLE_TEMPLATES, scopesForRole } from '../src/auth/roles';
import type { RoleName, Scope } from '../src/env';
import { ConsentPage } from '../src/views/auth';
import { KeysPage } from '../src/views/dashboard';

const ROLES = Object.keys(ROLE_TEMPLATES) as RoleName[];
const SUPPORT = KEY_PRESETS.find((p) => p.id === 'support')!.scopes;
const ADMIN_READ_ONLY = KEY_PRESETS.find((p) => p.id === 'admin-read-only')!.scopes;

function renderConsent(role: RoleName, scopes: Scope[] = [...OAUTH_DEFAULT_SCOPES]): string {
  return String(<ConsentPage clientName="Claude" scopes={scopes} state="s" userEmail="a@example.com" role={role} adminPresets={consentAdminPresets(role)} />);
}

describe('consentGrantScopes', () => {
  it('leaves the default request unchanged without an admin choice', () => {
    for (const role of ROLES) {
      for (const choice of [undefined, '', 'none']) {
        expect(consentGrantScopes(role, [], choice)).toEqual(oauthConsentScopes(role, []).granted);
      }
    }
  });

  it('ignores invalid values, so form input never widens scopes', () => {
    const base = oauthConsentScopes('owner', []).granted;
    for (const bad of ['full', 'site-ops', 'SUPPORT', 'support ', ['support'], 1, null, { id: 'support' }]) {
      expect(consentGrantScopes('owner', [], bad)).toEqual(base);
    }
  });

  it('gives roles below admin no admin scopes', () => {
    for (const role of ['user', 'viewer', 'author', 'editor'] as RoleName[]) {
      for (const preset of ['admin-read-only', 'support']) {
        expect(consentGrantScopes(role, [], preset)).toEqual(oauthConsentScopes(role, []).granted);
      }
      expect(consentAdminPresets(role)).toEqual([]);
    }
  });

  it('adds support scopes for an admin, minus owner-only ones', () => {
    const scopes = consentGrantScopes('admin', [], 'support');
    for (const s of OAUTH_DEFAULT_SCOPES) expect(scopes.includes(s)).toBe(true);
    for (const s of SUPPORT.filter((s) => s !== 'credits:write')) expect(scopes.includes(s)).toBe(true);
    expect(scopes.includes('credits:write')).toBe(false);
    expect(scopes.every((s) => scopesForRole('admin').includes(s))).toBe(true);
  });

  it('adds every preset scope for an owner', () => {
    const support = consentGrantScopes('owner', [], 'support');
    expect(support).toEqual(expect.arrayContaining([...OAUTH_DEFAULT_SCOPES, ...SUPPORT]));
    expect(support.includes('credits:write')).toBe(true);
    expect(support).toHaveLength(new Set([...OAUTH_DEFAULT_SCOPES, ...SUPPORT]).size);
    const readOnly = consentGrantScopes('owner', [], 'admin-read-only');
    expect(readOnly).toEqual(expect.arrayContaining([...OAUTH_DEFAULT_SCOPES, ...ADMIN_READ_ONLY]));
    expect(readOnly.some((s) => s.endsWith(':write') && !OAUTH_DEFAULT_SCOPES.includes(s))).toBe(false);
  });

  it('keeps explicitly requested scopes alongside the preset', () => {
    const scopes = consentGrantScopes('admin', ['convert', 'usage:read'], 'admin-read-only');
    expect(scopes).toEqual(expect.arrayContaining(['convert', 'usage:read', ...ADMIN_READ_ONLY]));
    expect(scopes.includes('library:write')).toBe(false);
  });
});

describe('ConsentPage admin access', () => {
  it('offers admin options to owners and admins, with None checked by default', () => {
    for (const role of ['owner', 'admin'] as RoleName[]) {
      const html = renderConsent(role);
      expect(html.includes('data-admin-access')).toBe(true);
      expect(html.includes('<legend')).toBe(true);
      expect(html.includes('Admin access for this connection (optional)')).toBe(true);
      expect(html).toMatch(/<input type="radio" name="admin_access" value="none" checked=""/);
      expect(html.includes('value="admin-read-only"')).toBe(true);
      expect(html.includes('value="support"')).toBe(true);
      expect(html).not.toMatch(/value="(admin-read-only|support)"[^>]*checked/);
      expect(html.includes('audit log')).toBe(true);
      expect(html.includes('Dashboard → API keys')).toBe(true);
    }
  });

  it('lists the scope codes each option adds, capped by role and excluding granted ones', () => {
    const admin = renderConsent('admin');
    expect(admin.includes('data-admin-scope="users:read"')).toBe(true);
    expect(admin.includes('data-admin-scope="system:read"')).toBe(true);
    expect(admin.includes('data-admin-scope="credits:write"')).toBe(false);
    expect(renderConsent('owner').includes('data-admin-scope="credits:write"')).toBe(true);
    expect(renderConsent('owner', ['convert', 'users:read']).includes('data-admin-scope="users:read"')).toBe(false);
  });

  it('is not rendered for roles below admin, even if presets are passed', () => {
    for (const role of ['user', 'viewer', 'author', 'editor'] as RoleName[]) {
      const html = String(<ConsentPage clientName="Claude" scopes={[...OAUTH_DEFAULT_SCOPES]} state="s" userEmail="a@example.com" role={role} adminPresets={['admin-read-only', 'support']} />);
      expect(html.includes('admin_access')).toBe(false);
      expect(html.includes('data-admin-access')).toBe(false);
    }
  });
});

describe('KeysPage admin agent card', () => {
  const render = (role: RoleName) => String(<KeysPage keys={[]} grants={[]} role={role} />);

  it('explains both admin agent routes to owners and admins', () => {
    for (const role of ['owner', 'admin'] as RoleName[]) {
      const html = render(role);
      expect(html.includes('Connect an admin agent')).toBe(true);
      expect(html.includes('get_admin_access_status')).toBe(true);
      expect(html.includes('claude mcp add --transport http anymd-admin')).toBe(true);
      expect(html.includes('href="/docs/mcp#set-up-an-admin-agent"')).toBe(true);
    }
  });

  it('is hidden from roles below admin', () => {
    for (const role of ['user', 'viewer', 'author', 'editor'] as RoleName[]) expect(render(role).includes('data-admin-agent-setup')).toBe(false);
  });
});
