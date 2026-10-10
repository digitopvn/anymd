import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  configPath,
  formatKeyValues,
  formatSearchResults,
  formatTable,
  looksLikeUrl,
  maskKey,
  normalizeTargetUrl,
  parseArgs,
  parseTagList,
  resolveSettings,
  run,
  stripMark,
  VERSION,
} from '../bin/anymd.mjs';

const KEY = 'amd_live_1234567890abcdefWXYZ';
let tmp;

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'anymd-cli-test-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(text, headers = {}) {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/markdown', ...headers } });
}

/** Build an injectable io bag with a scripted fetch; `routes` maps "METHOD path" (no query) to a handler. */
function harness({ routes = {}, env = {}, tty = false, configDir, prompt } = {}) {
  const calls = [];
  let stdout = '';
  let stderr = '';
  const io = {
    env: { XDG_CONFIG_HOME: configDir ?? path.join(tmp, `cfg-${Math.random().toString(36).slice(2)}`), ...env },
    platform: 'linux',
    homedir: tmp,
    stdout: { isTTY: tty, write: (s) => { stdout += s; return true; } },
    stderr: { isTTY: false, write: (s) => { stderr += s; return true; } },
    prompt,
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
      calls.push(call);
      const handler = routes[`${call.method} ${u.pathname}`];
      if (!handler) return jsonResponse({ error: { code: 'not_found', message: `no route ${u.pathname}` } }, 404);
      return handler(call, u);
    },
  };
  return {
    io,
    calls,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    exec: (argv) => run(argv, io),
  };
}

describe('parseArgs', () => {
  test('splits flags and positionals', () => {
    const { flags, positionals } = parseArgs(['search', 'hello', 'world', '--mode', 'bm25', '--limit=5', '--json']);
    assert.deepEqual(positionals, ['search', 'hello', 'world']);
    assert.deepEqual(flags, { mode: 'bm25', limit: '5', json: true });
  });

  test('supports short options, --no-save and the -- terminator', () => {
    const { flags, positionals } = parseArgs(['convert', 'x.com', '-o', 'out.md', '--no-save', '--fresh', '--', '--literal']);
    assert.deepEqual(positionals, ['convert', 'x.com', '--literal']);
    assert.deepEqual(flags, { output: 'out.md', noSave: true, fresh: true });
    assert.equal(parseArgs(['-h']).flags.help, true);
    assert.equal(parseArgs(['--version']).flags.version, true);
  });

  test('rejects unknown options, missing values and values on boolean flags', () => {
    assert.throws(() => parseArgs(['--nope']), { code: 'usage' });
    assert.throws(() => parseArgs(['-x']), { code: 'usage' });
    assert.throws(() => parseArgs(['convert', 'a.com', '-o']), { code: 'usage' });
    assert.throws(() => parseArgs(['--json=yes']), { code: 'usage' });
  });
});

describe('URL helpers', () => {
  test('looksLikeUrl accepts URLs and bare domains, rejects commands and words', () => {
    for (const ok of ['https://example.com', 'http://a.b/c?d=1', 'example.com', 'docs.example.co.uk/path', 'sub.site.io:8080/x', '1.2.3.4/a']) {
      assert.equal(looksLikeUrl(ok), true, ok);
    }
    for (const bad of ['search', 'ls', 'hello world', 'foo', '', 'ftp://x.com', 'file.']) {
      assert.equal(looksLikeUrl(bad), false, bad);
    }
  });

  test('normalizeTargetUrl adds https and drops fragments', () => {
    assert.equal(normalizeTargetUrl('example.com/a'), 'https://example.com/a');
    assert.equal(normalizeTargetUrl('http://x.com/a?b=1#frag'), 'http://x.com/a?b=1');
  });

  test('maskKey never reveals the middle of a key', () => {
    assert.equal(maskKey(KEY), 'amd_live…WXYZ');
    assert.equal(maskKey('amd_short'), 'amd_…');
    assert.equal(maskKey(undefined), '');
  });
});

describe('configuration', () => {
  test('configPath respects XDG_CONFIG_HOME, APPDATA on Windows, and ~/.config', () => {
    assert.equal(configPath({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', homedir: '/home/u' }), path.join('/xdg', 'anymd', 'config.json'));
    assert.equal(configPath({ env: {}, platform: 'linux', homedir: '/home/u' }), path.join('/home/u', '.config', 'anymd', 'config.json'));
    assert.equal(configPath({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\u' }),
      path.join('C:\\Users\\u\\AppData\\Roaming', 'anymd', 'config.json'));
  });

  test('precedence is flags > env > config file > default', () => {
    const file = { api_key: 'amd_file', base_url: 'https://file.example' };
    const env = { ANYMD_API_KEY: 'amd_env', ANYMD_BASE_URL: 'https://env.example/' };
    assert.deepEqual(resolveSettings({ key: 'amd_flag', base: 'http://flag.example' }, env, file),
      { key: 'amd_flag', keySource: 'flag', base: 'http://flag.example' });
    assert.deepEqual(resolveSettings({}, env, file), { key: 'amd_env', keySource: 'env', base: 'https://env.example' });
    assert.deepEqual(resolveSettings({}, {}, file), { key: 'amd_file', keySource: 'config', base: 'https://file.example' });
    assert.deepEqual(resolveSettings({}, {}, {}), { key: undefined, keySource: undefined, base: 'https://anymd.cc' });
  });

  test('rejects a non-http base URL', () => {
    assert.throws(() => resolveSettings({ base: 'ftp://x' }, {}, {}), { code: 'invalid_base_url' });
  });
});

describe('formatting', () => {
  test('stripMark removes highlight tags', () => {
    assert.equal(stripMark('a <mark>b</mark> c <MARK>d</MARK> <mark>e'), 'a b c d e');
  });

  test('formatSearchResults prints a ranked compact list', () => {
    const text = formatSearchResults([
      { id: 'd1', score: 0.91234, title: 'First', url: 'https://a.com', snippet: 'the <mark>quick</mark>\n fox' },
      { id: 'd2', title: 'Second', url: 'https://b.com', snippet: '' },
    ]);
    assert.match(text, /^1\. 0\.912 {2}First\n {3}https:\/\/a\.com {2}id:d1\n {3}the quick fox\n/);
    assert.match(text, /2\. {5}- {2}Second/);
    assert.doesNotMatch(text, /mark/);
    assert.equal(formatSearchResults([]), 'No results.\n');
  });

  test('formatTable pads all but the last column', () => {
    assert.equal(formatTable(['ID', 'TITLE'], [['abc', 'Hello'], ['a', 'X']]), 'ID   TITLE\nabc  Hello\na    X\n');
  });

  test('formatKeyValues nests objects and summarises arrays', () => {
    const text = formatKeyValues({ plan: 'pro', quota: { used: 3, limit: 10 }, scopes: ['a', 'b'], daily: [{ d: 1 }] });
    assert.equal(text, 'plan: pro\nquota:\n  used: 3\n  limit: 10\nscopes: a, b\ndaily: 1 entries (use --json for details)\n');
  });
});

describe('run: meta commands', () => {
  test('--help prints usage without colors when stdout is not a TTY', async () => {
    const h = harness();
    assert.equal(await h.exec(['--help']), 0);
    assert.match(h.stdout, /anymd search <query>/);
    assert.doesNotMatch(h.stdout, /\x1b\[/);
    assert.equal(h.calls.length, 0);
  });

  test('colors only on a TTY with NO_COLOR unset', async () => {
    const tty = harness({ tty: true });
    await tty.exec(['-h']);
    assert.match(tty.stdout, /\x1b\[1m/);
    const noColor = harness({ tty: true, env: { NO_COLOR: '1' } });
    await noColor.exec(['-h']);
    assert.doesNotMatch(noColor.stdout, /\x1b\[/);
  });

  test('--version prints the package version', async () => {
    const h = harness();
    assert.equal(await h.exec(['--version']), 0);
    assert.equal(h.stdout, `${VERSION}\n`);
    assert.equal(VERSION, '0.1.4');
  });

  test('unknown command fails with a usage error', async () => {
    const h = harness();
    assert.equal(await h.exec(['frobnicate']), 1);
    assert.match(h.stderr, /^usage: unknown command "frobnicate"/);
  });
});

describe('run: convert', () => {
  test('anonymous `anymd <domain>` uses the public URL API', async () => {
    const h = harness({
      routes: { 'GET /https://example.com/post': () => textResponse('# Hello\n') },
    });
    assert.equal(await h.exec(['example.com/post']), 0);
    assert.equal(h.calls[0].url, 'https://anymd.cc/https://example.com/post');
    assert.equal(h.calls[0].headers.authorization, undefined);
    assert.equal(h.stdout, '# Hello\n');
  });

  test('anonymous --json appends ?format=json and pretty-prints', async () => {
    const h = harness({
      env: { ANYMD_BASE_URL: 'https://staging.anymd.cc' },
      routes: { 'GET /https://example.com/': () => jsonResponse({ title: 'T', markdown: '# T' }) },
    });
    assert.equal(await h.exec(['convert', 'https://example.com/', '--json', '--fresh']), 0);
    assert.equal(h.calls[0].url, 'https://staging.anymd.cc/https://example.com/?format=json&fresh=1');
    assert.deepEqual(JSON.parse(h.stdout), { title: 'T', markdown: '# T' });
  });

  test('with a key uses POST /api/v1/convert and prints the markdown field', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'POST /api/v1/convert': () => jsonResponse({ markdown: '# Keyed' }) },
    });
    assert.equal(await h.exec(['convert', 'example.com', '--no-save', '--fresh']), 0);
    const call = h.calls[0];
    assert.equal(call.url, 'https://anymd.cc/api/v1/convert');
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(call.body), { url: 'https://example.com', format: 'markdown', save: false, fresh: true });
    assert.equal(h.stdout, '# Keyed\n');
  });

  test('forwards authenticated enrichment options with numeric bounds preserved', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'POST /api/v1/convert': () => jsonResponse({ markdown: '# Enriched' }) },
    });
    assert.equal(await h.exec([
      'convert', 'example.com/post', '--include-comments', '--analyze-images',
      '--max-comments', '37', '--max-images=4', '--max-credits', '88',
    ]), 0);
    assert.deepEqual(JSON.parse(h.calls[0].body), {
      url: 'https://example.com/post',
      format: 'markdown',
      includeComments: true,
      analyzeImages: true,
      maxComments: 37,
      maxImages: 4,
      maxCredits: 88,
    });
  });

  test('requires a key for paid enrichment before making a request', async () => {
    for (const option of ['--include-comments', '--analyze-images']) {
      const h = harness();
      assert.equal(await h.exec(['convert', 'example.com', option]), 1);
      assert.match(h.stderr, /^not_authenticated:/);
      assert.equal(h.calls.length, 0);
    }
  });

  test('rejects invalid enrichment bounds before making a request', async () => {
    for (const [option, value] of [
      ['--max-comments', '0'],
      ['--max-comments', '1001'],
      ['--max-images', '21'],
      ['--max-images', '1.5'],
      ['--max-credits', '0'],
      ['--max-credits', '1001'],
    ]) {
      const h = harness({ env: { ANYMD_API_KEY: KEY } });
      assert.equal(await h.exec(['convert', 'example.com', option, value]), 1);
      assert.match(h.stderr, /^usage:/);
      assert.equal(h.calls.length, 0);
    }
  });

  test('sends no reading options unless given, so saved defaults decide', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'POST /api/v1/convert': () => jsonResponse({ markdown: '# Base' }) },
    });
    assert.equal(await h.exec(['convert', 'x.com/a/status/1']), 0);
    assert.deepEqual(JSON.parse(h.calls[0].body), { url: 'https://x.com/a/status/1', format: 'markdown' });
  });

  test('forwards explicit thread expansion, one-time opt-outs and image retention', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'POST /api/v1/convert': () => jsonResponse({ markdown: '# Thread' }) },
    });
    assert.equal(await h.exec([
      'convert', 'x.com/a/status/1', '--expand-thread', '--max-thread-posts', '30',
      '--no-include-comments', '--no-analyze-images', '--no-images',
    ]), 0);
    assert.deepEqual(JSON.parse(h.calls[0].body), {
      url: 'https://x.com/a/status/1',
      format: 'markdown',
      expandThread: true,
      maxThreadPosts: 30,
      includeComments: false,
      analyzeImages: false,
      removeImages: true,
    });
  });

  test('maps reading options onto the anonymous URL API query', async () => {
    const h = harness({ routes: { 'GET /https://a.com': (_call, u) => textResponse(`# ${u.search}`) } });
    assert.equal(await h.exec(['convert', 'a.com', '--no-expand-thread', '--keep-images']), 0);
    const query = new URL(h.calls[0].url).searchParams;
    assert.equal(query.get('expandThread'), '0');
    assert.equal(query.get('images'), '1');
  });

  test('rejects conflicting or out-of-range thread options before any request', async () => {
    for (const argv of [
      ['--expand-thread', '--no-expand-thread'],
      ['--keep-images', '--no-images'],
      ['--max-thread-posts', '0'],
      ['--max-thread-posts', '101'],
    ]) {
      const h = harness({ env: { ANYMD_API_KEY: KEY } });
      assert.equal(await h.exec(['convert', 'x.com/a/status/1', ...argv]), 1, argv.join(' '));
      assert.match(h.stderr, /^usage:/);
      assert.equal(h.calls.length, 0);
    }
    const anonymous = harness();
    assert.equal(await anonymous.exec(['convert', 'x.com/a/status/1', '--expand-thread']), 1);
    assert.match(anonymous.stderr, /^not_authenticated:/);
  });

  test('prefs shows, updates and resets saved reading defaults', async () => {
    const state = { preferences: { expandThread: false, maxThreadPosts: 20, includeComments: false, maxComments: 100, keepImages: true, analyzeImages: false, maxImages: 10, maxCredits: 100 }, saved: false };
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'GET /api/v1/account/reading-preferences': () => jsonResponse(state),
        'PUT /api/v1/account/reading-preferences': (call) => jsonResponse({ preferences: { ...state.preferences, ...JSON.parse(call.body) }, saved: true }),
        'DELETE /api/v1/account/reading-preferences': () => jsonResponse(state),
      },
    });
    assert.equal(await h.exec(['prefs']), 0);
    assert.match(h.stdout, /safe defaults: deep reading off/);
    assert.equal(await h.exec(['prefs', 'set', 'expandThread=on', 'maxThreadPosts=30', '--json']), 0);
    assert.deepEqual(JSON.parse(h.calls[1].body), { expandThread: true, maxThreadPosts: 30 });
    assert.equal(await h.exec(['prefs', 'reset']), 0);
    assert.equal(h.calls[2].method, 'DELETE');
  });

  test('video shows a background download and saves downloadVideo as a preference', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'GET /api/v1/videos/vid_1': () => jsonResponse({ id: 'vid_1', status: 'downloading', quality: null, cdn_url: null, credits: 0, error: null }),
        'PUT /api/v1/account/reading-preferences': (call) => jsonResponse({ preferences: JSON.parse(call.body), saved: true }),
      },
    });
    assert.equal(await h.exec(['video', 'vid_1']), 0);
    assert.match(h.stdout, /status\s+downloading/);
    assert.match(h.stdout, /check again/);
    assert.equal(await h.exec(['prefs', 'set', 'downloadVideo=on', '--json']), 0);
    assert.deepEqual(JSON.parse(h.calls[1].body), { downloadVideo: true });
  });

  test('video prints the AI analysis once ready and keeps polling while it runs', async () => {
    const analysis = (status, markdown = null) => ({ status, model: 'google/gemini-3.8-flash', credits: status === 'ready' ? 30 : 0, markdown, error: null });
    const job = (a) => ({ id: 'vid_1', status: 'ready', quality: '360p', cdn_url: 'https://cdn.anymd.test/v.mp4', credits: 20, error: null, analysis: a });
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'GET /api/v1/videos/vid_1': () => jsonResponse(job(analysis('running'))),
        'GET /api/v1/videos/vid_2': () => jsonResponse(job(analysis('ready', '## Summary\nA man at the zoo.'))),
        'PUT /api/v1/account/reading-preferences': (call) => jsonResponse({ preferences: JSON.parse(call.body), saved: true }),
      },
    });
    assert.equal(await h.exec(['video', 'vid_1']), 0);
    assert.match(h.stdout, /analysis\s+running \(google\/gemini-3\.8-flash\)/);
    assert.match(h.stdout, /check again/);
    assert.equal(await h.exec(['video', 'vid_2']), 0);
    assert.match(h.stdout, /ready \(google\/gemini-3\.8-flash, 30 credits\)/);
    assert.match(h.stdout, /A man at the zoo/);
    assert.equal(await h.exec(['prefs', 'set', 'analyzeVideo=on', '--json']), 0);
    assert.deepEqual(JSON.parse(h.calls[2].body), { analyzeVideo: true });
  });

  test('prefs set and reset explain the keys:manage scope on 403', async () => {
    const forbidden = () => jsonResponse({ error: { code: 'forbidden', message: 'Missing scope: keys:manage' } }, 403);
    for (const args of [['prefs', 'set', 'expandThread=on'], ['prefs', 'reset']]) {
      const h = harness({
        env: { ANYMD_API_KEY: KEY },
        routes: { 'PUT /api/v1/account/reading-preferences': forbidden, 'DELETE /api/v1/account/reading-preferences': forbidden },
      });
      assert.equal(await h.exec(args), 1, args.join(' '));
      assert.match(h.stderr, /^forbidden: Missing scope: keys:manage/);
      assert.match(h.stderr, /keys:manage scope, e\.g\. the "Everything my role allows" preset/);
    }
  });

  test('prefs set validates fields locally', async () => {
    for (const arg of ['expandThread=maybe', 'maxThreadPosts=0', 'maxImages=21', 'unknown=1', 'noequals']) {
      const h = harness({ env: { ANYMD_API_KEY: KEY } });
      assert.equal(await h.exec(['prefs', 'set', arg]), 1, arg);
      assert.match(h.stderr, /^usage:/);
      assert.equal(h.calls.length, 0);
    }
  });

  test('-o writes the result to a file and reports on stderr', async () => {
    const out = path.join(tmp, 'out.md');
    const h = harness({
      routes: { 'GET /https://a.com': () => textResponse('# A', { 'x-anymd-credits': '1', 'x-anymd-cache': 'miss' }) },
    });
    assert.equal(await h.exec(['https://a.com', '-o', out]), 0);
    assert.equal(await readFile(out, 'utf8'), '# A\n');
    assert.equal(h.stdout, '');
    assert.match(h.stderr, /Saved .*out\.md \(4 bytes, credits 1, cache miss\)/);
  });

  test('prints `code: message` and exits 1 on API errors, with a login hint for anonymous_limit', async () => {
    const h = harness({
      routes: {
        'GET /https://a.com': () =>
          jsonResponse({ error: { code: 'anonymous_limit', message: 'Daily anonymous limit reached' } }, 429),
      },
    });
    assert.equal(await h.exec(['a.com']), 1);
    assert.match(h.stderr, /^anonymous_limit: Daily anonymous limit reached\n/);
    assert.match(h.stderr, /hint: .*anymd login/);
    assert.equal(h.stdout, '');
  });

  test('network failures are reported without a stack trace', async () => {
    const h = harness();
    h.io.fetch = async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }); };
    assert.equal(await h.exec(['a.com']), 1);
    assert.match(h.stderr, /^network_error: could not reach https:\/\/anymd\.cc: ECONNREFUSED/);
  });
});

describe('run: library commands', () => {
  test('file uploads multipart to /api/v1/convert/file', async () => {
    const src = path.join(tmp, 'doc.pdf');
    await writeFile(src, '%PDF-1.4 test');
    let received;
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'POST /api/v1/convert/file': (call) => {
          received = call.body.get('file');
          return jsonResponse({ markdown: '# From PDF' });
        },
      },
    });
    assert.equal(await h.exec(['file', src]), 0);
    assert.equal(received.name, 'doc.pdf');
    assert.equal(received.type, 'application/pdf');
    assert.equal(await received.text(), '%PDF-1.4 test');
    assert.equal(h.stdout, '# From PDF\n');
  });

  test('file requires a key', async () => {
    const h = harness();
    assert.equal(await h.exec(['file', 'missing.pdf']), 1);
    assert.match(h.stderr, /^not_authenticated:/);
    assert.equal(h.calls.length, 0);
  });

  test('search sends q/mode/limit and prints a ranked list', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'GET /api/v1/search': () =>
          jsonResponse({ results: [{ id: 'd1', score: 0.5, title: 'Cats', url: 'https://c.com', snippet: '<mark>cats</mark> rule' }] }),
      },
    });
    assert.equal(await h.exec(['search', 'cute', 'cats', '--limit', '5']), 0);
    const u = new URL(h.calls[0].url);
    assert.equal(u.searchParams.get('q'), 'cute cats');
    assert.equal(u.searchParams.get('mode'), 'hybrid');
    assert.equal(u.searchParams.get('limit'), '5');
    assert.match(h.stdout, /1\. 0\.500 {2}Cats\n {3}https:\/\/c\.com {2}id:d1\n {3}cats rule\n/);
  });

  test('search validates mode and limit', async () => {
    const h = harness({ env: { ANYMD_API_KEY: KEY } });
    assert.equal(await h.exec(['search', 'x', '--mode', 'magic']), 1);
    assert.equal(await h.exec(['search', 'x', '--limit', '51']), 1);
    assert.equal(h.calls.length, 0);
  });

  test('search --json prints the raw body', async () => {
    const body = { results: [], took_ms: 3 };
    const h = harness({ env: { ANYMD_API_KEY: KEY }, routes: { 'GET /api/v1/search': () => jsonResponse(body) } });
    assert.equal(await h.exec(['search', 'x', '--json']), 0);
    assert.deepEqual(JSON.parse(h.stdout), body);
  });

  test('ls prints a table', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'GET /api/v1/library': () =>
          jsonResponse({
            items: [{ id: 'doc_1', kind: 'web', created_at: 1790000000000, title: 'Example page' }],
            next_cursor: null,
          }),
      },
    });
    assert.equal(await h.exec(['ls', '--domain', 'example.com']), 0);
    const u = new URL(h.calls[0].url);
    assert.equal(u.searchParams.get('limit'), '20');
    assert.equal(u.searchParams.get('domain'), 'example.com');
    const lines = h.stdout.trim().split('\n');
    assert.match(lines[0], /^ID\s+KIND\s+CREATED\s+TITLE$/);
    assert.match(lines[1], /^doc_1\s+web\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+Example page$/);
  });

  test('get prints raw markdown via ?format=md; rm deletes', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'GET /api/v1/library/doc%201': () => textResponse('# Doc'),
        'DELETE /api/v1/library/doc_1': () => jsonResponse({ ok: true }),
      },
    });
    assert.equal(await h.exec(['get', 'doc 1']), 0);
    assert.equal(new URL(h.calls[0].url).searchParams.get('format'), 'md');
    assert.equal(await h.exec(['rm', 'doc_1']), 0);
    assert.equal(h.stdout, '# Doc\nDeleted doc_1\n');
  });
});

describe('run: tag commands', () => {
  test('parseTagList splits commas and rejects long tags', () => {
    assert.deepEqual(parseTagList(' ai, research ,,rag ', '--add'), ['ai', 'research', 'rag']);
    assert.deepEqual(parseTagList('', '--set'), []);
    assert.throws(() => parseTagList('x'.repeat(41), '--add'), /at most 40/);
  });

  test('tag --add/--remove posts both lists and prints the resulting tags', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'POST /api/v1/library/doc_1/tags': () => jsonResponse({ id: 'doc_1', tags: ['ai', 'rag'] }) },
    });
    assert.equal(await h.exec(['tag', 'doc_1', '--add', 'ai,rag', '--remove', 'old']), 0);
    assert.deepEqual(JSON.parse(h.calls[0].body), { add: ['ai', 'rag'], remove: ['old'] });
    assert.equal(h.stdout, '#ai #rag\n');
  });

  test('tag --set "" clears all tags', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'POST /api/v1/library/doc_1/tags': () => jsonResponse({ id: 'doc_1', tags: [] }) },
    });
    assert.equal(await h.exec(['tag', 'doc_1', '--set', '']), 0);
    assert.deepEqual(JSON.parse(h.calls[0].body), { set: [] });
    assert.equal(h.stdout, 'No tags.\n');
  });

  test('tag rejects mixing --set with --add and requires an edit', async () => {
    const h = harness({ env: { ANYMD_API_KEY: KEY } });
    assert.equal(await h.exec(['tag', 'doc_1', '--set', 'a', '--add', 'b']), 1);
    assert.match(h.stderr, /not both/);
    assert.equal(await h.exec(['tag', 'doc_1']), 1);
    assert.equal(await h.exec(['tag', '--add', 'a']), 1);
    assert.equal(await h.exec(['tag', 'doc_1', '--add', '']), 1);
    assert.match(h.stderr, /--add needs at least one tag/);
    assert.equal(await h.exec(['tag', 'doc_1', '--remove', ' , ']), 1);
    assert.equal(h.calls.length, 0);
  });

  test('tag surfaces the server error code', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'POST /api/v1/library/doc_1/tags': () => jsonResponse({ error: { code: 'too_many_tags', message: 'A document can have at most 20 tags' } }, 422) },
    });
    assert.equal(await h.exec(['tag', 'doc_1', '--add', 'x']), 1);
    assert.match(h.stderr, /too_many_tags/);
  });

  test('tags prints a table with counts', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'GET /api/v1/library/tags': () => jsonResponse({ items: [{ tag: 'ai', count: 3 }, { tag: 'rag', count: 1 }] }) },
    });
    assert.equal(await h.exec(['tags', '--limit', '5']), 0);
    assert.equal(new URL(h.calls[0].url).searchParams.get('limit'), '5');
    const lines = h.stdout.trim().split('\n');
    assert.match(lines[0], /^TAG\s+DOCS$/);
    assert.match(lines[1], /^ai\s+3$/);
  });

  test('ls --tag sends a comma-separated tag filter', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'GET /api/v1/library': () => jsonResponse({ items: [], next_cursor: null }) },
    });
    assert.equal(await h.exec(['ls', '--tag', 'ai, rag']), 0);
    assert.equal(new URL(h.calls[0].url).searchParams.get('tag'), 'ai,rag');
    assert.equal(h.stdout, 'No documents.\n');
  });
});

describe('run: auth commands', () => {
  test('login --key validates via /me, saves the config privately and masks the key', async () => {
    const configDir = path.join(tmp, 'login-cfg');
    const h = harness({
      configDir,
      routes: {
        'GET /api/v1/me': (call) => {
          assert.equal(call.headers.authorization, `Bearer ${KEY}`);
          return jsonResponse({ id: 'u1', email: 'me@example.com', role: 'owner', plan: 'pro', scopes: ['convert'] });
        },
      },
    });
    assert.equal(await h.exec(['login', '--key', KEY]), 0);
    const file = path.join(configDir, 'anymd', 'config.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { api_key: KEY });
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(h.stdout, /Logged in as me@example\.com \(owner, pro\)/);
    assert.ok(!h.stdout.includes(KEY) && !h.stderr.includes(KEY), 'full key must never be printed');
    assert.match(h.stdout, /amd_live…WXYZ/);

    // the saved key is picked up by later commands and shown masked
    const who = harness({ configDir, routes: { 'GET /api/v1/me': () => jsonResponse({ email: 'me@example.com', scopes: ['convert', 'library:read'] }) } });
    assert.equal(await who.exec(['whoami']), 0);
    assert.match(who.stdout, /key {4}amd_live…WXYZ \(from config\)/);
    assert.match(who.stdout, /scopes {1}convert, library:read/);
    assert.ok(!who.stdout.includes(KEY));

    const out = harness({ configDir });
    assert.equal(await out.exec(['logout']), 0);
    await assert.rejects(stat(file), { code: 'ENOENT' });
  });

  test('login prompts for a key and does not save an invalid one', async () => {
    const configDir = path.join(tmp, 'prompt-cfg');
    const h = harness({
      configDir,
      prompt: async () => `  ${KEY}  `,
      routes: { 'GET /api/v1/me': () => jsonResponse({ error: { code: 'invalid_api_key', message: `Key ${KEY} is revoked` } }, 401) },
    });
    assert.equal(await h.exec(['login']), 1);
    assert.match(h.stderr, /invalid_api_key: Key amd_live…WXYZ is revoked/);
    assert.ok(!h.stderr.includes(KEY));
    await assert.rejects(stat(path.join(configDir, 'anymd', 'config.json')), { code: 'ENOENT' });
  });

  test('login rejects keys without the amd_ prefix', async () => {
    const h = harness();
    assert.equal(await h.exec(['login', '--key', 'sk-nope']), 1);
    assert.match(h.stderr, /^invalid_key:/);
    assert.equal(h.calls.length, 0);
  });
});

describe('run: pages and mcp', () => {
  test('pages ops with a bare array fetches the current revision first', async () => {
    const opsFile = path.join(tmp, 'ops.json');
    await writeFile(opsFile, JSON.stringify([{ op: 'remove', blockId: 'b1' }]));
    let posted;
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'GET /api/v1/admin/pages/pg_1': () => jsonResponse({ page: { id: 'pg_1', revision: 7 } }),
        'POST /api/v1/admin/pages/pg_1/ops': (call) => {
          posted = JSON.parse(call.body);
          return jsonResponse({ revision: 8 });
        },
      },
    });
    assert.equal(await h.exec(['pages', 'ops', 'pg_1', '--file', opsFile]), 0);
    assert.deepEqual(posted, { ops: [{ op: 'remove', blockId: 'b1' }], baseRevision: 7 });
    assert.equal(h.stdout, 'Applied 1 op(s) to page pg_1; now at revision 8\n');
  });

  test('pages ops surfaces revision conflicts with a hint', async () => {
    const opsFile = path.join(tmp, 'ops-stale.json');
    await writeFile(opsFile, JSON.stringify({ baseRevision: 1, ops: [] }));
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'POST /api/v1/admin/pages/pg_1/ops': () =>
          jsonResponse({ error: { code: 'revision_conflict', message: 'Page is at revision 3' } }, 409),
      },
    });
    assert.equal(await h.exec(['pages', 'ops', 'pg_1', '--file', opsFile]), 1);
    assert.match(h.stderr, /^revision_conflict: Page is at revision 3\nhint: .*pages get/);
  });

  test('pages create requires --slug and --title, then posts them', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: { 'POST /api/v1/admin/pages': (call) => jsonResponse({ id: 'pg_2', ...JSON.parse(call.body), revision: 1 }) },
    });
    assert.equal(await h.exec(['pages', 'create', '--slug', 'launch']), 1);
    assert.equal(await h.exec(['pages', 'create', '--slug', 'launch', '--title', 'Launch', '--template', 'ads-landing']), 0);
    assert.deepEqual(JSON.parse(h.calls[0].body), { slug: 'launch', title: 'Launch', template: 'ads-landing' });
    assert.equal(h.stdout, 'Created page pg_2 (/p/launch) at revision 1\n');
  });

  test('pages ls and blocks print tables', async () => {
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'GET /api/v1/admin/pages': () => jsonResponse({ pages: [{ id: 'pg_1', status: 'published', slug: 'home', revision: 4, title: 'Home' }] }),
        'GET /api/v1/admin/blocks': () => jsonResponse({ blocks: [{ type: 'columns', sizes: ['small', 'large'], slots: ['left', 'right'], description: 'Two columns' }] }),
      },
    });
    assert.equal(await h.exec(['pages', 'ls']), 0);
    assert.equal(await h.exec(['pages', 'blocks']), 0);
    assert.match(h.stdout, /pg_1\s+published\s+home\s+4\s+-\s+Home/);
    assert.match(h.stdout, /columns\s+small\|large\s+left\|right\s+Two columns/);
  });

  test('mcp prints client snippets without the full key', async () => {
    const h = harness({ env: { ANYMD_API_KEY: KEY, ANYMD_BASE_URL: 'https://staging.anymd.cc' } });
    assert.equal(await h.exec(['mcp']), 0);
    assert.ok(h.stdout.includes(
      'claude mcp add --transport http anymd https://staging.anymd.cc/mcp --header "Authorization: Bearer <key>"',
    ));
    assert.match(h.stdout, /"url": "https:\/\/staging\.anymd\.cc\/mcp"/);
    assert.match(h.stdout, /mcp-remote/);
    assert.match(h.stdout, /current: amd_live…WXYZ/);
    assert.ok(!h.stdout.includes(KEY));
    assert.equal(h.calls.length, 0);
  });
});

describe('run: social search', () => {
  const post = { platform: 'x', id: '1', url: 'https://x.com/a/status/1', author: { name: 'A', handle: 'a', url: 'https://x.com/a' }, text: 'Hello\nworld', published_at: '2026-10-10T08:00:00.000Z', stats: { likes: 3, replies: null, reposts: 1, views: null }, media: [] };

  test('posts platform, query and cursor, prints posts and the next-page hint', async () => {
    let body;
    const h = harness({
      env: { ANYMD_API_KEY: KEY },
      routes: {
        'POST /api/v1/social/search': (call) => {
          body = JSON.parse(call.body);
          return jsonResponse({ platform: 'x', query: 'cloudflare workers', count: 1, results: [post], next_cursor: 'c2', credits: 10 });
        },
      },
    });
    assert.equal(await h.exec(['social', 'x', 'cloudflare', 'workers', '--cursor', 'c1']), 0);
    assert.deepEqual(body, { platform: 'x', query: 'cloudflare workers', cursor: 'c1' });
    assert.match(h.stdout, /1\. @a {2}2026-10-10 {2}3 likes · 1 reposts\n {3}Hello world\n {3}https:\/\/x\.com\/a\/status\/1\n/);
    assert.equal(h.stderr, `10 credits · more: anymd social x "cloudflare workers" --cursor 'c2'\n`);
  });

  test('all tags each post with its platform and reports failed platforms', async () => {
    const payload = {
      platform: 'all', query: 'q', count: 1, results: [{ ...post, platform: 'linkedin' }], next_cursor: null, credits: 100,
      platforms: [{ platform: 'x', count: 0, credits: 0, error: null }, { platform: 'facebook', count: 0, credits: 0, error: 'upstream_error: down' }, { platform: 'linkedin', count: 1, credits: 100, error: null }],
    };
    const h = harness({ env: { ANYMD_API_KEY: KEY }, routes: { 'POST /api/v1/social/search': () => jsonResponse(payload) } });
    assert.equal(await h.exec(['social', 'all', 'q']), 0);
    assert.match(h.stdout, /^1\. \[linkedin\] @a/);
    assert.equal(h.stderr, 'facebook failed: upstream_error: down\n100 credits\n');
  });

  test('--json prints the raw payload and empty pages say so', async () => {
    const payload = { platform: 'threads', query: 'q', count: 0, results: [], next_cursor: null, credits: 0 };
    const h = harness({ env: { ANYMD_API_KEY: KEY }, routes: { 'POST /api/v1/social/search': () => jsonResponse(payload) } });
    assert.equal(await h.exec(['social', 'threads', 'q', '--json']), 0);
    assert.deepEqual(JSON.parse(h.stdout), payload);
    const h2 = harness({ env: { ANYMD_API_KEY: KEY }, routes: { 'POST /api/v1/social/search': () => jsonResponse(payload) } });
    assert.equal(await h2.exec(['social', 'threads', 'q']), 0);
    assert.equal(h2.stdout, 'No results.\n');
  });

  test('validates the platform and requires a key before calling the API', async () => {
    const bad = harness({ env: { ANYMD_API_KEY: KEY } });
    assert.equal(await bad.exec(['social', 'myspace', 'q']), 1);
    assert.match(bad.stderr, /platform must be one of all, x, facebook, instagram, threads, linkedin/);
    const missing = harness({ env: { ANYMD_API_KEY: KEY } });
    assert.equal(await missing.exec(['social', 'x']), 1);
    assert.match(missing.stderr, /^usage:/);
    const anon = harness();
    assert.equal(await anon.exec(['social', 'x', 'q']), 1);
    assert.match(anon.stderr, /^not_authenticated:/);
    assert.equal(bad.calls.length + missing.calls.length + anon.calls.length, 0);
  });
});
