/**
 * Site settings. Reads need `settings:read`; writes need `settings:write`, are validated per known
 * key, versioned (optimistic concurrency through `expectedVersion`), idempotent and audited.
 */
import { z } from 'zod';
import type { Env, Principal } from '../../env';
import { invalidateSettingsCache } from '../../lib/settings';
import { now, randomToken } from '../../lib/util';
import { auditStatement } from './audit';
import { withIdempotency } from './idempotency';
import { AdminError, assertScope, IdempotencyKey, parseInput } from './shared';

/** Settings the admin screen edits. Other keys matching SETTING_KEY are accepted as plain text. */
export const SETTING_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'announcement', label: 'Announcement bar', hint: 'Plain text shown above the header on public pages. Leave empty to hide.' },
  { key: 'announcement_href', label: 'Announcement link', hint: 'Optional URL the announcement points to.' },
  { key: 'support_email', label: 'Support email', hint: 'Shown in emails and error pages.' },
];

const SETTING_KEY = /^[a-z_]{1,40}$/;
const KNOWN: Record<string, z.ZodType<string>> = {
  announcement: z.string().max(300),
  announcement_href: z.string().max(500).refine((v) => v.startsWith('/') || /^https?:\/\/[^\s]+$/i.test(v), 'Use an http(s) URL or a path starting with /'),
  support_email: z.string().max(200).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Use an email address'),
};

export const SettingsPatch = z
  .record(z.string().regex(SETTING_KEY, 'Keys are 1-40 characters of a-z and _'), z.union([z.string().max(1000), z.null()]))
  .refine((p) => Object.keys(p).length >= 1 && Object.keys(p).length <= 20, 'Send between 1 and 20 keys');

export const UpdateSettingsInput = z.object({
  patch: SettingsPatch.describe('Keys to set; an empty string or null deletes the key'),
  expectedVersion: z.number().int().min(1).optional().describe('Version from get_settings; fails with settings_conflict if it changed'),
  idempotencyKey: IdempotencyKey.optional(),
});

interface SettingsState {
  version: number;
  updated_at: number;
  updated_by: string | null;
}

async function snapshot(env: Env) {
  // One batch is one transaction: the values and the version always describe the same state.
  const [rows, states] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare('SELECT key, value FROM settings ORDER BY key'),
    env.DB.prepare('SELECT version, updated_at, updated_by FROM settings_state WHERE id = 1'),
  ]);
  const values = (rows.results ?? []) as unknown as { key: string; value: string }[];
  const state = (states.results ?? [])[0] as unknown as SettingsState | undefined;
  return { settings: Object.fromEntries(values.map((r) => [r.key, r.value])) as Record<string, string>, version: state?.version ?? 1, updated_at: state?.updated_at || null, updated_by: state?.updated_by ?? null };
}

export async function readSettings(env: Env, actor: Principal) {
  assertScope(actor, 'settings:read');
  return { ...(await snapshot(env)), fields: SETTING_FIELDS.map((f) => f.key) };
}

/** Values are trimmed; empty or null deletes the key. Known keys are validated by type. */
function normalize(patch: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const value = raw?.trim() ?? '';
    if (!value) {
      out[key] = null;
      continue;
    }
    const check = KNOWN[key]?.safeParse(value);
    if (check && !check.success) throw new AdminError(`Invalid value for ${key}: ${check.error.issues[0]?.message}`, 422, 'invalid_setting', { key });
    out[key] = value;
  }
  return out;
}

export async function updateSettings(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'settings:write');
  const input = parseInput(UpdateSettingsInput, raw);
  const patch = normalize(input.patch);
  return withIdempotency(env, actor, 'settings.update', input.idempotencyKey, { patch, expectedVersion: input.expectedVersion ?? null }, async () => {
    const before = await snapshot(env);
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
      throw new AdminError(`Settings conflict: version is ${before.version}, you sent ${input.expectedVersion}. Re-read with get_settings and retry.`, 409, 'settings_conflict', { currentVersion: before.version });
    }
    const diff: Record<string, { from: string | null; to: string | null }> = {};
    for (const [key, value] of Object.entries(patch)) if ((before.settings[key] ?? null) !== value) diff[key] = { from: before.settings[key] ?? null, to: value };
    if (!Object.keys(diff).length) return { settings: before.settings, version: before.version, changed: [] as string[] };

    const ts = now();
    const token = randomToken(12);
    // Every statement after the version bump only applies when this write won the bump.
    const won = 'EXISTS (SELECT 1 FROM settings_state WHERE id = 1 AND write_token = ?)';
    const stmts = [
      env.DB.prepare('UPDATE settings_state SET version = version + 1, write_token = ?, updated_at = ?, updated_by = ? WHERE id = 1 AND version = ?').bind(token, ts, actor.userId, before.version),
      ...Object.entries(diff).map(([key, { to }]) =>
        to === null
          ? env.DB.prepare(`DELETE FROM settings WHERE key = ? AND ${won}`).bind(key, token)
          : env.DB.prepare(`INSERT INTO settings (key,value,updated_at) SELECT ?,?,? WHERE ${won} ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(key, to, ts, token),
      ),
      auditStatement(env, actor, { action: 'settings.update', targetType: 'settings', target: 'site', diff, meta: { version: before.version + 1 }, idempotencyKey: input.idempotencyKey }, ts, { sql: won, binds: [token] }),
    ];
    const [bump] = await env.DB.batch(stmts);
    if (!bump.meta.changes) throw new AdminError('Settings conflict: another admin saved meanwhile. Re-read and retry.', 409, 'settings_conflict');
    await invalidateSettingsCache(env);
    const after = await snapshot(env);
    return { settings: after.settings, version: after.version, changed: Object.keys(diff) };
  });
}
