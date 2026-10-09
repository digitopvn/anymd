/**
 * The caller's own account over MCP: request traces, API keys and connected OAuth apps. Scoped to
 * the signed-in user; adapters over `services/admin/credentials` and `services/admin/observability`.
 */
import { z } from 'zod';
import { CreateKeyInput, createOwnKey, listOwnGrants, listOwnKeys, revokeOwnGrant, revokeOwnKey } from '../services/admin/credentials';
import { getOwnTrace, listOwnTraces, OwnTraceQuery } from '../services/admin/observability';
import { DESTRUCTIVE, READ_ONLY, WRITE, type ToolDef } from './tool-types';

export const ACCOUNT_TOOLS: ToolDef[] = [
  {
    name: 'list_traces',
    title: 'List my traces',
    description: 'Your recent request traces (summaries, newest first). Paginated: pass next_cursor back as cursor.',
    scope: 'usage:read',
    input: OwnTraceQuery,
    annotations: READ_ONLY,
    run: (a, t) => listOwnTraces(t.env, t.principal, a),
  },
  {
    name: 'get_trace',
    title: 'Get my trace',
    description: 'One of your traces with its spans (fetch, convert, enrich, save timings and errors).',
    scope: 'usage:read',
    input: z.object({ traceId: z.string().min(1).max(80) }),
    annotations: READ_ONLY,
    run: (a, t) => getOwnTrace(t.env, t.principal, a.traceId),
  },
  {
    name: 'list_api_keys',
    title: 'List my API keys',
    description: 'Your API keys (metadata only, never the secret) and the available scope presets.',
    scope: 'keys:manage',
    input: z.object({}),
    annotations: READ_ONLY,
    run: (_a, t) => listOwnKeys(t.env, t.principal),
  },
  {
    name: 'create_api_key',
    title: 'Create API key',
    description:
      'Create an API key for yourself from a preset or explicit scopes. It never gets scopes this connection lacks, and your role caps it again on every use. The secret is returned once: hand it to the user and do not repeat it.',
    scope: 'keys:manage',
    input: CreateKeyInput,
    annotations: WRITE,
    run: (a, t) => createOwnKey(t.env, t.principal, a),
  },
  {
    name: 'revoke_api_key',
    title: 'Revoke my API key',
    description: 'Revoke one of your API keys immediately.',
    scope: 'keys:manage',
    input: z.object({ keyId: z.string().min(1).max(80) }),
    annotations: DESTRUCTIVE,
    run: (a, t) => revokeOwnKey(t.env, t.principal, a.keyId),
  },
  {
    name: 'list_oauth_grants',
    title: 'List my connected apps',
    description: 'OAuth apps (MCP clients) connected to your account, with their scopes.',
    scope: 'keys:manage',
    input: z.object({}),
    annotations: READ_ONLY,
    run: (_a, t) => listOwnGrants(t.env, t.principal),
  },
  {
    name: 'revoke_my_oauth_grant',
    title: 'Disconnect my app',
    description: 'Disconnect one of your OAuth apps; its tokens stop working immediately. Revoking the grant this session uses ends this session.',
    scope: 'keys:manage',
    input: z.object({ grantId: z.string().min(1).max(200) }),
    annotations: DESTRUCTIVE,
    run: (a, t) => revokeOwnGrant(t.env, t.principal, a.grantId),
  },
];
