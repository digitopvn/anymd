/**
 * What a Claude Directory user sees when they connect anymd with the default OAuth grant, checked
 * against the connector review criteria: a focused customer tool set with no staff tooling, short
 * names, a title and explicit hints on every tool, and server instructions that name only what the
 * caller can use.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capScopes, OAUTH_DEFAULT_SCOPES, OAUTH_GRANT_VERSION, oauthPrincipalScopes, ROLE_TEMPLATES, scopesForRole } from '../src/auth/roles';
import type { Principal, RoleName } from '../src/env';
import { rpc } from './helpers/mcp-client';
import { createTestEnv, type TestEnv } from './helpers/sqlite-env';

/** The public connector's tool set: read the web, then save to and recall from the caller's own library. */
const DIRECTORY_TOOLS = ['read_url', 'convert_url', 'search_library', 'get_video_download', 'search_social', 'get_document', 'list_documents', 'delete_document', 'tag_document', 'list_tags'];

let t: TestEnv;
beforeEach(() => {
  t = createTestEnv();
});
afterEach(() => t.close());

const customer = (scopes = capScopes('user', OAUTH_DEFAULT_SCOPES)): Principal => ({ kind: 'oauth', userId: 'u-customer', role: 'user', scopes, clientId: 'claude' });

async function listing(p: Principal) {
  const { body } = await rpc(t.env, p, 'tools/list');
  return body.result.tools as { name: string; title: string; description: string; annotations: Record<string, unknown> }[];
}

describe('default Claude connection (user role, default OAuth grant)', () => {
  it('lists exactly the public research and library tools', async () => {
    expect((await listing(customer())).map((x) => x.name).sort()).toEqual([...DIRECTORY_TOOLS].sort());
  });

  it('gives every visible tool a short name, a title and explicit read-only and destructive hints', async () => {
    for (const tool of await listing(customer())) {
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
      expect(tool.annotations.title, tool.name).toBe(tool.title);
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations.destructiveHint, tool.name).toBe('boolean');
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
    const byName = new Map((await listing(customer())).map((x) => [x.name, x.annotations]));
    expect(byName.get('delete_document')?.destructiveHint).toBe(true);
    for (const n of ['search_library', 'get_document', 'list_documents', 'list_tags', 'get_video_download']) expect(byName.get(n)?.readOnlyHint, n).toBe(true);
  });

  it('keeps staff tooling out of the server instructions', async () => {
    const { body } = await rpc(t.env, customer(), 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } });
    const text: string = body.result.instructions;
    expect(text).toMatch(/read_url/);
    expect(text).toMatch(/search_library/);
    for (const staff of ['Admin', 'get_admin_access_status', 'system_overview', 'Page-builder', 'publish_page']) expect(text.includes(staff), staff).toBe(false);
  });

  it('shows no staff tooling to any non-admin role, whatever it is granted', async () => {
    const staff = new Set(['get_admin_access_status', 'system_overview', 'list_users']);
    for (const role of (Object.keys(ROLE_TEMPLATES) as RoleName[]).filter((r) => r !== 'owner' && r !== 'admin')) {
      const names = (await listing({ ...customer(scopesForRole(role)), role })).map((x) => x.name);
      expect(names.filter((n) => staff.has(n)), role).toEqual([]);
    }
  });
});

describe('owner connection', () => {
  it('still names admin and page-builder tooling in the instructions and lists the access tool', async () => {
    const owner: Principal = { kind: 'oauth', userId: 'u-owner', role: 'owner', scopes: oauthPrincipalScopes('owner', [...OAUTH_DEFAULT_SCOPES, 'pages:read'], OAUTH_GRANT_VERSION), clientId: 'claude' };
    const { body } = await rpc(t.env, owner, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } });
    expect(body.result.instructions).toMatch(/get_admin_access_status/);
    expect(body.result.instructions).toMatch(/Page-builder/);
    expect((await listing(owner)).map((x) => x.name)).toEqual(expect.arrayContaining(['get_admin_access_status']));
  });
});
