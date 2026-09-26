import { describe, expect, it } from 'vitest';
import { applyOpsToDocument, normalizeSlug, PageError, TEMPLATES, type PageDocument } from '../src/cms/pages';
import { documentsToMarkdown } from '../src/lib/account';
import type { DocumentRow } from '../src/library/store';
import { verifyPolarWebhook } from '../src/billing/polar';
import { normalizeTargetUrl } from '../src/convert/index';
import { buildOpenApi } from '../src/openapi';
import type { Env } from '../src/env';

const meta = { title: 'T', description: '', slug: 't' };
const emptyDoc = (): PageDocument => ({ layout: 'landing', seo: {}, blocks: [] }) as unknown as PageDocument;

describe('page ops', () => {
  it('inserts, updates, moves, duplicates and removes blocks', () => {
    let { doc, created } = applyOpsToDocument(emptyDoc(), meta, [
      { op: 'insert', block: { type: 'hero', props: { title: 'Hello' } } },
      { op: 'insert', block: { type: 'faq', props: { items: [{ q: 'Q?', a: 'A.' }] } } },
    ] as never);
    expect(doc.blocks.map((b) => b.type)).toEqual(['hero', 'faq']);
    const [hero, faq] = created;

    ({ doc } = applyOpsToDocument(doc, meta, [{ op: 'update', id: hero, props: { title: 'Hi' } }] as never));
    expect((doc.blocks[0].props as { title: string }).title).toBe('Hi');

    ({ doc } = applyOpsToDocument(doc, meta, [{ op: 'move', id: faq, index: 0 }] as never));
    expect(doc.blocks[0].id).toBe(faq);

    const dup = applyOpsToDocument(doc, meta, [{ op: 'duplicate', id: faq }] as never);
    expect(dup.doc.blocks).toHaveLength(3);
    expect(new Set(dup.doc.blocks.map((b) => b.id)).size).toBe(3);

    ({ doc } = applyOpsToDocument(doc, meta, [{ op: 'remove', id: hero }] as never));
    expect(doc.blocks.map((b) => b.id)).toEqual([faq]);
  });

  it('is atomic: a failing op leaves the input document untouched', () => {
    const doc = emptyDoc();
    expect(() => applyOpsToDocument(doc, meta, [{ op: 'insert', block: { type: 'hero', props: { title: 'x' } } }, { op: 'remove', id: 'missing' }] as never)).toThrow(PageError);
    expect(doc.blocks).toHaveLength(0);
  });

  it('rejects unknown block types and invalid props', () => {
    expect(() => applyOpsToDocument(emptyDoc(), meta, [{ op: 'insert', block: { type: 'nope', props: {} } }] as never)).toThrow(PageError);
  });

  it('normalizes slugs and refuses reserved ones', () => {
    expect(normalizeSlug('Hello World/Part 2')).toBe('hello-world/part-2');
    expect(() => normalizeSlug('dashboard/x')).toThrow(PageError);
    expect(() => applyOpsToDocument(emptyDoc(), meta, [{ op: 'set_meta', slug: 'api' }] as never)).toThrow(PageError);
  });

  it('ships templates built only from known blocks', () => {
    for (const tpl of Object.values(TEMPLATES)) {
      expect(() => applyOpsToDocument(emptyDoc(), meta, tpl.blocks.map((block) => ({ op: 'insert', block })) as never)).not.toThrow();
    }
  });
});

describe('normalizeTargetUrl', () => {
  it('adds https and repairs collapsed slashes', () => {
    expect(normalizeTargetUrl('example.com/a').href).toBe('https://example.com/a');
    expect(normalizeTargetUrl('https:/example.com/a#x').href).toBe('https://example.com/a');
  });
  it('refuses private hosts, credentials and other schemes', () => {
    for (const bad of ['http://localhost/x', 'http://127.0.0.1/', 'http://10.0.0.1/', 'https://user:pw@example.com/', 'ftp://example.com/', 'intranet']) {
      expect(() => normalizeTargetUrl(bad)).toThrow();
    }
  });
});

describe('Polar webhook signature', () => {
  async function sign(secretB64: string, id: string, ts: string, body: string) {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
    return btoa(String.fromCharCode(...mac));
  }
  const secret = btoa('super-secret-key-bytes');
  const env = { POLAR_WEBHOOK_SECRET: `whsec_${secret}` } as Env;

  it('accepts a valid signature and rejects tampering or stale timestamps', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"subscription.created"}';
    const sig = await sign(secret, 'msg_1', ts, body);
    const headers = (t = ts, s = sig) => new Headers({ 'webhook-id': 'msg_1', 'webhook-timestamp': t, 'webhook-signature': `v1,${s}` });
    expect(await verifyPolarWebhook(env, headers(), body)).toBe(true);
    expect(await verifyPolarWebhook(env, headers(), body + ' ')).toBe(false);
    expect(await verifyPolarWebhook(env, headers(String(Number(ts) - 600), await sign(secret, 'msg_1', String(Number(ts) - 600), body)), body)).toBe(false);
  });
});

describe('account export', () => {
  it('writes one frontmatter block per document', () => {
    const doc = { title: 'A "quoted" title', url: 'https://example.com/a', source_kind: 'web', tags: 'ai llm', created_at: Date.UTC(2026, 0, 2), markdown: '# Hi\n' } as DocumentRow;
    const md = documentsToMarkdown([doc, { ...doc, tags: '' }]);
    expect(md.includes('title: "A \\"quoted\\" title"')).toBe(true);
    expect(md.includes('tags: ["ai", "llm"]')).toBe(true);
    expect(md.includes('saved: 2026-01-02T00:00:00.000Z')).toBe(true);
    expect(md.split('* * *')).toHaveLength(2);
  });
});

describe('OpenAPI', () => {
  it('documents every path with operation ids and a server URL', () => {
    const spec = buildOpenApi('https://anymd.cc');
    expect(spec.servers[0].url).toBe('https://anymd.cc/api/v1');
    const ids = Object.values(spec.paths).flatMap((m) => Object.values(m).map((op) => (op as { operationId: string }).operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(spec.paths['/convert']).toBeDefined();
    expect(spec.paths['/admin/pages/{id}/ops']).toBeDefined();
  });
});
