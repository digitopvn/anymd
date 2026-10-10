/**
 * User-scoped reading preferences and the one precedence rule every channel uses:
 * explicit request option > signed-in user's saved preference > safe system default (enrichment off).
 */
import { z } from 'zod';
import type { Env, Principal, Scope } from '../env';
import { DEFAULT_READING_PREFERENCES, READING_LIMITS, type ReadingLimitKey, type ReadingPreferences } from '../lib/reading-options';
import { auditStatement } from '../services/admin/audit';
import { ConvertError } from './types';

const boundedInt = (key: ReadingLimitKey) => {
  const { min, max } = READING_LIMITS[key];
  const message = `${key} must be an integer from ${min} to ${max}`;
  return z.number({ error: message }).int({ error: message }).min(min, { error: message }).max(max, { error: message });
};
const flag = (key: string) => z.boolean({ error: `${key} must be true or false` });

const fields = {
  expandThread: flag('expandThread'),
  maxThreadPosts: boundedInt('maxThreadPosts'),
  includeComments: flag('includeComments'),
  maxComments: boundedInt('maxComments'),
  keepImages: flag('keepImages'),
  analyzeImages: flag('analyzeImages'),
  maxImages: boundedInt('maxImages'),
  maxCredits: boundedInt('maxCredits'),
  downloadVideo: flag('downloadVideo'),
};

const IMAGE_CONFLICT = 'analyzeImages requires keepImages: image analysis reads the images the conversion keeps';

export const ReadingPreferencesSchema = z.strictObject(fields).refine((p) => !(p.analyzeImages && !p.keepImages), { error: IMAGE_CONFLICT, path: ['analyzeImages'] });

/** A partial update: omitted fields keep their saved value. Unknown keys are rejected. */
export const ReadingPreferencesPatchSchema = z.strictObject(fields).partial();
export type ReadingPreferencesPatch = z.infer<typeof ReadingPreferencesPatchSchema>;

export class ReadingPreferencesError extends Error {
  readonly status = 422;
  readonly code = 'invalid_preferences';
  constructor(readonly details: { path: string; message: string }[]) {
    super(details.map((d) => d.message).join('; ') || 'Invalid reading preferences');
  }
}

function issues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}

/** Validates a partial update against the current preferences. Out-of-range values are rejected, never clamped. */
export function applyPreferencesPatch(current: ReadingPreferences, patch: unknown): ReadingPreferences {
  const parsed = ReadingPreferencesPatchSchema.safeParse(patch);
  if (!parsed.success) throw new ReadingPreferencesError(issues(parsed.error));
  const merged = ReadingPreferencesSchema.safeParse({ ...current, ...parsed.data });
  if (!merged.success) throw new ReadingPreferencesError(issues(merged.error));
  return merged.data;
}

/**
 * Stored JSON is read leniently but deterministically: a value outside today's bounds is clamped,
 * anything malformed falls back to the safe default, and image analysis without kept images is off.
 */
export function normalizeStoredPreferences(raw: string | null | undefined): ReadingPreferences {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Corrupt rows read as the safe default rather than failing every conversion.
  }
  const out: ReadingPreferences = { ...DEFAULT_READING_PREFERENCES };
  for (const key of ['expandThread', 'includeComments', 'keepImages', 'analyzeImages', 'downloadVideo'] as const) {
    if (typeof data[key] === 'boolean') out[key] = data[key];
  }
  for (const key of Object.keys(READING_LIMITS) as ReadingLimitKey[]) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.min(READING_LIMITS[key].max, Math.max(READING_LIMITS[key].min, Math.round(value)));
  }
  if (out.analyzeImages && !out.keepImages) out.analyzeImages = false;
  return out;
}

export interface StoredReadingPreferences {
  preferences: ReadingPreferences;
  /** False when the user never saved preferences: the safe defaults apply. */
  saved: boolean;
  updatedAt: number | null;
}

export async function getReadingPreferences(env: Env, userId: string): Promise<StoredReadingPreferences> {
  const row = await env.DB.prepare('SELECT preferences, updated_at FROM reading_preferences WHERE user_id = ?').bind(userId).first<{ preferences: string; updated_at: number }>();
  return row
    ? { preferences: normalizeStoredPreferences(row.preferences), saved: true, updatedAt: row.updated_at }
    : { preferences: { ...DEFAULT_READING_PREFERENCES }, saved: false, updatedAt: null };
}

type PreferencesDiff = Partial<Record<keyof ReadingPreferences, [unknown, unknown]>>;

/** Field-level `[before, after]` pairs for the values that changed. */
export function preferencesDiff(before: ReadingPreferences, after: ReadingPreferences): PreferencesDiff {
  const out: PreferencesDiff = {};
  for (const key of Object.keys(after) as (keyof ReadingPreferences)[]) if (before[key] !== after[key]) out[key] = [before[key], after[key]];
  return out;
}

/**
 * Saved defaults decide what other credentials of the account may spend, so every change is
 * audited through the shared audit log: who (auth kind plus key/client id, never a secret), through
 * which adapter and request, and which fields changed. The row commits with the change.
 */
function preferenceAudit(env: Env, actor: Principal, action: string, meta: Record<string, unknown>, ts: number, guard?: { sql: string; binds: unknown[] }) {
  const auth: Record<string, string> = { kind: actor.kind };
  if (actor.apiKeyId) auth.key_id = actor.apiKeyId;
  if (actor.clientId) auth.client_id = actor.clientId;
  return auditStatement(env, actor, { action, targetType: 'reading_preferences', target: actor.userId ?? '', meta: { auth, ...meta } }, ts, guard);
}

/** The scope an API key or OAuth grant needs to change saved reading defaults. */
export const PREFERENCES_WRITE_SCOPE: Scope = 'keys:manage';

/**
 * Who may change an account's saved reading defaults. A signed-in session of any role is the user
 * acting directly on their own account, so it always may. An API key or OAuth grant needs
 * `keys:manage`: saved defaults decide what every other credential of the account spends, so a
 * "Convert only" or library key, or a default OAuth grant, must not raise them.
 */
export function canWriteReadingPreferences(actor: Principal): boolean {
  return Boolean(actor.userId) && (actor.kind === 'session' || actor.scopes.includes(PREFERENCES_WRITE_SCOPE));
}

/** Raised when a credential without `keys:manage` tries to change saved defaults. */
export class ReadingPreferencesForbiddenError extends Error {
  readonly status = 403;
  readonly code = 'forbidden';
  readonly required = [PREFERENCES_WRITE_SCOPE];
  constructor() {
    super(`Missing scope: ${PREFERENCES_WRITE_SCOPE}`);
  }
}

function accountOf(actor: Principal): string {
  if (!actor.userId) throw new ReadingPreferencesError([{ path: '(root)', message: 'Reading preferences belong to an account' }]);
  return actor.userId;
}

/** The writer's account id, after the write guard; every save and reset goes through it. */
function writableAccountOf(actor: Principal): string {
  const userId = accountOf(actor);
  if (!canWriteReadingPreferences(actor)) throw new ReadingPreferencesForbiddenError();
  return userId;
}

/** Saves the actor's own defaults on top of `previous` (what the caller read) and audits the change. */
export async function saveReadingPreferences(env: Env, actor: Principal, previous: StoredReadingPreferences, preferences: ReadingPreferences): Promise<StoredReadingPreferences> {
  const userId = writableAccountOf(actor);
  const valid = ReadingPreferencesSchema.parse(preferences);
  const ts = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO reading_preferences (user_id, preferences, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at').bind(userId, JSON.stringify(valid), ts),
    preferenceAudit(env, actor, 'reading_preferences.update', { was_saved: previous.saved, changes: preferencesDiff(previous.preferences, valid) }, ts),
  ]);
  return { preferences: valid, saved: true, updatedAt: ts };
}

/** Deletes the actor's saved defaults (back to the safe defaults); audited when something was saved. */
export async function resetReadingPreferences(env: Env, actor: Principal): Promise<StoredReadingPreferences> {
  const userId = writableAccountOf(actor);
  const saved = await env.DB.prepare('SELECT preferences FROM reading_preferences WHERE user_id = ?').bind(userId).first<{ preferences: string }>();
  if (saved) {
    // The audit row is guarded by the row it describes, so a concurrent reset cannot audit twice.
    const audit = preferenceAudit(env, actor, 'reading_preferences.reset', { changes: preferencesDiff(normalizeStoredPreferences(saved.preferences), DEFAULT_READING_PREFERENCES) }, Date.now(), {
      sql: 'EXISTS (SELECT 1 FROM reading_preferences WHERE user_id = ?)',
      binds: [userId],
    });
    await env.DB.batch([audit, env.DB.prepare('DELETE FROM reading_preferences WHERE user_id = ?').bind(userId)]);
  }
  return { preferences: { ...DEFAULT_READING_PREFERENCES }, saved: false, updatedAt: null };
}

// ─── Precedence ───────────────────────────────────────────────────────────────

/** What a single request may say explicitly. `undefined` means "not specified". */
export interface RequestReadingOptions {
  expandThread?: boolean;
  maxThreadPosts?: number;
  includeComments?: boolean;
  maxComments?: number;
  analyzeImages?: boolean;
  maxImages?: number;
  maxCredits?: number;
  removeImages?: boolean;
}

export type OptionSource = 'request' | 'preference' | 'default';

export interface ResolvedReadingOptions {
  expandThread: boolean;
  maxThreadPosts: number;
  includeComments: boolean;
  maxComments: number;
  analyzeImages: boolean;
  maxImages: number;
  maxCredits: number;
  removeImages: boolean;
  /** Where each effective value came from, recorded in traces so charges are explainable. */
  sources: Record<Exclude<keyof ResolvedReadingOptions, 'sources'>, OptionSource>;
}

/**
 * Applies `request > preference > default` field by field. `preferences` is null for anonymous
 * callers and for users who never saved any. When an explicit option conflicts with a saved one
 * (image analysis vs. removed images), the explicit option wins; two explicit conflicting options
 * are rejected.
 */
export function resolveReadingOptions(request: RequestReadingOptions, preferences: ReadingPreferences | null): ResolvedReadingOptions {
  const base = preferences ?? DEFAULT_READING_PREFERENCES;
  const fallback: OptionSource = preferences ? 'preference' : 'default';
  const sources = {} as ResolvedReadingOptions['sources'];
  const pick = <K extends 'expandThread' | 'maxThreadPosts' | 'includeComments' | 'maxComments' | 'analyzeImages' | 'maxImages' | 'maxCredits'>(key: K): ReadingPreferences[K] => {
    const explicit = request[key];
    sources[key] = explicit !== undefined ? 'request' : fallback;
    return (explicit !== undefined ? explicit : base[key]) as ReadingPreferences[K];
  };
  const resolved = {
    expandThread: pick('expandThread'),
    maxThreadPosts: pick('maxThreadPosts'),
    includeComments: pick('includeComments'),
    maxComments: pick('maxComments'),
    analyzeImages: pick('analyzeImages'),
    maxImages: pick('maxImages'),
    maxCredits: pick('maxCredits'),
    removeImages: request.removeImages ?? !base.keepImages,
    sources,
  };
  sources.removeImages = request.removeImages !== undefined ? 'request' : fallback;
  if (resolved.analyzeImages && resolved.removeImages) {
    if (sources.analyzeImages === 'request' && sources.removeImages === 'request') {
      throw new ConvertError('analyzeImages cannot be combined with removeImages', 400, 'invalid_options');
    }
    if (sources.analyzeImages === 'request') resolved.removeImages = false;
    else resolved.analyzeImages = false;
  }
  return resolved;
}

/** True when any credit-consuming enrichment is on. */
export function wantsEnrichment(o: Pick<ResolvedReadingOptions, 'expandThread' | 'includeComments' | 'analyzeImages'>): boolean {
  return o.expandThread || o.includeComments || o.analyzeImages;
}
