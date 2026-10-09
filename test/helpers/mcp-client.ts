/** Minimal JSON-RPC client over `handleMcp` for tests, in either protocol era. */
import type { Env, Principal } from '../../src/env';
import { handleMcp } from '../../src/mcp/server';

export const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) };

export interface RpcReply {
  status: number;
  headers: Headers;
  body: any;
}

export async function send(env: Env, principal: Principal, payload: unknown, headers: Record<string, string> = {}): Promise<RpcReply> {
  const req = new Request('https://anymd.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  const res = await handleMcp(req, env, ctx as never, principal);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** A legacy (2025-era) request: no protocol headers. */
export function rpc(env: Env, principal: Principal, method: string, params?: Record<string, unknown>) {
  return send(env, principal, { jsonrpc: '2.0', id: 1, method, params });
}

/** Call a tool and return its result object (content, structuredContent, isError). */
export async function callTool(env: Env, principal: Principal, name: string, args: Record<string, unknown> = {}) {
  const reply = await rpc(env, principal, 'tools/call', { name, arguments: args });
  return { ...reply, result: reply.body?.result };
}

export async function toolNames(env: Env, principal: Principal): Promise<string[]> {
  const { body } = await rpc(env, principal, 'tools/list');
  return body.result.tools.map((t: { name: string }) => t.name);
}
