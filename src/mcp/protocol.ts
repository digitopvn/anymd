/**
 * MCP protocol eras served from one endpoint.
 *
 * - Modern (2026-07-28): stateless. No `initialize`; every request carries its protocol version
 *   in `params._meta` and mirrors it, the method and (for tools/call) the tool name in the
 *   `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. `server/discover` describes the
 *   server. Results carry `resultType`; list results carry `ttlMs` and `cacheScope`. No batching, no ping.
 * - Legacy (2025-11-25 and earlier): `initialize` handshake and `ping`; JSON-RPC batches only for clients on 2025-03-26 or earlier (later versions dropped batching).
 *
 * A request is modern when it names a modern version in `_meta` or in the header, or calls
 * `server/discover`; anything else is served as legacy, so existing clients keep working unchanged.
 */
import type { Env } from '../env';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** How long clients may cache list and discovery results; they vary by caller, so the scope is private. */
export const LIST_TTL_MS = 60_000;

/** JSON-RPC error codes. -32000..-32019 are implementation-defined; -32020+ come from the MCP spec. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  SERVER_ERROR: -32000,
  UNAUTHORIZED: -32001,
  INSUFFICIENT_SCOPE: -32003,
  RATE_LIMITED: -32005,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
} as const;

export type JsonRpcId = string | number | null;
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export function resourceMetadataUrl(env: Pick<Env, 'PUBLIC_URL'>): string {
  return `${env.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;
}

function metaVersion(msg: unknown): string | null {
  const meta = (msg as JsonRpcMessage | null)?.params?._meta as Record<string, unknown> | undefined;
  const v = meta?.[META_PROTOCOL_VERSION];
  return typeof v === 'string' ? v : null;
}

export function isModernRequest(headerVersion: string | null, payload: unknown): boolean {
  if (headerVersion && MODERN_VERSIONS.includes(headerVersion)) return true;
  if (Array.isArray(payload)) return false;
  const v = metaVersion(payload);
  if (v && !LEGACY_VERSIONS.includes(v)) return true;
  return (payload as JsonRpcMessage | null)?.method === 'server/discover';
}

/** Header values may be sent raw or as `=?base64?<value>?=` when they are not plain ASCII. */
export function decodeHeaderValue(raw: string | null): string | null {
  if (raw === null) return null;
  const m = /^=\?base64\?([A-Za-z0-9+/=_-]*)\?=$/.exec(raw.trim());
  if (!m) return raw.trim();
  try {
    const bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export interface ProtocolFailure {
  status: number;
  code: number;
  message: string;
  data?: unknown;
}

/** Version and header checks for a modern request. Null when the request is well formed. */
export function validateModern(headers: Headers, msg: JsonRpcMessage): ProtocolFailure | null {
  const requested = metaVersion(msg) ?? headers.get('mcp-protocol-version');
  // Discovery is how a client learns the versions, so it may arrive without naming one.
  if (!requested && msg.method === 'server/discover') return null;
  if (!requested ||!MODERN_VERSIONS.includes(requested)) {
    return { status: 400, code: RPC.UNSUPPORTED_VERSION, message: `Unsupported protocol version: ${requested ?? '(none)'}`, data: { supported: SUPPORTED_VERSIONS, requested: requested ?? null } };
  }
  const mismatch = (what: string, expected: string, got: string | null): ProtocolFailure => ({
    status: 400,
    code: RPC.HEADER_MISMATCH,
    message: `${what} header ${got === null ? 'is missing' : `does not match the request body (${got})`}; expected ${expected}`,
    data: { header: what, expected, received: got },
  });
  const headerVersion = headers.get('mcp-protocol-version');
  if (headerVersion !== requested) return mismatch('MCP-Protocol-Version', requested, headerVersion);
  const method = decodeHeaderValue(headers.get('mcp-method'));
  if (method !== msg.method) return mismatch('Mcp-Method', String(msg.method), method);
  if (msg.method === 'tools/call') {
    const expected = String(msg.params?.name ?? '');
    const name = decodeHeaderValue(headers.get('mcp-name'));
    if (name !== expected) return mismatch('Mcp-Name', expected, name);
  }
  return null;
}
