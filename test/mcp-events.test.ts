import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRow } from '../src/auth/identity';
import type { ConvertResult } from '../src/convert/types';
import type { Env, Principal } from '../src/env';
import { isPublicIpv4, isPublicIpv6, parseCallbackUrl } from '../src/events/callback-url';
import { encryptSecret, parseWebhookSecret, subscriptionId } from '../src/events/crypto';
import { MAX_ATTEMPTS, MAX_BODY_BYTES, postWebhook, processEvents, pruneEvents } from '../src/events/delivery';
import { actorHash } from '../src/events/crypto';
import { MAX_SUBSCRIPTIONS_PER_USER } from '../src/events/subscriptions';
import { deleteDocument, saveDocument, updateTags } from '../src/library/store';
import { META_PROTOCOL_VERSION, MODERN_VERSIONS } from '../src/mcp/protocol';
import { rpc, send } from './helpers/mcp-client';
import { createTestEnv, seedKey, seedUser, type TestEnv } from './helpers/sqlite-env';

const MODERN = MODERN_VERSIONS[0];
const HOOK = 'https://hooks.example.com/mcp/events';
const SECRET = `whsec_${btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)))}`;
const SECRET_2 = `whsec_${btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 200 - i)))}`;

interface Post {
  url: string;
  headers: Headers;
  body: string;
  json: Record<string, any>;
}

/** DNS-over-HTTPS and webhook receivers in memory. A receiver echoes verification challenges unless told otherwise. */
function fakeNet() {
  const dns = new Map<string, string[]>([
    ['hooks.example.com', ['93.184.216.34', '2606:2800:220:1::248']],
    ['other.example.net', ['93.184.216.35']],
  ]);
  const posts: Post[] = [];
  let reply: (post: Post) => Response | Promise<Response> = (post) => (post.json.type === 'verification' ? Response.json({ challenge: post.json.challenge }) : new Response(null, { status: 204 }));
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name')!;
      const type = url.searchParams.get('type');
      const answers = (dns.get(name) ?? []).filter((a) => (type === 'AAAA') === a.includes(':'));
      return Response.json({ Status: dns.has(name) ? 0 : 3, Answer: answers.map((data) => ({ type: data.includes(':') ? 28 : 1, data })) });
    }
    const body = String(init?.body ?? '');
    const post = { url: url.href, headers: new Headers(init?.headers), body, json: JSON.parse(body) };
    posts.push(post);
    return reply(post);
  });
  return {
    dns,
    posts,
    deliveries: () => posts.filter((p) => p.json.eventId),
    handler,
    respond(fn: typeof reply) {
      reply = fn;
    },
  };
}

/** Independent Standard Webhooks verification (does not reuse the signing code under test). */
async function verifySignature(post: Post, secret: string): Promise<boolean> {
  const raw = Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = `${post.headers.get('webhook-id')}.${post.headers.get('webhook-timestamp')}.${post.body}`;
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)));
  const expected = `v1,${btoa(String.fromCharCode(...mac))}`;
  return (post.headers.get('webhook-signature') ?? '').split(' ').includes(expected);
}

let t: TestEnv;
let net: ReturnType<typeof fakeNet>;
let user: UserRow;
let keyId: string;
let p: Principal;

beforeEach(async () => {
  t = createTestEnv({ EVENTS_SECRET_KEY: 'test-events-key' } as Partial<Env>);
  net = fakeNet();
  vi.stubGlobal('fetch', net.handler);
  user = await seedUser(t, 'user');
  keyId = (await seedKey(t, user, ['convert', 'library:read', 'library:write', 'feedback:write'])).row.id;
  p = { kind: 'api_key', userId: user.id, role: 'user', scopes: ['convert', 'library:read', 'library:write', 'feedback:write'], apiKeyId: keyId, requestId: 'req_1' };
});

afterEach(() => {
  vi.unstubAllGlobals();
  t.close();
});

function modern(method: string, params: Record<string, unknown> = {}, principal: Principal = p, env: Env = t.env) {
  const body = { jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: { [META_PROTOCOL_VERSION]: MODERN } } };
  return send(env, principal, body, { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method });
}

const subscribeParams = (over: Record<string, unknown> = {}, delivery: Record<string, unknown> = {}) => ({
  name: 'anymd.library.document.saved',
  arguments: {},
  delivery: { mode: 'webhook', url: HOOK, secret: SECRET, ...delivery },
  ...over,
});

function conversion(over: Partial<ConvertResult> = {}): ConvertResult {
  return {
    title: 'A post',
    author: 'Someone',
    published: '2026-10-01T00:00:00.000Z',
    description: 'About it',
    domain: 'example.com',
    site: 'Example',
    image: '',
    language: 'en',
    content: 'Body',
    baseContent: 'Body',
    wordCount: 1,
    source: 'https://example.com/post',
    sourceKind: 'web',
    ...over,
  };
}

const outbox = () => t.db.prepare('SELECT * FROM event_outbox ORDER BY created_at, id').all() as Record<string, any>[];
const deliveries = () => t.db.prepare('SELECT * FROM event_deliveries ORDER BY id').all() as Record<string, any>[];
const subscriptions = () => t.db.prepare('SELECT * FROM event_subscriptions').all() as Record<string, any>[];

/** Insert a subscription the way `events/subscribe` stores it, skipping the network handshake. */
async function seedSubscription(owner: UserRow, principal: string, name: string, args: Record<string, unknown> = {}, extra: { url?: string; expiresAt?: number; scope?: string } = {}) {
  const url = extra.url ?? HOOK;
  const id = await subscriptionId(principal, url, name, args);
  const ts = Date.now() - 1000;
  const scope = extra.scope ?? (name.startsWith('anymd.library.') ? 'library:read' : name.startsWith('anymd.video.') ? 'convert' : 'feedback:write');
  t.db
    .prepare(
      'INSERT INTO event_subscriptions (id,user_id,principal,principal_hash,name,arguments_json,url,secret_enc,scope,active,verified_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?)',
    )
    .run(id, owner.id, principal, await actorHash(principal), name, JSON.stringify(args), url, await encryptSecret(t.env, SECRET), scope, ts, extra.expiresAt ?? Date.now() + 3600_000, ts, ts);
  return id;
}

describe('callback URL policy', () => {
  it('accepts only global unicast addresses', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.2.1']) expect(isPublicIpv4(ip), ip).toBe(false);
    expect(isPublicIpv4('93.184.216.34')).toBe(true);
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2002:a00:1::1', 'ff02::1', '2001::1']) expect(isPublicIpv6(ip), ip).toBe(false);
    expect(isPublicIpv6('2606:2800:220:1::248')).toBe(true);
    expect(isPublicIpv6('::ffff:93.184.216.34')).toBe(true);
  });

  it('refuses non-https, credentials, fragments, internal names and this service', () => {
    const env = { PUBLIC_URL: 'https://anymd.test' };
    for (const raw of ['http://hooks.example.com/x', 'https://u:p@hooks.example.com/', 'https://hooks.example.com/#x', 'https://localhost/x', 'https://printer.local/x', 'https://intranet/x', 'https://[::1]/x', 'https://127.0.0.1/x', 'https://anymd.test/hook', 'https://api.anymd.test/hook', 'ftp://hooks.example.com']) {
      expect(() => parseCallbackUrl(env, raw), raw).toThrow();
    }
    expect(parseCallbackUrl(env, HOOK).href).toBe(HOOK);
  });

  it('rejects secrets that are not whsec_ with 24 to 64 bytes', () => {
    expect(parseWebhookSecret(SECRET)).not.toBeNull();
    expect(parseWebhookSecret('whsec_' + btoa('short'))).toBeNull();
    expect(parseWebhookSecret(SECRET.slice(6))).toBeNull();
    expect(parseWebhookSecret('whsec_' + btoa('x'.repeat(65)))).toBeNull();
  });
});

describe('discovery and subscription methods', () => {
  it('advertises events only to modern clients with a credential, never to legacy ones', async () => {
    const discover = await modern('server/discover');
    expect(discover.body.result.capabilities.events).toEqual({ listChanged: false });
    const session = await modern('server/discover', {}, { ...p, kind: 'session', apiKeyId: undefined });
    expect(session.body.result.capabilities.events).toBeUndefined();
    const legacy = await rpc(t.env, p, 'initialize', { protocolVersion: '2025-11-25' });
    expect(legacy.body.result.capabilities.events).toBeUndefined();
    const legacyList = await rpc(t.env, p, 'events/list');
    expect(legacyList.body.error.code).toBe(-32601);
    const off = await modern('server/discover', {}, p, { ...t.env, EVENTS_SECRET_KEY: undefined });
    expect(off.body.result.capabilities.events).toBeUndefined();
  });

  it('lists only the events the credential may read', async () => {
    const all = await modern('events/list');
    expect(all.body.result.events.map((e: { name: string }) => e.name).sort()).toEqual([
      'anymd.feedback.status.changed',
      'anymd.library.document.deleted',
      'anymd.library.document.saved',
      'anymd.library.tags.updated',
      'anymd.video.analysis.failed',
      'anymd.video.analysis.ready',
      'anymd.video.failed',
      'anymd.video.ready',
    ]);
    expect(all.body.result.events[0]).toMatchObject({ delivery: ['webhook'], inputSchema: expect.any(Object), payloadSchema: expect.any(Object) });
    const narrow = await modern('events/list', {}, { ...p, scopes: ['library:read'] });
    expect(narrow.body.result.events.every((e: { name: string }) => e.name.startsWith('anymd.library.'))).toBe(true);
  });

  it('subscribes after the endpoint echoes the challenge, refreshes idempotently and unsubscribes', async () => {
    const first = await modern('events/subscribe', subscribeParams());
    expect(first.body.result).toMatchObject({ id: expect.stringMatching(/^sub_/), cursor: null, truncated: false, resultType: 'complete' });
    const verification = net.posts.find((x) => x.json.type === 'verification')!;
    expect(await verifySignature(verification, SECRET)).toBe(true);
    expect(verification.headers.get('x-mcp-subscription-id')).toBe(first.body.result.id);
    const row = subscriptions()[0];
    expect(String(row.secret_enc).includes(SECRET.slice(6, 20))).toBe(false);

    const again = await modern('events/subscribe', subscribeParams({ cursor: 'abc' }));
    expect(again.body.result).toMatchObject({ id: first.body.result.id, truncated: true, deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null } });
    expect(net.posts.filter((x) => x.json.type === 'verification')).toHaveLength(1); // verified once per credential and url
    expect(subscriptions()).toHaveLength(1);

    const gone = await modern('events/unsubscribe', { name: 'anymd.library.document.saved', arguments: {}, delivery: { url: HOOK } });
    expect(gone.body.result).toMatchObject({});
    expect(subscriptions()).toHaveLength(0);
    const missing = await modern('events/unsubscribe', { name: 'anymd.library.document.saved', arguments: {}, delivery: { url: HOOK } });
    expect(missing.body.error.code).toBe(-32011);
  });

  it('refuses bad requests with the events error codes', async () => {
    expect((await modern('events/subscribe', subscribeParams({ name: 'anymd.nope' }))).body.error.code).toBe(-32011);
    expect((await modern('events/subscribe', subscribeParams({}, { secret: 'plain' }))).body.error.code).toBe(-32602);
    expect((await modern('events/subscribe', subscribeParams({}, { url: 'http://hooks.example.com/x' }))).body.error.code).toBe(-32602);
    expect((await modern('events/subscribe', subscribeParams({}, { url: 'https://10.0.0.8/x' }))).body.error.code).toBe(-32602);
    expect((await modern('events/subscribe', subscribeParams({}, { url: 'https://anymd.test/hook' }))).body.error.code).toBe(-32602);
    expect((await modern('events/subscribe', subscribeParams({}, { mode: 'sse' }))).body.error.code).toBe(-32014);
    expect((await modern('events/subscribe', subscribeParams({ arguments: { nope: 1 } }))).body.error.code).toBe(-32602);
    const scope = await modern('events/subscribe', subscribeParams({ name: 'anymd.video.ready' }), { ...p, scopes: ['library:read'] });
    expect(scope.body.error).toMatchObject({ code: -32012, data: { reason: 'missing_scope', required: ['convert'] } });
    expect(subscriptions()).toHaveLength(0);
  });

  it('refuses a host that resolves to a private address (DNS rebinding at subscribe time)', async () => {
    net.dns.set('rebind.example.org', ['93.184.216.34', '10.1.2.3']);
    const res = await modern('events/subscribe', subscribeParams({}, { url: 'https://rebind.example.org/hook' }));
    expect(res.body.error.code).toBe(-32602);
    expect(net.posts).toHaveLength(0);
  });

  it('reports a failed handshake as CallbackEndpointError and stores nothing', async () => {
    net.respond(() => Response.json({ challenge: 'wrong' }));
    const wrong = await modern('events/subscribe', subscribeParams());
    expect(wrong.body.error).toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
    net.respond(() => new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/' } }));
    const redirect = await modern('events/subscribe', subscribeParams());
    expect(redirect.body.error).toMatchObject({ code: -32015, data: { reason: 'http_4xx' } });
    expect(net.posts.every((x) => x.url === HOOK)).toBe(true); // the redirect was not followed
    expect(subscriptions()).toHaveLength(0);
  });

  it('caps live subscriptions per account', async () => {
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i++) await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved', { document_ids: [`doc_${i}`] });
    const res = await modern('events/subscribe', subscribeParams());
    expect(res.body.error.code).toBe(-32013);
  });

  it('subscribing grants nothing: no feedback is submitted and no credits are spent', async () => {
    await modern('events/subscribe', subscribeParams({ name: 'anymd.feedback.status.changed' }));
    await modern('events/subscribe', subscribeParams({ name: 'anymd.video.ready' }));
    expect(subscriptions()).toHaveLength(2);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM feedback_submissions').get()).toEqual({ n: 0 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 0 });
  });
});

describe('library events', () => {
  const other = { kind: 'api_key' as const, apiKeyId: 'key_other', requestId: 'req_other' };

  it('writes nothing to the outbox for owners without a subscription', async () => {
    await saveDocument(t.env, user.id, conversion(), 'Body');
    expect(outbox()).toHaveLength(0);
  });

  it('delivers exactly one signed event per committed save, and none for an unchanged re-save', async () => {
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved');
    const saved = await saveDocument(t.env, user.id, conversion(), 'Body', null, { principal: other });
    await saveDocument(t.env, user.id, conversion(), 'Body', null, { principal: other });
    expect(outbox()).toHaveLength(1);
    await saveDocument(t.env, user.id, conversion({ content: 'Changed', baseContent: 'Changed' }), 'Changed', null, { principal: other });
    expect(outbox().map((e) => JSON.parse(e.data_json).change)).toEqual(['created', 'updated']);

    expect(await processEvents(t.env)).toEqual({ queued: 2, attempted: 2 });
    const [first] = net.deliveries();
    expect(await verifySignature(first, SECRET)).toBe(true);
    expect(first.headers.get('webhook-id')).toBe(first.json.eventId);
    expect(first.json).toMatchObject({ name: 'anymd.library.document.saved', cursor: null, data: { document_id: saved!.id, resource_type: 'document', change: 'created', correlation_id: 'req_other' } });
    expect(Object.keys(first.json.data).sort()).toEqual(['change', 'correlation_id', 'document_id', 'resource_type', 'version']);

    // Replays: a second run sends nothing more, and the same event cannot be queued twice.
    expect(await processEvents(t.env)).toEqual({ queued: 0, attempted: 0 });
    t.db.prepare('UPDATE event_outbox SET dispatched_at = NULL').run();
    await processEvents(t.env);
    expect(deliveries()).toHaveLength(2);
    expect(net.deliveries()).toHaveLength(2);
  });

  it('skips changes made by the subscribing credential unless exclude_self is false', async () => {
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved');
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved', { exclude_self: false });
    await saveDocument(t.env, user.id, conversion(), 'Body', null, { principal: p });
    await processEvents(t.env);
    expect(net.deliveries()).toHaveLength(1);
    expect(net.deliveries()[0].headers.get('x-mcp-subscription-id')).toBe(await subscriptionId(`api_key:${keyId}`, HOOK, 'anymd.library.document.saved', { exclude_self: false }));
  });

  it('filters by document, tag and domain, and never crosses owners', async () => {
    const stranger = await seedUser(t, 'user');
    const strangerKey = (await seedKey(t, stranger, ['library:read'])).row.id;
    await seedSubscription(stranger, `api_key:${strangerKey}`, 'anymd.library.tags.updated', {}, { url: 'https://other.example.net/hook' });
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.tags.updated', { tags: ['Research'], domain: 'example.com' });
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.tags.updated', { document_ids: ['doc_none'] });
    const doc = (await saveDocument(t.env, user.id, conversion(), 'Body'))!;
    await updateTags(t.env, user.id, doc.id, ['misc'], { principal: other });
    await updateTags(t.env, user.id, doc.id, ['research', 'misc'], { principal: other });
    await updateTags(t.env, user.id, doc.id, ['research', 'misc'], { principal: other }); // unchanged: no event
    await processEvents(t.env);
    expect(outbox()).toHaveLength(2);
    // Matching uses the tags at delivery time: both events now match `research`.
    expect(net.deliveries().map((d) => d.url)).toEqual([HOOK, HOOK]);
    expect(net.deliveries().every((d) => d.json.data.document_id === doc.id)).toBe(true);
  });

  it('announces deletes', async () => {
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.deleted');
    const doc = (await saveDocument(t.env, user.id, conversion(), 'Body'))!;
    t.env.VECTORS = { deleteByIds: async () => undefined } as never;
    expect(await deleteDocument(t.env, user.id, doc.id, { principal: other })).toBe(true);
    expect(await deleteDocument(t.env, user.id, doc.id, { principal: other })).toBe(false);
    await processEvents(t.env);
    expect(net.deliveries().map((d) => d.json.data)).toEqual([expect.objectContaining({ document_id: doc.id, resource_type: 'document' })]);
  });

  it('sends nothing to an expired subscription', async () => {
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved', {}, { expiresAt: Date.now() - 1 });
    await saveDocument(t.env, user.id, conversion(), 'Body', null, { principal: other });
    await processEvents(t.env);
    expect(outbox()).toHaveLength(0);
    expect(net.posts).toHaveLength(0);
  });
});

describe('delivery', () => {
  const other = { kind: 'api_key' as const, apiKeyId: 'key_other' };
  const save = (n = 0) => saveDocument(t.env, user.id, conversion({ source: `https://example.com/p${n}` }), 'Body', null, { principal: other });
  const makeDue = () => t.db.prepare("UPDATE event_deliveries SET next_attempt_at = 0 WHERE status = 'pending'").run();

  it('retries with backoff, then dead-letters and suspends the subscription', async () => {
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved');
    await save();
    net.respond(() => new Response('down', { status: 503 }));
    await processEvents(t.env);
    expect(deliveries()[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http_5xx' });
    expect(deliveries()[0].next_attempt_at).toBeGreaterThan(Date.now() + 50_000);
    await processEvents(t.env); // not due yet
    expect(net.deliveries()).toHaveLength(1);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      makeDue();
      await processEvents(t.env);
    }
    expect(net.deliveries()).toHaveLength(MAX_ATTEMPTS);
    expect(deliveries()[0]).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS });
    expect(subscriptions()[0]).toMatchObject({ active: 0, last_error: 'http_5xx' });
    // A suspended subscription receives nothing until the client refreshes it.
    net.respond(() => new Response(null, { status: 200 }));
    await save(1);
    await processEvents(t.env);
    expect(net.deliveries()).toHaveLength(MAX_ATTEMPTS);
  });

  it('gives up at once on 410 and treats redirects as failures', async () => {
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved');
    await save();
    net.respond(() => new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/' } }));
    await processEvents(t.env);
    expect(deliveries()[0]).toMatchObject({ status: 'pending', last_error: 'http_4xx' });
    expect(net.posts.every((x) => x.url === HOOK)).toBe(true);
    net.respond(() => new Response(null, { status: 410 }));
    makeDue();
    await processEvents(t.env);
    expect(deliveries()[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('re-resolves the host before every delivery and refuses one that now points inside (DNS rebinding)', async () => {
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved');
    await save();
    net.dns.set('hooks.example.com', ['169.254.169.254']);
    await processEvents(t.env);
    expect(net.posts).toHaveLength(0);
    expect(deliveries()[0]).toMatchObject({ status: 'failed', last_error: 'connection_refused' });
  });

  it('refuses oversized bodies without sending', async () => {
    const res = await postWebhook(t.env, { subscriptionId: 'sub_x', url: HOOK, secrets: [SECRET] }, 'evt_x', JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }));
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(net.posts).toHaveLength(0);
  });

  it('signs with both secrets during a rotation', async () => {
    await modern('events/subscribe', subscribeParams());
    await modern('events/subscribe', subscribeParams({}, { secret: SECRET_2 }));
    await save();
    await processEvents(t.env);
    const [d] = net.deliveries();
    expect(d.headers.get('webhook-signature')!.split(' ')).toHaveLength(2);
    expect(await verifySignature(d, SECRET)).toBe(true);
    expect(await verifySignature(d, SECRET_2)).toBe(true);
  });

  it('ends the subscription with a signed terminated envelope when the key is revoked or narrowed', async () => {
    const id = await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved');
    await save();
    t.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(Date.now(), keyId);
    await processEvents(t.env);
    expect(net.deliveries()).toHaveLength(0);
    const terminated = net.posts.find((x) => x.json.type === 'terminated')!;
    expect(terminated.json.error).toMatchObject({ code: -32012, data: { reason: 'credential_revoked' } });
    expect(terminated.headers.get('x-mcp-subscription-id')).toBe(id);
    expect(await verifySignature(terminated, SECRET)).toBe(true);
    expect(subscriptions()).toHaveLength(0);

    const narrow = (await seedKey(t, user, ['convert'])).row.id;
    await seedSubscription(user, `api_key:${narrow}`, 'anymd.library.document.saved');
    await save(2);
    await processEvents(t.env);
    expect(net.posts.filter((x) => x.json.type === 'terminated').at(-1)!.json.error.data.reason).toBe('scope_revoked');
    expect(net.deliveries()).toHaveLength(0);
  });

  it('ends OAuth subscriptions when the grant is gone, and suspended accounts receive nothing', async () => {
    await t.env.OAUTH_KV.put(`grant:${user.id}:g1`, JSON.stringify({ scope: ['library:read'] }));
    await seedSubscription(user, 'oauth:g1', 'anymd.library.document.saved');
    await save();
    await processEvents(t.env);
    expect(net.deliveries()).toHaveLength(1);
    await t.env.OAUTH_KV.delete(`grant:${user.id}:g1`);
    await save(1);
    await processEvents(t.env);
    expect(net.deliveries()).toHaveLength(1);
    expect(net.posts.find((x) => x.json.type === 'terminated')!.json.error.data.reason).toBe('credential_revoked');

    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved');
    t.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);
    await save(2);
    await processEvents(t.env);
    expect(net.deliveries()).toHaveLength(1);
    expect(subscriptions()).toHaveLength(0);
  });

  it('prunes expired subscriptions and old events', async () => {
    await seedSubscription(user, `api_key:${keyId}`, 'anymd.library.document.saved', {}, { expiresAt: Date.now() - 2 * 86400_000 });
    t.db.prepare("INSERT INTO event_outbox (id,user_id,name,resource_id,data_json,created_at) VALUES ('evt_old', ?, 'anymd.library.document.saved', 'd', '{}', ?)").run(user.id, Date.now() - 2 * 86400_000);
    await pruneEvents(t.env);
    expect(subscriptions()).toHaveLength(0);
    expect(outbox()).toHaveLength(0);
  });
});
