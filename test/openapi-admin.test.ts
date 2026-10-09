import { describe, expect, it } from 'vitest';
import { ALL_SCOPES } from '../src/auth/roles';
import { buildOpenApi } from '../src/openapi';

type Operation = { 'x-required-scope'?: string; parameters?: { name: string; in: string }[]; requestBody?: { content: Record<string, { schema: Record<string, unknown> }> }; responses: Record<string, unknown> };

const spec = buildOpenApi('https://anymd.test');
const ops = Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op: op as Operation })));

describe('admin OpenAPI', () => {
  it('describes every admin control-plane route', () => {
    const expected = [
      'get /admin/users', 'get /admin/users/{id}', 'patch /admin/users/{id}', 'post /admin/users/{id}/status', 'get /admin/users/{id}/credentials',
      'post /admin/users/{id}/sessions/revoke', 'delete /admin/users/{id}/keys/{keyId}', 'delete /admin/users/{id}/grants/{grantId}', 'get /admin/roles',
      'get /admin/settings', 'patch /admin/settings', 'put /admin/settings', 'get /admin/optouts', 'post /admin/optouts', 'delete /admin/optouts/{domain}',
      'get /admin/credits', 'post /admin/credits', 'post /admin/credits/{id}/revoke', 'get /admin/subscriptions', 'get /admin/subscriptions/{id}',
      'get /admin/billing/diagnostics', 'get /admin/audit', 'get /admin/audit/export', 'get /admin/system/overview', 'get /admin/system/usage',
      'get /admin/system/traces', 'get /admin/system/traces/{id}',
    ];
    const present = new Set(ops.map((o) => `${o.method} ${o.path}`));
    for (const e of expected) expect(present.has(e), e).toBe(true);
  });

  it('only names scopes that exist', () => {
    for (const { path, method, op } of ops) {
      const scope = op['x-required-scope'];
      if (scope) expect(ALL_SCOPES.includes(scope as never), `${method} ${path}: ${scope}`).toBe(true);
    }
  });

  it('derives query parameters and bodies from the service schemas, without plan editing', () => {
    const users = ops.find((o) => o.path === '/admin/users' && o.method === 'get')!.op;
    expect(users.parameters?.map((p) => p.name)).toEqual(expect.arrayContaining(['search', 'role', 'status', 'cursor', 'limit']));
    const patch = ops.find((o) => o.path === '/admin/users/{id}' && o.method === 'patch')!.op;
    const props = (patch.requestBody?.content['application/json'].schema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['expectedRole', 'idempotencyKey', 'role']);
    const grant = ops.find((o) => o.path === '/admin/credits' && o.method === 'post')!.op;
    expect(Object.keys(grant.responses)).toEqual(expect.arrayContaining(['201', '422']));
    const traces = ops.find((o) => o.path === '/traces' && o.method === 'get')!.op;
    expect(traces.parameters?.map((p) => p.name)).toEqual(expect.arrayContaining(['cursor']));
  });
});
