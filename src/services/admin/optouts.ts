/**
 * Site opt-outs: domains whose owners asked us not to fetch them. Reading needs `optouts:read`,
 * changes need `optouts:write`; every change is audited and takes effect on the next conversion.
 */
import { z } from 'zod';
import { normalizeOptoutDomain, type SiteOptout } from '../../convert/optouts';
import type { Env, Principal } from '../../env';
import { now } from '../../lib/util';
import { auditStatement } from './audit';
import { withIdempotency } from './idempotency';
import { AdminError, assertScope, clampLimit, decodeCursor, encodeCursor, IdempotencyKey, likePattern, parseInput, type Paged } from './shared';

export const OptoutQuery = z.object({
  search: z.string().max(200).optional().describe('Part of a domain'),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export async function listSiteOptouts(env: Env, actor: Principal, raw: unknown): Promise<Paged<SiteOptout> & { total: number }> {
  assertScope(actor, 'optouts:read');
  const q = parseInput(OptoutQuery, raw);
  const limit = clampLimit(q.limit, 50, 200);
  const parts: string[] = [];
  const binds: unknown[] = [];
  const term = q.search?.trim().toLowerCase();
  if (term) parts.push("domain LIKE ? ESCAPE '\\'"), binds.push(likePattern(term));
  const filter = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  const cursor = decodeCursor(q.cursor);
  const keyset = cursor ? `${filter ? `${filter} AND` : 'WHERE'} (created_at < ? OR (created_at = ? AND domain < ?))` : filter;
  const [rows, count] = await Promise.all([
    env.DB.prepare(`SELECT * FROM site_optouts ${keyset} ORDER BY created_at DESC, domain DESC LIMIT ?`)
      .bind(...binds, ...(cursor ? [cursor.ts, cursor.ts, cursor.id] : []), limit + 1)
      .all<SiteOptout>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM site_optouts ${filter}`).bind(...binds).first<{ n: number }>(),
  ]);
  const more = rows.results.length > limit;
  const items = more ? rows.results.slice(0, limit) : rows.results;
  const last = items[items.length - 1];
  return { items, next_cursor: more && last ? encodeCursor(last.created_at, last.domain) : null, total: count?.n ?? 0 };
}

function domainOr422(input: string): string {
  const domain = normalizeOptoutDomain(input);
  if (!domain) throw new AdminError('Enter a domain such as example.com.', 422, 'invalid_domain');
  return domain;
}

export const AddOptoutInput = z.object({
  domain: z.string().min(1).max(300).describe('Domain or URL; covers every subdomain'),
  reason: z.string().trim().max(300).optional(),
  idempotencyKey: IdempotencyKey.optional(),
});

/** Block a domain (and its subdomains). Adding an existing domain updates its reason. */
export async function addSiteOptout(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'optouts:write');
  const input = parseInput(AddOptoutInput, raw);
  const domain = domainOr422(input.domain);
  const reason = input.reason ?? '';
  return withIdempotency(env, actor, 'optout.add', input.idempotencyKey, { domain, reason }, async () => {
    const prior = await env.DB.prepare('SELECT * FROM site_optouts WHERE domain = ?').bind(domain).first<SiteOptout>();
    const ts = now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO site_optouts (domain, reason, created_by, created_at) VALUES (?,?,?,?) ON CONFLICT(domain) DO UPDATE SET reason = excluded.reason').bind(domain, reason, actor.userId, ts),
      auditStatement(env, actor, { action: 'optout.add', targetType: 'domain', target: domain, diff: prior ? { reason: { from: prior.reason, to: reason } } : { created: true }, meta: { reason }, idempotencyKey: input.idempotencyKey }, ts),
    ]);
    return { domain, existed: Boolean(prior), reason };
  });
}

export const RemoveOptoutInput = z.object({ domain: z.string().min(1).max(300), idempotencyKey: IdempotencyKey.optional() });

/** Unblock a domain. Removing a domain that is not blocked reports `existed: false` and writes nothing. */
export async function removeSiteOptout(env: Env, actor: Principal, raw: unknown) {
  assertScope(actor, 'optouts:write');
  const input = parseInput(RemoveOptoutInput, raw);
  const domain = domainOr422(input.domain);
  return withIdempotency(env, actor, 'optout.remove', input.idempotencyKey, { domain }, async () => {
    const prior = await env.DB.prepare('SELECT * FROM site_optouts WHERE domain = ?').bind(domain).first<SiteOptout>();
    if (!prior) return { domain, existed: false };
    const ts = now();
    const [del] = await env.DB.batch([
      env.DB.prepare('DELETE FROM site_optouts WHERE domain = ?').bind(domain),
      auditStatement(env, actor, { action: 'optout.remove', targetType: 'domain', target: domain, diff: { removed: { reason: prior.reason, created_at: prior.created_at } }, idempotencyKey: input.idempotencyKey }, ts, {
        sql: 'NOT EXISTS (SELECT 1 FROM site_optouts WHERE domain = ?)',
        binds: [domain],
      }),
    ]);
    return { domain, existed: Boolean(del.meta.changes) };
  });
}
