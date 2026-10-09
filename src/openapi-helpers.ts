/** Small builders shared by the OpenAPI description modules. */
export type Schema = Record<string, unknown>;

export const str = (description?: string, extra: Schema = {}): Schema => ({ type: 'string', ...(description ? { description } : {}), ...extra });
export const int = (description?: string, extra: Schema = {}): Schema => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
export const bool = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) });
export const arr = (items: Schema, description?: string): Schema => ({ type: 'array', items, ...(description ? { description } : {}) });
export const obj = (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}), ...(description ? { description } : {}) });
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
export const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: 'null' }] });

export interface Op {
  summary: string;
  description?: string;
  tag: string;
  scope?: string | null;
  params?: { name: string; in: 'query' | 'path' | 'header'; schema: Schema; required?: boolean; description?: string }[];
  body?: Schema;
  bodyType?: string;
  ok: Schema | { content: string; schema: Schema };
  status?: number;
  errors?: number[];
}

export const idParam = (what: string) => ({ name: 'id', in: 'path' as const, required: true, schema: str(), description: `${what} id` });
