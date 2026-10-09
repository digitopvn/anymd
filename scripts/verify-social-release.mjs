// Real release smoke test. Creates and removes its own short-lived test account.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';

const production = process.argv.includes('--production');
const base = production ? 'https://anymd.cc' : 'https://staging.anymd.cc';
const database = production ? 'fdf71d54-5bc3-492f-81ed-5346b12039bf' : '0799bf4e-4051-4e56-a70d-cff01a1b4a77';
const userId = `verify_social_${Date.now()}`;
const key = `amd_${randomBytes(24).toString('hex')}`;
const documents = new Set();
const results = [];
async function sql(query, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${database}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: query, params }), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`Verification SQL failed (${response.status})`);
  return data.result[0].results;
}
async function request(path, body, anonymous = false, method = 'POST') {
  const response = await fetch(base + path, { method, headers: { ...(!anonymous ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(70000) });
  const data = await response.json();
  return { response, data };
}
async function convert(name, body, expected = 200) {
  const { response, data } = await request('/api/v1/convert', { save: false, fresh: true, ...body });
  if (response.status !== expected) {
    const traces = await sql('SELECT spans FROM traces WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [userId]);
    console.log(JSON.stringify({ name, spans: traces.map(t => JSON.parse(t.spans).map(({ name, duration, status }) => ({ name, duration, status }))) }));
  }
  assert.equal(response.status, expected, `${name}: ${data.error?.code}: ${data.error?.message}`);
  if (response.ok) {
    assert.ok(data.markdown.length > 0);
    assert.ok(data.credits <= (body.maxCredits ?? 100));
    assert.equal(Object.values(data.credit_breakdown).reduce((a, b) => a + b, 0), data.credits);
    if (data.document_id) documents.add(data.document_id);
  }
  const summary = { name, status: response.status, credits: data.credits, cached: data.cached, coverage: Object.fromEntries(Object.entries(data.enrichment ?? {}).map(([k, v]) => [k, { complete: v.complete, count: v.count, reason: v.reason }])) };
  results.push(summary); console.log(JSON.stringify(summary));
  return data;
}
try {
  const now = Date.now();
  await sql('INSERT INTO users(id,email,name,role,plan,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [userId, `${userId}@example.invalid`, 'Social verification', 'user', 'free', now, now]);
  await sql('INSERT INTO api_keys(id,user_id,name,prefix,key_hash,role,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)', [`key_${userId}`, userId, 'Release smoke', key.slice(0, 10), createHash('sha256').update(key).digest('hex'), 'user', JSON.stringify(['convert', 'library:read', 'library:write', 'usage:read']), now, now + 600000]);
  const fbUrl = 'https://www.facebook.com/100064860875397/posts/pfbid04KTWEM9Rri6Wg3oLRBF5FUUvfPebQ6ZJRwVivymc8e8KWvy3RsnpUXyppjEZqkwZl';
  if (!process.argv.includes('--media-only')) {
    const x = await convert('X full thread', { url: 'https://x.com/Rapid_API/status/1603751561573941248', maxCredits: 30 });
    assert.equal(x.enrichment.thread.count, 7); assert.equal(x.enrichment.thread.complete, true); assert.equal(x.credits, 7);
    const cached = await convert('X cached', { url: x.url, fresh: false, maxCredits: 30 });
    assert.equal(cached.cached, true); assert.equal(cached.credits, 0);
    const capped = await convert('X budget cap', { url: x.url, maxCredits: 2 });
    assert.ok(capped.enrichment.thread.complete === false); assert.ok(capped.credits <= 2);
    const fb = await convert('Facebook comments saved', { url: fbUrl, includeComments: true, maxComments: 5, save: true, maxCredits: 30 });
    assert.equal(fb.enrichment.comments.count, 5); assert.equal(fb.credits, 20);
    const plain = await convert('Facebook plain refresh', { url: fbUrl, save: true, maxCredits: 10 });
    assert.equal(plain.document_id, fb.document_id);
    const saved = await request(`/api/v1/library/${fb.document_id}`, undefined, false, 'GET');
    assert.equal(saved.response.status, 200);
    const doc = saved.data.document ?? saved.data;
    assert.ok(doc.markdown.includes('## Comments')); assert.equal(doc.enrichment_json, undefined); assert.equal(doc.base_markdown, undefined);
    await convert('LinkedIn comments', { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7315779816467656705/', includeComments: true, maxComments: 5, maxCredits: 30 });
  }
  const ig = await convert('Instagram image OCR', { url: 'https://www.instagram.com/p/DbTmwYKFkZo/', analyzeImages: true, maxImages: 1, maxCredits: 20 });
  assert.equal(ig.enrichment.images.count, 1); assert.equal(ig.credits, 15);
  const igComments = await convert('Instagram comments', { url: ig.url, includeComments: true, maxComments: 5, maxCredits: 30 });
  assert.equal(igComments.enrichment.comments.count, 5); assert.equal(igComments.credits, 20);
  const threads = await convert('Threads with comment coverage', { url: 'https://www.threads.com/@mercedesamgf1/post/DeEApWUoLGb', includeComments: true, maxComments: 5, maxCredits: 30 });
  assert.equal(threads.enrichment.comments.count, 5); assert.equal(threads.credits, 20);
  await convert('Base budget rejected', { url: fbUrl, maxCredits: 9 }, 402);
  await convert('Contradictory image options', { url: fbUrl, analyzeImages: true, removeImages: true }, 400);
  const anon = await request('/https://www.instagram.com/p/DbTmwYKFkZo/?format=json&analyzeImages=1', undefined, true, 'GET');
  assert.equal(anon.response.status, 401);
  const charges = await sql('SELECT SUM(credits) AS credits, SUM(CASE WHEN settled=0 THEN 1 ELSE 0 END) AS unsettled FROM conversion_charges WHERE user_id=?', [userId]);
  assert.equal(charges[0].unsettled, 0);
  console.log(JSON.stringify({ verification: 'passed', charged: charges[0].credits, cases: results.length }));
} finally {
  for (const id of documents) await request(`/api/v1/library/${id}`, undefined, false, 'DELETE');
  await sql('DELETE FROM users WHERE id=?', [userId]);
  await sql('DELETE FROM usage_events WHERE user_id=?', [userId]);
  await sql('DELETE FROM traces WHERE user_id=?', [userId]);
  console.log('Temporary verification account and documents removed.');
}
