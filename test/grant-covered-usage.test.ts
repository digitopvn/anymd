import { afterEach, describe, expect, it, vi } from 'vitest';
import { meteredUnits, usedBeforeCharge } from '../src/billing/grant-covered-usage';
import { ingestPolarUsage } from '../src/billing/polar';
import { getPlan } from '../src/billing/plans';
import type { Env } from '../src/env';
import { conversionDatabase, d1, type SqliteDatabase } from './helpers/sqlite-d1';

describe('meteredUnits: included credits, then grants, then paid overage', () => {
  const window = { included: 100, granted: 50 };

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
    expect(meteredUnits({ usedBefore, credits, ...window })).toBe(expected);
  });

  it('meters everything when there is no grant, and nothing for a free conversion', () => {
    expect(meteredUnits({ usedBefore: 100, credits: 7, included: 100, granted: 0 })).toBe(7);
    expect(meteredUnits({ usedBefore: 120, credits: 0, ...window })).toBe(0);
  });

  it('never meters more than the conversion spent', () => {
    for (let usedBefore = 0; usedBefore < 200; usedBefore += 7) {
      for (const credits of [1, 3, 25, 60]) {
        const units = meteredUnits({ usedBefore, credits, ...window });
        expect(units).toBeGreaterThanOrEqual(0);
        expect(units).toBeLessThanOrEqual(credits);
      }
    }
  });
});

describe('Polar ingestion with credit grants', () => {
  let db: SqliteDatabase | null = null;
  afterEach(() => {
    db?.close();
    db = null;
    vi.unstubAllGlobals();
  });

  function setup() {
    db = conversionDatabase();
    db.prepare('INSERT INTO users (id, plan) VALUES (?, ?)').run('u1', 'pro');
    const env = { DB: d1(db), BILLING_PROVIDER: 'polar', POLAR_ACCESS_TOKEN: 'test-placeholder' } as unknown as Env;
    const sent: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).events[0].metadata.credits);
      return new Response('{}', { status: 200 });
    }));
    return { db, env, sent };
  }

  const included = getPlan('pro').credits;
  const charge = (id: string, credits: number, createdAt: number) =>
    db!.prepare('INSERT INTO conversion_charges (id,user_id,reserved,credits,settled,created_at,expires_at) VALUES (?,?,?,?,1,?,?)').run(id, 'u1', credits, credits, createdAt, createdAt + 300_000);

  it('locates a conversion by its charge and skips the units a grant covers', async () => {
    const { db, env, sent } = setup();
    const t = Date.now();
    db.prepare('INSERT INTO credit_grants (id,user_id,credits,expires_at) VALUES (?,?,?,?)').run('g1', 'u1', 20, t + 86_400_000);
    charge('c_before', included - 5, t - 2);
    charge('c_now', 10, t - 1);
    charge('c_later', 30, t);
    expect(await usedBeforeCharge(env, 'u1', 10, 'c_now')).toBe(included - 5);
    await ingestPolarUsage(env, 'u1', 10, 'web', 'c_now'); // 5 included + 5 granted
    await ingestPolarUsage(env, 'u1', 30, 'web', 'c_later'); // 15 granted + 15 overage
    expect(sent).toEqual([5, 15]);
  });

  it('sends nothing when a grant covers the whole conversion, and ignores revoked grants', async () => {
    const { db, env, sent } = setup();
    const t = Date.now();
    db.prepare('INSERT INTO credit_grants (id,user_id,credits,expires_at) VALUES (?,?,?,?)').run('g1', 'u1', 100, t + 86_400_000);
    db.prepare('INSERT INTO credit_grants (id,user_id,credits,expires_at,revoked_at) VALUES (?,?,?,?,?)').run('g2', 'u1', 1000, t + 86_400_000, t - 10);
    charge('c_before', included, t - 1);
    charge('c_now', 40, t);
    await ingestPolarUsage(env, 'u1', 40, 'web', 'c_now');
    expect(sent).toEqual([]);
    charge('c_after', 70, t + 1);
    await ingestPolarUsage(env, 'u1', 70, 'web', 'c_after'); // 60 granted + 10 overage; the revoked grant counts for nothing
    expect(sent).toEqual([10]);
  });
});
