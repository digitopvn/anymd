import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scopesForRole } from '../src/auth/roles';
import type { Env, Principal } from '../src/env';
import { listSubscriptions } from '../src/services/admin/billing';
import { revokeUserOAuthGrant } from '../src/services/admin/credentials';
import { defaultGrantExpiry, grantCredits, nextMonthStart } from '../src/services/admin/credits';
import { PENDING_TTL_MS, withIdempotency } from '../src/services/admin/idempotency';
import { listSystemTraces, percentile, systemUsage } from '../src/services/admin/observability';
import { addSiteOptout } from '../src/services/admin/optouts';
import { updateSettings } from '../src/services/admin/settings';
import { AdminError } from '../src/services/admin/shared';
import { sha256 } from '../src/lib/util';
import { auditRows, createTestEnv, seedUser, type TestEnv, type TestGrant } from './helpers/sqlite-env';

const DAY = 86_400_000;
let t: TestEnv;
beforeEach(() => {
  t = createTestEnv();
});
afterEach(() => t.close());

async function owner(): Promise<Principal & { userId: string }> {
  const u = await seedUser(t, 'owner');
  return { kind: 'api_key', userId: u.id, role: 'owner', scopes: scopesForRole('owner'), apiKeyId: 'key_owner', requestId: 'req-1' };
}

/** The AdminError a call rejects with. */
async function failure(p: Promise<unknown>): Promise<AdminError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof AdminError)) throw new Error(`expected an AdminError, got ${String(err)}`);
  return err;
}

describe('system traces window', () => {
  const trace = (id: string, duration: number, createdAt: number) =>
    t.db.prepare("INSERT INTO traces (id,user_id,kind,target,status,duration_ms,created_at) VALUES (?,NULL,'convert','x','ok',?,?)").run(id, duration, createdAt);

  it('rejects a since older than 30 days and accepts one inside the window', async () => {
    const actor = await owner();
    const err = await failure(listSystemTraces(t.env, actor, { since: Date.now() - 31 * DAY }));
    expect([err.status, err.code]).toEqual([422, 'invalid_request']);
    await expect(listSystemTraces(t.env, actor, { since: Date.now() - 29 * DAY })).resolves.toMatchObject({ items: [] });
  });

  it('ranks the slowest traces of the window by duration', async () => {
    const actor = await owner();
    const ts = Date.now();
    trace('tr_fast', 10, ts - 1000);
    trace('tr_slow', 900, ts - 2000);
    trace('tr_mid', 300, ts - 3000);
    trace('tr_old', 9999, ts - 10 * DAY); // outside the default 7-day window
    const out = await listSystemTraces(t.env, actor, { sort: 'slowest' });
    expect(out.items.map((i) => i.id)).toEqual(['tr_slow', 'tr_mid', 'tr_fast']);
    expect(out.next_cursor).toBeNull();
  });
});

describe('system usage', () => {
  it('derives totals and every breakdown from one grouped pass and samples latency', async () => {
    const actor = await owner();
    const ts = Date.now();
    const ev = (id: string, channel: string, kind: string, status: string, credits: number, duration: number, apiKey: string | null, user = 'u1') =>
      t.db.prepare('INSERT INTO usage_events (id,user_id,api_key_id,channel,kind,status,credits,duration_ms,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, user, apiKey, channel, kind, status, credits, duration, status === 'error' ? 'boom' : null, ts - 1000);
    ev('e1', 'api', 'convert', 'ok', 2, 100, 'k1');
    ev('e2', 'api', 'convert', 'error', 0, 300, 'k1');
    ev('e3', 'mcp', 'search', 'cached', 0, 50, 'k1', 'u2');
    ev('e4', 'web', 'convert', 'ok', 1, 200, null, 'u2');
    const out = await systemUsage(t.env, actor, { days: 7 });
    expect(out.totals).toMatchObject({ requests: 4, credits: 3, errors: 1, cached: 1, users: 2, error_rate: 0.25 });
    expect(out.latency_ms).toMatchObject({ p50: 200, sample_size: 4 });
    expect(out.by_channel[0]).toMatchObject({ channel: 'api', n: 2, credits: 2 });
    expect(out.by_kind).toEqual([
      { kind: 'convert', n: 3, credits: 3 },
      { kind: 'search', n: 1, credits: 0 },
    ]);
    expect(out.by_source.reduce((s, r) => s + r.n, 0)).toBe(4);
    expect(out.daily.reduce((s, r) => s + r.n, 0)).toBe(4);
    expect(out.top_errors).toHaveLength(1);
  });

  it('takes nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.99)).toBe(5);
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(xs, 0.5), percentile(xs, 0.9), percentile(xs, 0.99)]).toEqual([51, 91, 100]);
  });

  it('refuses a window longer than 30 days', async () => {
    const actor = await owner();
    expect((await failure(systemUsage(t.env, actor, { days: 31 }))).status).toBe(422);
  });
});

describe('settings validation', () => {
  it('validates only the fields that change, so a legacy stored value does not block other saves', async () => {
    const actor = await owner();
    t.db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('announcement_href','javascript:alert(1)',0)").run();
    const saved = await updateSettings(t.env, actor, { patch: { announcement: 'Maintenance tonight', announcement_href: 'javascript:alert(1)' } });
    expect(saved.changed).toEqual(['announcement']);
    const err = await failure(updateSettings(t.env, actor, { patch: { announcement_href: 'javascript:alert(2)' } }));
    expect([err.status, err.code]).toEqual([422, 'invalid_setting']);
  });
});

describe('audit of large changes', () => {
  it('keeps the before and after of every key, shortening long values', async () => {
    const actor = await owner();
    const keys = 'abcdefghij'.split('').map((c) => `note_${c}`);
    await updateSettings(t.env, actor, { patch: Object.fromEntries(keys.map((k) => [k, 'x'.repeat(1000)])) });
    await updateSettings(t.env, actor, { patch: Object.fromEntries(keys.map((k) => [k, 'y'.repeat(1000)])) });
    const rows = auditRows(t, 'settings.update');
    expect(rows).toHaveLength(2);
    // Both writes may share a millisecond, so pick the second by the version it produced.
    const second = rows.find((r) => JSON.parse(String(r.meta)).version === 3)!;
    const meta = JSON.parse(String(second.meta));
    expect(String(second.meta).length).toBeLessThanOrEqual(4000);
    expect(Object.keys(meta.diff).sort()).toEqual(keys);
    expect(meta.diff.note_a.from).toMatch(/^x+… \(1000 chars\)$/);
    expect(meta.diff.note_a.to).toMatch(/^y+… \(1000 chars\)$/);
  });
});

describe('idempotent admin writes under concurrency', () => {
  it('runs a write once when the same key arrives twice at the same time', async () => {
    const actor = await owner();
    const args = { domain: 'example.com', reason: 'owner request', idempotencyKey: 'optout-1' };
    const results = await Promise.allSettled([addSiteOptout(t.env, actor, args), addSiteOptout(t.env, actor, args)]);
    // The loser either replays the winner's result or is told to retry; the write never runs twice.
    const outcomes = results.map((r) => (r.status === 'fulfilled' ? (r.value.replayed ? 'replayed' : 'ran') : `${r.reason.status} ${r.reason.code}`));
    expect(outcomes.filter((o) => o === 'ran')).toHaveLength(1);
    expect(outcomes.every((o) => ['ran', 'replayed', '409 idempotency_in_progress'].includes(o))).toBe(true);
    expect(auditRows(t, 'optout.add')).toHaveLength(1);
    const retry = await addSiteOptout(t.env, actor, args);
    expect(retry.replayed).toBe(true);
    expect(auditRows(t, 'optout.add')).toHaveLength(1);
  });

  it('makes a concurrent duplicate wait out the first run and then replay its result', async () => {
    const actor = await owner();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const claimed = new Promise<void>((r) => (started = r));
    let runs = 0;
    const run = async () => {
      runs += 1;
      started();
      await gate;
      return { value: 42 };
    };
    const first = withIdempotency(t.env, actor, 'test.op', 'k-1', { a: 1 }, run);
    // Send the duplicate only once the first request holds the claim: two in-flight payload digests
    // can finish in either order, and a duplicate that claims first would block on the gate forever.
    await Promise.race([claimed, first]);
    const second = await failure(withIdempotency(t.env, actor, 'test.op', 'k-1', { a: 1 }, run));
    expect([second.status, second.code]).toEqual([409, 'idempotency_in_progress']);
    release();
    expect(await first).toEqual({ value: 42, replayed: false });
    expect(await withIdempotency(t.env, actor, 'test.op', 'k-1', { a: 1 }, run)).toEqual({ value: 42, replayed: true });
    expect(runs).toBe(1);
  });

  it('releases the claim when the write fails, so the same key can be retried', async () => {
    const actor = await owner();
    await expect(withIdempotency(t.env, actor, 'test.op', 'k-2', {}, async () => Promise.reject(new Error('db down')))).rejects.toThrow('db down');
    expect(await withIdempotency(t.env, actor, 'test.op', 'k-2', {}, async () => ({ ok: true }))).toEqual({ ok: true, replayed: false });
  });

  it('takes over a claim abandoned by a crashed request', async () => {
    const actor = await owner();
    const hash = await sha256(JSON.stringify({ op: 'test.op', payload: {} }));
    const seed = (createdAt: number) =>
      t.db.prepare("INSERT OR REPLACE INTO idempotency_keys (key,principal,op,payload_hash,response,created_at) VALUES ('k-3',?,'test.op',?,'__pending__',?)").run(`admin:${actor.userId}`, hash, createdAt);
    seed(Date.now() - 1000); // a fresh claim is still running
    expect((await failure(withIdempotency(t.env, actor, 'test.op', 'k-3', {}, async () => ({ ok: 'too early' })))).code).toBe('idempotency_in_progress');
    seed(Date.now() - PENDING_TTL_MS - 1000); // a claim left by a crashed request
    expect(await withIdempotency(t.env, actor, 'test.op', 'k-3', {}, async () => ({ ok: 'took over' }))).toEqual({ ok: 'took over', replayed: false });
  });
});

describe('idempotency claim ownership', () => {
  /** A run that waits until the test lets it finish (or fail). */
  function gated<T>(value: T) {
    let finish!: () => void;
    let fail!: (e: Error) => void;
    const gate = new Promise<void>((res, rej) => ((finish = res), (fail = rej)));
    return { run: async () => (await gate, value), finish, fail };
  }
  const claim = (key: string) => t.db.prepare('SELECT response, created_at FROM idempotency_keys WHERE key = ?').get(key) as { response: string; created_at: number } | undefined;
  /** Waits (bounded) until the key's claim row satisfies `ok`. */
  async function until(key: string, ok: (row: { response: string; created_at: number } | undefined) => boolean) {
    for (let i = 0; i < 200 && !ok(claim(key)); i++) await new Promise((r) => setTimeout(r, 1));
    expect(ok(claim(key))).toBe(true);
  }
  /** Lets the first holder claim the key, makes its claim stale, and returns the stale token. */
  async function claimedAndStale(key: string) {
    await until(key, (row) => Boolean(row));
    t.db.prepare('UPDATE idempotency_keys SET created_at = ? WHERE key = ?').run(Date.now() - PENDING_TTL_MS - 1000, key);
    return claim(key)!.response;
  }

  it('keeps the result of the request that took over when the slow first holder finishes late', async () => {
    const actor = await owner();
    const slow = gated({ by: 'slow' });
    const fast = gated({ by: 'takeover' });
    const first = withIdempotency(t.env, actor, 'test.op', 'k-own', {}, slow.run);
    const stale = await claimedAndStale('k-own');
    const second = withIdempotency(t.env, actor, 'test.op', 'k-own', {}, fast.run);
    await until('k-own', (row) => row?.response !== stale); // taken over with a new token
    slow.finish();
    expect(await first).toEqual({ by: 'slow', replayed: false });
    // The late holder did not overwrite the claim: the new holder is still running.
    expect((await failure(withIdempotency(t.env, actor, 'test.op', 'k-own', {}, async () => ({ by: 'third' })))).code).toBe('idempotency_in_progress');
    fast.finish();
    expect(await second).toEqual({ by: 'takeover', replayed: false });
    expect(await withIdempotency(t.env, actor, 'test.op', 'k-own', {}, async () => ({ by: 'third' }))).toEqual({ by: 'takeover', replayed: true });
  });

  it('does not release the new holder claim when the old holder fails late', async () => {
    const actor = await owner();
    const slow = gated({ by: 'slow' });
    const fast = gated({ by: 'takeover' });
    const first = withIdempotency(t.env, actor, 'test.op', 'k-fail', {}, slow.run);
    const stale = await claimedAndStale('k-fail');
    const second = withIdempotency(t.env, actor, 'test.op', 'k-fail', {}, fast.run);
    await until('k-fail', (row) => row?.response !== stale); // taken over with a new token
    slow.fail(new Error('late failure'));
    await expect(first).rejects.toThrow('late failure');
    expect((await failure(withIdempotency(t.env, actor, 'test.op', 'k-fail', {}, async () => ({ by: 'third' })))).code).toBe('idempotency_in_progress');
    fast.finish();
    expect(await second).toEqual({ by: 'takeover', replayed: false });
  });
});

describe('OAuth grant revocation', () => {
  const grant: TestGrant = { id: 'gr_1', clientId: 'client_1', userId: '', scope: ['convert'], metadata: { clientName: 'Agent' }, createdAt: 1_700_000_000 };

  async function setup(provider?: Partial<Env['OAUTH_PROVIDER']>) {
    if (provider) {
      t.close();
      t = createTestEnv();
      t.env.OAUTH_PROVIDER = { ...t.env.OAUTH_PROVIDER, ...provider } as Env['OAUTH_PROVIDER'];
    }
    const actor = await owner();
    const target = await seedUser(t, 'user');
    t.grants.push({ ...grant, userId: target.id });
    return { actor, target };
  }

  it('audits a successful revocation once', async () => {
    const { actor, target } = await setup();
    expect(await revokeUserOAuthGrant(t.env, actor, { userId: target.id, grantId: 'gr_1' })).toEqual({ revoked: true });
    expect(t.grants).toHaveLength(0);
    expect(auditRows(t, 'oauth_grant.revoke')).toHaveLength(1);
    expect(auditRows(t, 'oauth_grant.revoke_failed')).toHaveLength(0);
  });

  it('answers 503, not 404, when the grant store cannot be read', async () => {
    const { actor, target } = await setup({
      async listUserGrants() {
        throw new Error('kv unavailable');
      },
    });
    const err = await failure(revokeUserOAuthGrant(t.env, actor, { userId: target.id, grantId: 'gr_1' }));
    expect([err.status, err.code]).toEqual([503, 'oauth_store_unavailable']);
    expect(auditRows(t, 'oauth_grant.revoke')).toHaveLength(0);
  });

  it('records the attempt and its failure when the store rejects the revocation', async () => {
    const { actor, target } = await setup({
      async revokeGrant() {
        throw new Error('kv write failed');
      },
    });
    const err = await failure(revokeUserOAuthGrant(t.env, actor, { userId: target.id, grantId: 'gr_1' }));
    expect([err.status, err.code]).toEqual([503, 'oauth_store_unavailable']);
    expect(auditRows(t, 'oauth_grant.revoke')).toHaveLength(1);
    const [failed] = auditRows(t, 'oauth_grant.revoke_failed');
    expect(JSON.parse(String(failed.meta)).error).toBe('kv write failed');
  });

  it('still answers 404 for a grant the user does not have', async () => {
    const { actor, target } = await setup();
    expect((await failure(revokeUserOAuthGrant(t.env, actor, { userId: target.id, grantId: 'gr_missing' }))).status).toBe(404);
  });
});

describe('credit grant expiry', () => {
  const base = { credits: 100, reason: 'support goodwill' };

  it('defaults to a grant that ends with the month (or the next one late in the month)', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'user');
    const before = Date.now();
    const out = await grantCredits(t.env, actor, { ...base, userId: target.id, idempotencyKey: 'g-default' });
    expect(out.grant.expires_at).toBe(defaultGrantExpiry(before));
    const again = await grantCredits(t.env, actor, { ...base, userId: target.id, idempotencyKey: 'g-default' });
    expect([again.replayed, again.grant.id]).toEqual([true, out.grant.id]);
  });

  it('keeps a recurring grant without expiry', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'user');
    const out = await grantCredits(t.env, actor, { ...base, userId: target.id, recurring: true, idempotencyKey: 'g-recurring' });
    expect(out.grant.expires_at).toBeNull();
    // Replaying the same key as a one-time grant is a different request.
    expect((await failure(grantCredits(t.env, actor, { ...base, userId: target.id, idempotencyKey: 'g-recurring' }))).code).toBe('idempotency_mismatch');
  });

  it('requires recurring for an expiry past the default', async () => {
    const actor = await owner();
    const target = await seedUser(t, 'user');
    const later = defaultGrantExpiry(Date.now()) + DAY;
    expect((await failure(grantCredits(t.env, actor, { ...base, userId: target.id, expiresAt: later, idempotencyKey: 'grant-later' }))).status).toBe(422);
    const out = await grantCredits(t.env, actor, { ...base, userId: target.id, expiresAt: later, recurring: true, idempotencyKey: 'grant-later' });
    expect(out.grant.expires_at).toBe(later);
  });

  it('computes the end of the month in UTC', () => {
    expect(nextMonthStart(Date.UTC(2026, 9, 9, 12))).toBe(Date.UTC(2026, 10, 1));
    expect(nextMonthStart(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
  });

  it('extends the default to the end of next month when fewer than 7 days remain', () => {
    expect(defaultGrantExpiry(Date.UTC(2026, 9, 9, 12))).toBe(Date.UTC(2026, 10, 1));
    expect(defaultGrantExpiry(Date.UTC(2026, 9, 25, 0))).toBe(Date.UTC(2026, 10, 1)); // exactly 7 days left
    expect(defaultGrantExpiry(Date.UTC(2026, 9, 25, 0, 0, 1))).toBe(Date.UTC(2026, 11, 1));
    expect(defaultGrantExpiry(Date.UTC(2026, 11, 31, 23))).toBe(Date.UTC(2027, 1, 1));
  });
});

describe('subscription listing', () => {
  it('lists newest first by creation time and pages stably', async () => {
    const actor = await owner();
    const u = await seedUser(t, 'user', { plan: 'pro' });
    const sub = (id: string, createdAt: number, updatedAt: number) =>
      t.db.prepare("INSERT INTO subscriptions (id,user_id,product_id,plan,status,created_at,updated_at) VALUES (?,?,'prod','pro','active',?,?)").run(id, u.id, createdAt, updatedAt);
    sub('s_old', 1000, 9000); // recently updated, but created first
    sub('s_mid', 2000, 2000);
    sub('s_new', 3000, 3000);
    const first = await listSubscriptions(t.env, actor, { limit: 2 });
    expect(first.items.map((s) => s.id)).toEqual(['s_new', 's_mid']);
    const rest = await listSubscriptions(t.env, actor, { limit: 2, cursor: first.next_cursor ?? undefined });
    expect(rest.items.map((s) => s.id)).toEqual(['s_old']);
  });
});
