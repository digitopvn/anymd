import { describe, expect, it } from 'vitest';
import type { Env, Principal } from '../src/env';
import { handleMcp } from '../src/mcp/server';

const principal: Principal = { kind: 'api_key', userId: 'u1', role: 'user', scopes: ['convert', 'library:read'] };
const ctx = { waitUntil: () => {} };

async function rpc(method: string, params?: Record<string, unknown>, p: Principal = principal) {
  const req = new Request('https://anymd.cc/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const res = await handleMcp(req, {} as Env, ctx as never, p);
  return (await res.json()) as { result: any };
}

describe('mcp read_url', () => {
  it('lists read_url first and keeps convert_url with the same input schema', async () => {
    const { result } = await rpc('tools/list');
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names.slice(0, 2)).toEqual(['read_url', 'convert_url']);
    const [read, convert] = result.tools;
    expect(read.inputSchema).toEqual(convert.inputSchema);
    expect(read.inputSchema.required).toEqual(['url']);
  });

  it('hides both names without the convert scope', async () => {
    const { result } = await rpc('tools/list', undefined, { ...principal, scopes: ['library:read'] });
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names.includes('read_url')).toBe(false);
    expect(names.includes('convert_url')).toBe(false);
  });

  it('validates arguments the same way under both names', async () => {
    for (const name of ['read_url', 'convert_url']) {
      const { result } = await rpc('tools/call', { name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text.includes('url')).toBe(true);
    }
  });

  it('mentions read_url in the server instructions', async () => {
    const { result } = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(result.instructions.includes('read_url')).toBe(true);
    expect(result.instructions.includes('convert_url')).toBe(true);
  });
});
