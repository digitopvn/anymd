import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppBindings, Env, Principal } from '../src/env';
import { api } from '../src/routes/api';
import { dashboardRoutes } from '../src/routes/dashboard';
import { buildOpenApi } from '../src/openapi';
import { DEFAULT_READING_PREFERENCES } from '../src/lib/reading-options';
import { ReadingOptionsFields } from '../src/views/components/reading-options-fields';
import { ReadingPreferencesSection } from '../src/views/reading-preferences-section';
import { AccountPage, OverviewPage, TraceDetailPage } from '../src/views/dashboard';
import type { UserRow } from '../src/auth/identity';
import { conversionDatabase, d1, type SqliteDatabase } from './helpers/sqlite-d1';

const user: Principal = { kind: 'api_key', userId: 'u1', role: 'user', scopes: ['convert', 'keys:manage'], apiKeyId: 'key_full' };
const convertOnly: Principal = { kind: 'api_key', userId: 'u1', role: 'user', scopes: ['convert'], apiKeyId: 'key_convert' };
const execution = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
let db: SqliteDatabase | null = null;

function client(principal: Principal) {
  db = conversionDatabase();
  db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
  const env = { DB: d1(db), RL_AUTH: { limit: async () => ({ success: true }) }, RL_ANON: { limit: async () => ({ success: true }) } } as unknown as Env;
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => { c.set('principal', principal); await next(); });
  app.route('/api/v1', api);
  return (method: string, body?: unknown) => app.fetch(new Request('https://anymd.cc/api/v1/account/reading-preferences', {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), env, execution);
}

afterEach(() => { db?.close(); db = null; });

describe('REST reading preferences', () => {
  it('returns the safe defaults when nothing is saved', async () => {
    const res = await client(user)('GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ preferences: DEFAULT_READING_PREFERENCES, saved: false, updated_at: null });
  });

  it('partially updates, persists per user, and resets', async () => {
    const call = client(user);
    const put = await call('PUT', { expandThread: true, maxThreadPosts: 30 });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ saved: true, preferences: { ...DEFAULT_READING_PREFERENCES, expandThread: true, maxThreadPosts: 30 } });
    const second = await call('PUT', { includeComments: true });
    expect(((await second.json()) as { preferences: unknown }).preferences).toMatchObject({ expandThread: true, maxThreadPosts: 30, includeComments: true });
    const reset = await call('DELETE');
    expect(await reset.json()).toMatchObject({ saved: false, preferences: DEFAULT_READING_PREFERENCES });
    expect(db!.prepare('SELECT COUNT(*) AS n FROM reading_preferences').get()).toEqual({ n: 0 });
  });

  it('rejects out-of-range, unknown and conflicting fields with field details', async () => {
    const call = client(user);
    for (const body of [{ maxThreadPosts: 0 }, { maxImages: 99 }, { surprise: true }, { keepImages: false, analyzeImages: true }]) {
      const res = await call('PUT', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      const error = ((await res.json()) as { error: { code: string; details: unknown[] } }).error;
      expect(error.code).toBe('invalid_preferences');
      expect(error.details.length).toBeGreaterThan(0);
    }
    expect((await call('PUT', '{not json')).status).toBe(400);
    expect(db!.prepare('SELECT COUNT(*) AS n FROM reading_preferences').get()).toEqual({ n: 0 });
  });

  it('requires an account and the convert scope to read', async () => {
    const anonymous = { kind: 'anonymous', userId: null, role: 'user', scopes: ['convert'] } as unknown as Principal;
    expect((await client(anonymous)('GET')).status).toBe(401);
    db?.close();
    expect((await client({ ...user, scopes: ['library:read'] })('GET')).status).toBe(403);
  });

  it('lets a convert-only key read the saved defaults but not change or reset them', async () => {
    const call = client(convertOnly);
    db!.prepare('INSERT INTO reading_preferences (user_id, preferences, updated_at) VALUES (?,?,?)').run('u1', JSON.stringify(DEFAULT_READING_PREFERENCES), 1);
    expect((await call('GET')).status).toBe(200);
    for (const res of [await call('PUT', { expandThread: true, maxCredits: 1000 }), await call('DELETE')]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'forbidden', message: 'Missing scope: keys:manage' });
    }
    expect(db!.prepare('SELECT preferences FROM reading_preferences').get()).toEqual({ preferences: JSON.stringify(DEFAULT_READING_PREFERENCES) });
    expect(db!.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual({ n: 0 });
  });

  it('audits every change with the actor, auth kind, key id and a field diff', async () => {
    const call = client(user);
    await call('PUT', { expandThread: true, maxThreadPosts: 30 });
    await call('DELETE');
    await call('DELETE'); // nothing saved any more: not a change, not audited
    const rows = db!.prepare('SELECT actor, action, target, meta FROM audit_log ORDER BY created_at, action DESC').all() as { actor: string; action: string; target: string; meta: string }[];
    expect(rows.map((r) => r.action)).toEqual(['reading_preferences.update', 'reading_preferences.reset']);
    expect(rows[0]).toMatchObject({ actor: 'api_key:u1', target: 'u1' });
    expect(JSON.parse(rows[0].meta)).toEqual({ auth: { kind: 'api_key', key_id: 'key_full' }, was_saved: false, changes: { expandThread: [false, true], maxThreadPosts: [20, 30] } });
    expect(JSON.parse(rows[1].meta)).toEqual({ auth: { kind: 'api_key', key_id: 'key_full' }, changes: { expandThread: [true, false], maxThreadPosts: [30, 20] } });
    expect(rows.some((r) => r.meta.includes('amd_'))).toBe(false);
  });

  it('keeps what the user submitted on the account form when the save is rejected, and audits a session save', async () => {
    db = conversionDatabase();
    db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
    db.exec('DROP TABLE documents; CREATE TABLE documents (id TEXT PRIMARY KEY, user_id TEXT, domain TEXT, source_kind TEXT, word_count INTEGER)');
    const env = { DB: d1(db) } as unknown as Env;
    const session: Principal = { kind: 'session', userId: 'u1', role: 'user', scopes: ['convert', 'keys:manage'] };
    const app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('principal', session);
      c.set('user', { id: 'u1', email: 'a@example.com', name: 'A', role: 'user', plan: 'free', created_at: 0 } as unknown as UserRow);
      await next();
    });
    app.route('/dashboard', dashboardRoutes);
    const post = (form: Record<string, string>) => app.fetch(new Request('https://anymd.cc/dashboard/account/reading', { method: 'POST', headers: { origin: 'https://anymd.cc', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }), env, execution);

    const rejected = await post({ action: 'save', expandThread: '1', includeComments: '1', keepImages: '1', maxThreadPosts: '500', maxComments: '40', maxImages: '10', maxCredits: '100' });
    expect(rejected.status).toBe(422);
    const page = await rejected.text();
    expect(page.includes('value="500"') && page.includes('value="40"')).toBe(true);
    expect(page.includes('role="alert"')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reading_preferences').get()).toEqual({ n: 0 });

    const saved = await post({ action: 'save', includeComments: '1', keepImages: '1', maxThreadPosts: '20', maxComments: '40', maxImages: '10', maxCredits: '100' });
    expect(saved.status).toBe(303);
    const audit = db.prepare('SELECT actor, meta FROM audit_log').all() as { actor: string; meta: string }[];
    expect(audit.length).toBe(1);
    expect(audit[0].actor).toBe('session:u1');
    expect(JSON.parse(audit[0].meta)).toMatchObject({ auth: { kind: 'session' }, changes: { includeComments: [false, true], maxComments: [100, 40] } });
  });

  it('is described in the OpenAPI document', () => {
    const spec = buildOpenApi('https://anymd.cc');
    const path = spec.paths['/account/reading-preferences'] as Record<string, unknown>;
    expect(Object.keys(path).sort()).toEqual(['delete', 'get', 'put']);
    const convertBody = JSON.stringify(spec.paths['/convert']);
    expect(convertBody.includes('expandThread') && convertBody.includes('maxThreadPosts')).toBe(true);
  });
});

describe('reading options UI', () => {
  const html = (node: unknown) => String(node);

  it('labels every control, separates base from extra-credit options and marks prices', () => {
    const out = html(<ReadingOptionsFields values={DEFAULT_READING_PREFERENCES} idPrefix="t" imagesName="images" />);
    for (const id of ['keep-images', 'expand-thread', 'max-thread-posts', 'include-comments', 'max-comments', 'analyze-images', 'max-images', 'max-credits']) {
      expect(out.includes(`id="t-${id}"`), id).toBe(true);
      expect(out.includes(`for="t-${id}"`), id).toBe(true);
    }
    expect(out.includes('Base conversion · no extra credits')).toBe(true);
    expect(out.includes('may use extra credits, off by default')).toBe(true);
    expect(out.includes('aria-describedby="t-expand-thread-hint"')).toBe(true);
    expect(out.includes('per additional X thread post')).toBe(true);
    expect(out.includes('data-requires="expandThread"')).toBe(true);
    expect(out.includes('aria-live="polite"')).toBe(true);
    // Safe defaults: only the free image retention toggle starts checked.
    expect(out.match(/checked=""/g)?.length).toBe(1);
    // The converter sends every toggle explicitly: each checkbox is followed by a hidden `0` fallback.
    for (const name of ['images', 'expandThread', 'includeComments', 'analyzeImages']) {
      const box = out.indexOf(`type="checkbox" name="${name}" value="1"`);
      expect(box, name).toBeGreaterThan(-1);
      expect(out.indexOf(`<input type="hidden" name="${name}" value="0"/>`), name).toBeGreaterThan(box);
    }
    // The account form saves absence as off, so it has no fallbacks.
    const account = html(<ReadingOptionsFields values={DEFAULT_READING_PREFERENCES} idPrefix="a" imagesName="keepImages" />);
    expect(account.includes('type="hidden"')).toBe(false);
  });

  it('re-renders submitted values after a rejected save', () => {
    const stored = { preferences: DEFAULT_READING_PREFERENCES, saved: true, updatedAt: 1 };
    const out = html(<ReadingPreferencesSection stored={stored} error="maxThreadPosts must be an integer from 1 to 100" submitted={{ ...DEFAULT_READING_PREFERENCES, expandThread: true, includeComments: true, maxThreadPosts: '500' }} />);
    expect(out.includes('value="500"')).toBe(true);
    expect(out.match(/checked=""/g)?.length).toBe(3);
  });

  it('renders the account section with a CSRF-safe same-origin form and status messages', () => {
    const out = html(<ReadingPreferencesSection stored={{ preferences: { ...DEFAULT_READING_PREFERENCES, expandThread: true }, saved: true, updatedAt: Date.UTC(2026, 9, 9) }} error="bad value" />);
    expect(out.includes('id="reading-defaults"')).toBe(true);
    expect(out.includes('action="/dashboard/account/reading"')).toBe(true);
    expect(out.includes('method="post"')).toBe(true);
    expect(out.includes('role="alert"')).toBe(true);
    expect(out.includes('name="keepImages"')).toBe(true);
    expect(out.includes('Reset to safe defaults')).toBe(true);
  });

  it('renders the account page section, the prefilled dashboard converter and trace credit sources', () => {
    const account = { id: 'u1', email: 'a@example.com', name: 'A', role: 'user', plan: 'free', created_at: 0 } as unknown as UserRow;
    const saved = { preferences: { ...DEFAULT_READING_PREFERENCES, includeComments: true }, saved: true, updatedAt: 1 };
    expect(html(<AccountPage user={account} docs={0} reading={{ stored: saved }} />).includes('Deep reading defaults')).toBe(true);
    const quota = { plan: 'free', included: 500, extra: 0, used: 0, remaining: 500, overage: false };
    const overview = html(<OverviewPage user={account} quota={quota} docs={0} words={0} recent={[]} month={{ conversions: 0, errors: 0 }} keyCount={0} origin="https://anymd.cc" reading={saved} />);
    expect(overview.includes('data-reading-source="saved"')).toBe(true);
    expect(overview.includes('Prefilled from your saved reading defaults')).toBe(true);
    const trace = html(<TraceDetailPage trace={{ id: 't', kind: 'convert', target: 'https://x.com/a/status/1', status: 'ok', duration_ms: 5, spans: '[]', created_at: 0,
      meta: JSON.stringify({ credit_breakdown: { base: 1, thread: 4, comments: 0, images: 0 }, reading_options: { expandThread: true, sources: { expandThread: 'preference' } } }) }} />);
    expect(trace.includes('X thread posts')).toBe(true);
    expect(trace.includes('saved default')).toBe(true);
  });
});
