/** Shared shapes for MCP tool definitions, so tool groups can live in their own modules. */
import type { z } from 'zod';
import type { Env, Principal, Scope, WaitUntil } from '../env';

export interface ToolContext {
  env: Env;
  ctx: WaitUntil;
  principal: Principal & { userId: string };
  origin: string;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  input: z.ZodObject<z.ZodRawShape>;
  annotations?: ToolAnnotations;
  // Arguments are validated against `input` before `run` is called; each tool narrows them itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any, t: ToolContext) => Promise<unknown>;
}

/** A tool failure the model should see verbatim (not found, bad state). */
export class ToolError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Reads anymd data only. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Changes anymd state; repeating it with the same arguments has no further effect. */
export const IDEMPOTENT_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Changes anymd state; repeating it creates another change unless an idempotencyKey is passed. */
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Removes or revokes something; repeating it is safe. */
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/**
 * Tools that change anymd's own state count against the stricter MCP mutation bucket. Reading a URL
 * (open world) is metered by credits and the per-site budget instead.
 */
export function isMutation(tool: Pick<ToolDef, 'annotations'>): boolean {
  return tool.annotations?.readOnlyHint !== true && tool.annotations?.openWorldHint !== true;
}
