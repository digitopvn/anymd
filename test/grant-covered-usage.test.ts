import { afterEach, describe, expect, it, vi } from 'vitest';
import { grantBands, meteredUnits, meterPeriodStart } from '../src/billing/grant-covered-usage';
import { ingestPolarUsage } from '../src/billing/polar';
import { getPlan } from '../src/billing/plans';
import { monthStart } from '../src/lib/usage';
import { createTestEnv, seedUser, type TestEnv } from './helpers/sqlite-env';

const DAY = 86_400_000;
const span = (credits: number, usedAtStart = 0, usedAtStop: number | null = null) => ({ credits, usedAtStart, usedAtStop });

describe('meteredUnits: included credits, then grants, then paid overage', () => {
  const bands = grantBands(100, [span(50)]); // [[100, 150]]

  it.each([
    // [usedBefore, credits, expected metered units]
    [0, 10, 10], // inside the plan's included credits: the meter's own benefit covers them
    [95, 5, 5], // ends exactly at the included boundary
    [95, 10, 5], // crosses into the grant band: only the included part is metered
    [100, 10, 0], // entirely covered by the grant
    [140, 10, 0], // ends exactly at the end of the grant band
    [145, 10, 5], // crosses out of the grant band into paid overage
    [150, 10, 10], // entirely paid overage
    [90, 80, 30], // spans the whole band: 10 included + 20 overage, 50 granted
  ])('used %i before, spends %i -> meters %i', (usedBefore, credits, expected) => {
    expect(meteredUnits({ usedBefore, credits, bands })).toBe(expected);
  });

  it('meters everything without a grant, and nothing for a free conversion', () => {
    expect(meteredUnits({ usedBefore: 100, credits: 7, bands: [] })).toBe(7);
    expect(meteredUnits({ usedBefore: 120, credits: 0, bands })).toBe(0);
  });

  it('never meters more than the conversion spent', () => {
    for (let usedBefore = 0; usedBefore < 200; usedBefore += 7) {
      for (const credits of [1, 3, 25, 60]) {
        const units = meteredUnits({ usedBefore, credits, bands });
        expect(units).toBeGreaterThanOrEqual(0);
        expect(units).toBeLessThanOrEqual(credits);
      }
    }
  });
});

describe('grantBands: a grant covers usage from when it was granted onward', () => {
  it('starts a late grant at the usage when it was granted, not at the included credits', () => {
    // 10,000 included; granted 5,000 when 12,000 were used: the 2,000 overage before stays billed.
    expect(grantBands(10_000, [span(5000, 12_000)])).toEqual([[12_000, 17_000]]);
    expect(meteredUnits({ usedBefore: 11_000, credits: 2000, bands: grantBands(10_000, [span(5000, 12_000)]) })).toBe(1000);
  });

  it('starts an early grant at the included credits', () => {
    expect(grantBands(100, [span(50, 30)])).toEqual([[100, 150]]);
  });

  it('chains grants oldest first without overlap', () => {
    expect(grantBands(100, [span(50), span(20, 120)])).toEqual([
      [100, 150],
      [150, 170],
    ]);
    expect(grantBands(100, [span(50), span(20, 400)])).toEqual([
      [100, 150],
      [400, 420],
    ]);
  });

  it('cuts a grant at the usage when it expired or was revoked', () => {
    expect(grantBands(100, [span(50, 0, 120), span(30, 130)])).toEqual([
      [100, 120],
      [130, 160],
    ]);
    expect(grantBands(100, [span(1000, 0, 0)])).toEqual([[100, 100]]); // revoked before any use
  });
});

describe('Polar ingestion with credit grants', () => {
  let t: TestEnv | null = null;
  afterEach(() => {
    t?.close();
    t = null;
    vi.unstubAllGlobals();
  });

  async function setup() {
    t = createTestEnv({ POLAR_ACCESS_TOKEN: 'test-placeholder' } as never);
    const user = await seedUser(t, 'user', { plan: 'pro' });
    const sent: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)).events[0].metadata.credits);
        return new Response('{}', { status: 200 });
      }),
    );
    const db = t.db;
    const charge = (id: string, credits: number, createdAt: number) =>
      db.prepare('INSERT INTO conversion_charges (id,user_id,reserved,credits,settled,created_at,expires_at) VALUES (?,?,?,?,1,?,?)').run(id, user.id, credits, credits, createdAt, createdAt + 300_000);
    const grant = (id: string, credits: number, createdAt: number, extra: { revokedAt?: number } = {}) =>
      db.prepare("INSERT INTO credit_grants (id,user_id,source,credits,created_at,expires_at,revoked_at) VALUES (?,?,'admin',?,?,?,?)").run(id, user.id, credits, createdAt, createdAt + 20 * DAY, extra.revokedAt ?? null);
    return { env: t.env, user, sent, charge, grant };
  }

  const included = getPlan('pro').credits;
  // A fixed instant mid-month keeps every row inside one calendar month.
  const mid = monthStart(Date.now()) + 10 * DAY;

  it('skips the units a grant covers, locating each conversion by its charge', async () => {
    const { env, user, sent, charge, grant } = await setup();
    grant('g1', 20, mid - 10);
    charge('c_before', included - 5, mid - 2);
    charge('c_now', 10, mid - 1);
    charge('c_later', 30, mid);
    await ingestPolarUsage(env, user.id, 10, 'web', 'c_now'); // 5 included + 5 granted
    await ingestPolarUsage(env, user.id, 30, 'web', 'c_later'); // 15 granted + 15 overage
    expect(sent).toEqual([5, 15]);
  });

  it('does not refund overage reported before the grant', async () => {
    const { env, user, sent, charge, grant } = await setup();
    charge('c_over', included + 40, mid - 20); // 40 overage, already billed
    grant('g_late', 100, mid - 10);
    charge('c_now', 150, mid);
    await ingestPolarUsage(env, user.id, 150, 'web', 'c_now'); // band starts at included + 40: 100 granted + 50 overage
    expect(sent).toEqual([50]);
  });

  it('sends nothing when a grant covers the whole conversion, and stops counting a revoked grant', async () => {
    const { env, user, sent, charge, grant } = await setup();
    grant('g1', 100, mid - 100);
    grant('g2', 1000, mid - 90, { revokedAt: mid - 80 });
    charge('c_before', included, mid - 1);
    charge('c_now', 40, mid);
    await ingestPolarUsage(env, user.id, 40, 'web', 'c_now');
    expect(sent).toEqual([]);
    charge('c_after', 70, mid + 1);
    await ingestPolarUsage(env, user.id, 70, 'web', 'c_after'); // 60 granted + 10 overage; the revoked grant covered nothing
    expect(sent).toEqual([10]);
  });

  it('positions usage within the Polar subscription period, not the calendar month', async () => {
    const { env, user, sent, charge, grant } = await setup();
    const periodStart = mid - 3 * DAY;
    t!.db
      .prepare("INSERT INTO subscriptions (id,user_id,product_id,plan,billing_interval,status,current_period_start,current_period_end,created_at,updated_at) VALUES ('sub_1',?,'prod','pro','month','active',?,?,?,?)")
      .run(user.id, periodStart, periodStart + 30 * DAY, periodStart, periodStart);
    expect(await meterPeriodStart(env, user.id, mid)).toBe(periodStart);
    expect(await meterPeriodStart(env, user.id, periodStart - 1)).toBe(monthStart(periodStart - 1));
    charge('c_prev_period', included, periodStart - DAY); // the previous Polar period: does not count
    grant('g1', 50, periodStart - 2 * DAY);
    charge('c_now', 30, mid);
    await ingestPolarUsage(env, user.id, 30, 'web', 'c_now'); // inside the new period's included credits
    expect(sent).toEqual([30]);
  });
});
