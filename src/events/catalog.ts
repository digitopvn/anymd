/**
 * The MCP Events this server offers. Every event is owner-scoped: it only ever describes the
 * subscriber's own library documents, video jobs or feedback, and is visible only to credentials
 * holding the scope that reads that resource. Payloads are minimal (opaque ids, status, version,
 * correlation id); the subscriber reads details through the normal, separately authorized tools.
 */
import { z } from 'zod';
import type { Scope } from '../env';
import { MAX_TAG_FILTERS, MAX_TAG_LENGTH } from '../library/store';

export type EventName =
  | 'anymd.library.document.saved'
  | 'anymd.library.document.deleted'
  | 'anymd.library.tags.updated'
  | 'anymd.video.ready'
  | 'anymd.video.failed'
  | 'anymd.video.analysis.ready'
  | 'anymd.video.analysis.failed'
  | 'anymd.feedback.status.changed';

const ids = (what: string) => z.array(z.string().min(1).max(64)).max(50).optional().describe(`Only these ${what} ids (omit for all of yours)`);
const excludeSelf = z.boolean().optional().describe('Skip changes made with the credential that subscribed (default true), so an agent does not react to its own writes');
const correlation = z.string().nullable().describe('Request id of the change, when it came from a request');
const version = z.number().int().describe('Monotonic version of the resource (its last-change time in ms)');

const libraryArgs = z.strictObject({
  document_ids: ids('document'),
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAG_FILTERS).optional().describe('Only documents carrying every one of these tags when the event is matched to subscriptions, shortly after the change'),
  domain: z.string().max(253).optional().describe('Only documents from this domain, e.g. example.com'),
  exclude_self: excludeSelf,
});
const deletedArgs = z.strictObject({ document_ids: ids('document'), exclude_self: excludeSelf });
const videoArgs = z.strictObject({ job_ids: ids('video job') });
const feedbackArgs = z.strictObject({ feedback_ids: ids('feedback') });

const documentPayload = z.object({
  document_id: z.string(),
  resource_type: z.literal('document'),
  change: z.enum(['created', 'updated']),
  version,
  correlation_id: correlation,
});
const deletedPayload = z.object({ document_id: z.string(), resource_type: z.literal('document'), version, correlation_id: correlation });
const tagsPayload = z.object({ document_id: z.string(), resource_type: z.literal('document'), tag_count: z.number().int(), version, correlation_id: correlation });
const videoPayload = z.object({
  job_id: z.string(),
  resource_type: z.literal('video_job'),
  status: z.enum(['ready', 'failed']),
  error_code: z.string().optional().describe('Why it failed, the same code get_video_download reports'),
  version,
  correlation_id: correlation,
});
const feedbackPayload = z.object({
  feedback_id: z.string(),
  resource_type: z.literal('feedback'),
  status: z.enum(['created', 'needs_review', 'failed']),
  issue_number: z.number().int().optional().describe('The public GitHub issue, once created'),
  version,
  correlation_id: correlation,
});

export interface EventDef {
  name: EventName;
  description: string;
  scope: Scope;
  args: z.ZodType<Record<string, unknown>>;
  payload: z.ZodType;
  /** Library events record which credential made the change, so `exclude_self` can skip it. */
  selfExcludable: boolean;
}

export const EVENTS: EventDef[] = [
  {
    name: 'anymd.library.document.saved',
    description: 'A document in your library was created or its content changed (a re-read with unchanged content does not fire).',
    scope: 'library:read',
    args: libraryArgs,
    payload: documentPayload,
    selfExcludable: true,
  },
  {
    name: 'anymd.library.document.deleted',
    description: 'A document was deleted from your library.',
    scope: 'library:read',
    args: deletedArgs,
    payload: deletedPayload,
    selfExcludable: true,
  },
  {
    name: 'anymd.library.tags.updated',
    description: "A document's tags changed (an edit that changes nothing does not fire).",
    scope: 'library:read',
    args: libraryArgs.omit({ domain: true }),
    payload: tagsPayload,
    selfExcludable: true,
  },
  { name: 'anymd.video.ready', description: 'A YouTube video download you started is ready on the CDN.', scope: 'convert', args: videoArgs, payload: videoPayload, selfExcludable: false },
  { name: 'anymd.video.failed', description: 'A YouTube video download you started failed for good.', scope: 'convert', args: videoArgs, payload: videoPayload, selfExcludable: false },
  { name: 'anymd.video.analysis.ready', description: 'The AI analysis of one of your downloaded videos is ready.', scope: 'convert', args: videoArgs, payload: videoPayload, selfExcludable: false },
  { name: 'anymd.video.analysis.failed', description: 'The AI analysis of one of your videos failed for good.', scope: 'convert', args: videoArgs, payload: videoPayload, selfExcludable: false },
  {
    name: 'anymd.feedback.status.changed',
    description: 'Feedback you submitted reached a new public status (created as a GitHub issue, held for review, or failed). Subscribing never submits feedback.',
    scope: 'feedback:write',
    args: feedbackArgs,
    payload: feedbackPayload,
    selfExcludable: false,
  },
];

export const EVENT_BY_NAME = new Map(EVENTS.map((e) => [e.name, e]));

const schemas = new Map(EVENTS.map((e) => [e.name, { input: z.toJSONSchema(e.args, { io: 'input' }), payload: z.toJSONSchema(e.payload, { io: 'output' }) }]));

/** The `events/list` descriptor of one event. */
export function eventDescriptor(e: EventDef) {
  const s = schemas.get(e.name)!;
  return { name: e.name, description: e.description, delivery: ['webhook'], inputSchema: s.input, payloadSchema: s.payload, _meta: { 'anymd/scope': e.scope } };
}

/** Library events every library write may fire; checked together before a write. */
export const LIBRARY_EVENTS: EventName[] = ['anymd.library.document.saved', 'anymd.library.document.deleted', 'anymd.library.tags.updated'];
