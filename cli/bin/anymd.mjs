#!/usr/bin/env node
// anymd — convert any URL or file to clean Markdown with anymd.cc, search your library,
// and manage pages. Zero dependencies; requires Node.js >= 18 (global fetch, FormData, Blob).
import { readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE = 'https://anymd.cc';
export const VERSION = readVersion();

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const SEARCH_MODES = ['hybrid', 'bm25', 'fulltext', 'semantic'];
const SOCIAL_PLATFORMS = ['all', 'x', 'facebook', 'instagram', 'threads', 'linkedin'];
const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CliError extends Error {
  constructor(code, message, { hint, status } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

const usageError = (message) =>
  new CliError('usage', message, { hint: 'Run `anymd --help` for usage.' });

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const LONG_VALUE = {
  key: 'key', base: 'base', output: 'output', mode: 'mode', limit: 'limit',
  domain: 'domain', slug: 'slug', title: 'title', template: 'template', file: 'file',
  tag: 'tag', add: 'add', remove: 'remove', set: 'set', cursor: 'cursor',
  'max-comments': 'maxComments', 'max-images': 'maxImages', 'max-credits': 'maxCredits', 'max-thread-posts': 'maxThreadPosts',
};
const LONG_BOOL = {
  json: 'json', 'no-save': 'noSave', fresh: 'fresh', help: 'help', version: 'version',
  'expand-thread': 'expandThread', 'no-expand-thread': 'noExpandThread',
  'include-comments': 'includeComments', 'no-include-comments': 'noIncludeComments',
  'analyze-images': 'analyzeImages', 'no-analyze-images': 'noAnalyzeImages',
  'keep-images': 'keepImages', 'no-images': 'noImages',
};

/** Bounded reading options; must match READING_LIMITS on the server (src/lib/reading-options.ts). */
export const READING_LIMITS = { maxThreadPosts: [1, 100], maxComments: [1, 1000], maxImages: [1, 20], maxCredits: [1, 1000] };
const READING_TOGGLES = [['expandThread', 'noExpandThread', 'expand-thread'], ['includeComments', 'noIncludeComments', 'include-comments'], ['analyzeImages', 'noAnalyzeImages', 'analyze-images']];

/**
 * Reading options given explicitly on the command line. Anything omitted is left to the account's
 * saved reading defaults on the server (and those default to off).
 */
export function readingOptionsFromFlags(flags) {
  const out = {};
  for (const [name, [min, max]] of Object.entries(READING_LIMITS)) {
    if (flags[name] === undefined) continue;
    const value = Number(flags[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw usageError(`${name} must be an integer between ${min} and ${max}`);
    out[name] = value;
  }
  for (const [on, off, flag] of READING_TOGGLES) {
    if (flags[on] && flags[off]) throw usageError(`--${flag} and --no-${flag} cannot be combined`);
    if (flags[on]) out[on] = true;
    if (flags[off]) out[on] = false;
  }
  if (flags.keepImages && flags.noImages) throw usageError('--keep-images and --no-images cannot be combined');
  if (flags.keepImages) out.removeImages = false;
  if (flags.noImages) out.removeImages = true;
  return out;
}
const SHORT = { h: 'help', v: 'version', o: 'output' };

/** Parse argv into `{ flags, positionals }`. Supports `--name value`, `--name=value`, `-o value` and `--`. */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    let name;
    let value;
    if (arg.startsWith('--')) {
      name = arg.slice(2);
      const eq = name.indexOf('=');
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
    } else {
      const short = SHORT[arg.slice(1)];
      if (!short) throw usageError(`unknown option ${arg}`);
      name = short;
    }
    if (Object.hasOwn(LONG_VALUE, name)) {
      if (value === undefined) {
        if (i + 1 >= argv.length) throw usageError(`option ${arg} requires a value`);
        value = argv[++i];
      }
      flags[LONG_VALUE[name]] = value;
    } else if (Object.hasOwn(LONG_BOOL, name)) {
      if (value !== undefined) throw usageError(`option --${name} does not take a value`);
      flags[LONG_BOOL[name]] = true;
    } else {
      throw usageError(`unknown option ${arg}`);
    }
  }
  return { flags, positionals };
}

const DOMAIN_RE =
  /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/** True when `value` is an http(s) URL or a bare domain such as `example.com/post`. */
export function looksLikeUrl(value) {
  return typeof value === 'string' && (/^https?:\/\/\S+$/i.test(value) || DOMAIN_RE.test(value));
}

/** Add `https://` to bare domains and validate the result. */
export function normalizeTargetUrl(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new CliError('invalid_url', `not a valid URL: ${value}`);
  }
  if (!parsed.hostname) throw new CliError('invalid_url', `not a valid URL: ${value}`);
  // The fragment never reaches a server and would swallow our own query string.
  const hash = withScheme.indexOf('#');
  return hash === -1 ? withScheme : withScheme.slice(0, hash);
}

export function normalizeBase(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError('invalid_base_url', `not a valid base URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CliError('invalid_base_url', `base URL must use http or https: ${value}`);
  }
  return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
}

/** Mask an API key as `amd_xxxx…last4`; never reveals more than 8 leading and 4 trailing chars. */
export function maskKey(key) {
  if (!key) return '';
  if (key.length < 16) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** `$XDG_CONFIG_HOME/anymd/config.json`, `%APPDATA%\anymd\config.json` on Windows, else `~/.config/anymd/config.json`. */
export function configPath({ env, platform, homedir }) {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'anymd', 'config.json');
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'anymd', 'config.json');
  }
  return path.join(homedir, '.config', 'anymd', 'config.json');
}

export async function loadConfig(file, warn = () => {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    warn(`cannot read config ${file}: ${err.message}`);
    return {};
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // fall through to the warning below
  }
  warn(`ignoring invalid config file ${file} (run \`anymd login\` to rewrite it)`);
  return {};
}

export async function saveConfig(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(file, 0o600); // tighten a pre-existing file; a no-op where POSIX modes are unsupported
  } catch {
    // Windows / exotic filesystems: ACLs govern access instead.
  }
}

const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Precedence: flags > env (ANYMD_API_KEY / ANYMD_BASE_URL) > config file > default base. */
export function resolveSettings(flags, env, fileConfig) {
  const sources = [
    ['flag', nonEmpty(flags.key), nonEmpty(flags.base)],
    ['env', nonEmpty(env.ANYMD_API_KEY), nonEmpty(env.ANYMD_BASE_URL)],
    ['config', nonEmpty(fileConfig.api_key), nonEmpty(fileConfig.base_url)],
  ];
  const keyEntry = sources.find(([, key]) => key);
  const baseEntry = sources.find(([, , base]) => base);
  return {
    key: keyEntry?.[1],
    keySource: keyEntry?.[0],
    base: normalizeBase(baseEntry?.[2] ?? DEFAULT_BASE),
  };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function makeColors(enabled) {
  const wrap = (open, close) => (text) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
  return {
    bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39),
    yellow: wrap(33, 39), cyan: wrap(36, 39),
  };
}

const truncate = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const pick = (obj, ...names) => {
  for (const name of names) if (obj?.[name] !== undefined && obj[name] !== null) return obj[name];
  return undefined;
};
const pickArray = (data, ...names) => {
  if (Array.isArray(data)) return data;
  for (const name of names) if (Array.isArray(data?.[name])) return data[name];
  return [];
};
const toJson = (data) => `${JSON.stringify(data, null, 2)}\n`;

export function formatDate(value) {
  if (value === undefined || value === null || value === '') return '-';
  let date;
  if (typeof value === 'number') date = new Date(value < 1e12 ? value * 1000 : value);
  else date = new Date(/^\d+$/.test(value) ? Number(value) * (value.length <= 10 ? 1000 : 1) : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

/** Render rows as a padded plain-text table. The last column is never padded. */
export function formatTable(headers, rows, colors = makeColors(false)) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) =>
    cells.map((cell, i) => (i === cells.length - 1 ? String(cell) : String(cell).padEnd(widths[i]))).join('  ');
  return [colors.bold(line(headers)), ...rows.map(line)].join('\n') + '\n';
}

/** Render a JSON object as indented `key: value` lines; arrays are summarised. */
export function formatKeyValues(obj, indent = '') {
  let out = '';
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (Array.isArray(value)) {
      const scalar = value.every((v) => v === null || typeof v !== 'object');
      out += scalar && value.length <= 20
        ? `${indent}${key}: ${value.length ? value.join(', ') : '-'}\n`
        : `${indent}${key}: ${value.length} entries (use --json for details)\n`;
    } else if (value && typeof value === 'object') {
      out += `${indent}${key}:\n${formatKeyValues(value, `${indent}  `)}`;
    } else {
      out += `${indent}${key}: ${value ?? '-'}\n`;
    }
  }
  return out;
}

/** Remove `<mark>` highlight tags from a search snippet (optionally re-highlighting with ANSI). */
export function stripMark(snippet, highlight = (s) => s) {
  return String(snippet ?? '').replace(/<mark>([\s\S]*?)<\/mark>/gi, (_, inner) => highlight(inner)).replace(/<\/?mark>/gi, '');
}

export function formatSearchResults(results, colors = makeColors(false)) {
  if (!results.length) return 'No results.\n';
  const width = String(results.length).length;
  return results
    .map((item, index) => {
      const rawScore = pick(item, 'score', 'rrf', 'rank');
      const score = typeof rawScore === 'number' ? rawScore.toFixed(3) : '    -';
      const title = oneLine(pick(item, 'title') || pick(item, 'url', 'source_url') || 'Untitled');
      const url = pick(item, 'url', 'source_url', 'sourceUrl') ?? '';
      const id = pick(item, 'id', 'doc_id', 'docId');
      const snippet = truncate(oneLine(stripMark(pick(item, 'snippet', 'excerpt') ?? '', colors.yellow)), 240);
      const pad = ' '.repeat(width + 2);
      let block = `${String(index + 1).padStart(width)}. ${colors.dim(score)}  ${colors.bold(title)}\n`;
      if (url || id) block += `${pad}${colors.cyan(url)}${id ? colors.dim(`${url ? '  ' : ''}id:${id}`) : ''}\n`;
      if (snippet) block += `${pad}${snippet}\n`;
      return block;
    })
    .join('\n');
}

/** Social search results: author and date, the post text, then its link. */
export function formatSocialResults(results, colors = makeColors(false), { showPlatform = false } = {}) {
  if (!results.length) return 'No results.\n';
  const width = String(results.length).length;
  const pad = ' '.repeat(width + 2);
  return results
    .map((item, index) => {
      const author = item.author ?? {};
      const who = author.handle ? `@${author.handle}` : author.name || 'unknown';
      const when = item.published_at ? item.published_at.slice(0, 10) : '';
      const stats = item.stats ?? {};
      const counts = [['likes', stats.likes], ['replies', stats.replies], ['reposts', stats.reposts], ['views', stats.views]]
        .filter(([, n]) => typeof n === 'number')
        .map(([label, n]) => `${n} ${label}`)
        .join(' · ');
      const tag = showPlatform && item.platform ? colors.dim(`[${item.platform}] `) : '';
      let block = `${String(index + 1).padStart(width)}. ${tag}${colors.bold(who)}${when ? colors.dim(`  ${when}`) : ''}${counts ? colors.dim(`  ${counts}`) : ''}\n`;
      const text = truncate(oneLine(item.text ?? ''), 280);
      if (text) block += `${pad}${text}\n`;
      block += `${pad}${colors.cyan(item.url)}\n`;
      return block;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function requireKey(ctx) {
  if (!ctx.key) {
    throw new CliError('not_authenticated', 'this command needs an API key', {
      hint: 'Run `anymd login`, pass --key amd_…, or set ANYMD_API_KEY.',
    });
  }
}

const ERROR_HINTS = {
  anonymous_limit: 'Free anonymous conversions are used up for today. Run `anymd login` to use your API key.',
  revision_conflict: 'The page changed since your base revision. Re-read it with `anymd pages get <id>` and retry.',
};

async function errorFromResponse(res, authed) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    // body unreadable: keep the status-derived message
  }
  let code = `http_${res.status}`;
  let message = res.statusText || 'request failed';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (text.trim() && text.length <= 500 && !/^\s*</.test(text)) message = text.trim();
  }
  const body = parsed?.error;
  if (body && typeof body === 'object') {
    if (body.code) code = String(body.code);
    if (body.message) message = String(body.message);
  } else if (typeof body === 'string') {
    message = body;
  }
  let hint = ERROR_HINTS[code];
  if (!hint && res.status === 429 && !authed) hint = ERROR_HINTS.anonymous_limit;
  if (!hint && res.status === 401) hint = 'Check your API key or run `anymd login`.';
  return new CliError(code, message, { hint, status: res.status });
}

/** Perform a request against `ctx.base`; throws `CliError` for network failures and non-2xx responses. */
async function request(ctx, method, apiPath, { query, json, form, auth = true, accept = 'application/json' } = {}) {
  if (auth) requireKey(ctx);
  let url = ctx.base + apiPath;
  const params = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (params.length) url += (apiPath.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();

  const headers = { 'user-agent': `anymd-cli/${VERSION} node/${process.versions.node}`, accept };
  if (auth) headers.authorization = `Bearer ${ctx.key}`;
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // fetch sets the multipart boundary
  }

  let res;
  try {
    res = await ctx.io.fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new CliError('timeout', `request to ${ctx.base} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new CliError('network_error', `could not reach ${ctx.base}: ${err?.cause?.message ?? err?.message ?? err}`);
  }
  if (!res.ok) throw await errorFromResponse(res, auth);
  return res;
}

async function readJson(res) {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('invalid_response', `expected JSON from the server (HTTP ${res.status})`);
  }
}

const isJsonResponse = (res) => /\bjson\b/i.test(res.headers.get('content-type') ?? '');

/** Turn a conversion response into printable text: pretty JSON with --json, otherwise Markdown. */
async function conversionText(res, wantJson) {
  if (!isJsonResponse(res)) return res.text();
  const data = await readJson(res);
  if (wantJson) return toJson(data);
  const markdown = pick(data, 'markdown', 'content') ?? pick(data?.document, 'markdown', 'content');
  return typeof markdown === 'string' ? markdown : toJson(data);
}

/** Print to stdout, or write to `-o <file>` and report a short summary on stderr. */
async function emit(ctx, text, res) {
  const content = text.endsWith('\n') ? text : `${text}\n`;
  if (!ctx.flags.output) {
    ctx.out(content);
    return;
  }
  try {
    await writeFile(ctx.flags.output, content);
  } catch (err) {
    throw new CliError('write_failed', `cannot write ${ctx.flags.output}: ${err.message}`);
  }
  const meta = [];
  const credits = res?.headers.get('x-anymd-credits');
  const cache = res?.headers.get('x-anymd-cache');
  if (credits) meta.push(`credits ${credits}`);
  if (cache) meta.push(`cache ${cache}`);
  const size = Buffer.byteLength(content);
  ctx.err(`Saved ${ctx.flags.output} (${size} bytes${meta.length ? `, ${meta.join(', ')}` : ''})\n`);
}

function expectArgs(args, count, usage) {
  if (args.length !== count) throw usageError(`usage: ${usage}`);
  return args;
}

function parseLimit(value, fallback, max) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || (max && n > max)) {
    throw usageError(`--limit must be an integer between 1 and ${max ?? 'the server maximum'}`);
  }
  return n;
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdConvert(ctx, args) {
  const [raw] = expectArgs(args, 1, 'anymd convert <url> [--json] [-o file] [--no-save] [--fresh]');
  const target = normalizeTargetUrl(raw);
  const { json, noSave, fresh } = ctx.flags;
  const extras = readingOptionsFromFlags(ctx.flags);
  if (extras.expandThread || extras.includeComments || extras.analyzeImages) requireKey(ctx);
  let res;
  if (ctx.key) {
    const body = { url: target, format: json ? 'json' : 'markdown', ...extras };
    if (noSave) body.save = false;
    if (fresh) body.fresh = true;
    res = await request(ctx, 'POST', '/api/v1/convert', {
      json: body,
      accept: json ? 'application/json' : 'text/markdown, application/json;q=0.9',
    });
  } else {
    const { removeImages, ...rest } = extras;
    const urlOptions = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : v]));
    res = await request(ctx, 'GET', `/${target}`, {
      auth: false,
      query: { format: json ? 'json' : undefined, fresh: fresh ? '1' : undefined, save: noSave ? '0' : undefined, images: removeImages === undefined ? undefined : removeImages ? '0' : '1', ...urlOptions },
      accept: json ? 'application/json' : 'text/markdown',
    });
  }
  await emit(ctx, await conversionText(res, json), res);
}

async function cmdFile(ctx, args) {
  const [filePath] = expectArgs(args, 1, 'anymd file <path> [--json] [-o file]');
  requireKey(ctx);
  let info;
  try {
    info = await stat(filePath);
  } catch (err) {
    throw new CliError('file_not_found', `cannot read ${filePath}: ${err.code ?? err.message}`);
  }
  if (!info.isFile()) throw new CliError('invalid_file', `${filePath} is not a regular file`);
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new CliError('file_too_large', `${filePath} is ${(info.size / 1048576).toFixed(1)} MB; the limit is 20 MB`);
  }
  const bytes = await readFile(filePath);
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), path.basename(filePath));
  const res = await request(ctx, 'POST', '/api/v1/convert/file', { form });
  await emit(ctx, await conversionText(res, ctx.flags.json), res);
}

async function cmdSearch(ctx, args) {
  const q = args.join(' ').trim();
  if (!q) throw usageError('usage: anymd search <query> [--mode hybrid] [--limit 10] [--json]');
  const mode = ctx.flags.mode ?? 'hybrid';
  if (!SEARCH_MODES.includes(mode)) throw usageError(`--mode must be one of ${SEARCH_MODES.join(', ')}`);
  const limit = parseLimit(ctx.flags.limit, 10, 50);
  const data = await readJson(await request(ctx, 'GET', '/api/v1/search', { query: { q, mode, limit } }));
  if (ctx.flags.json) return ctx.out(toJson(data));
  ctx.out(formatSearchResults(pickArray(data, 'results', 'items', 'hits'), ctx.colors));
}

async function cmdSocial(ctx, args) {
  const [platform, ...words] = args;
  const query = words.join(' ').trim();
  if (!platform || !query) throw usageError(`usage: anymd social <${SOCIAL_PLATFORMS.join('|')}> <query> [--cursor c] [--json]`);
  if (!SOCIAL_PLATFORMS.includes(platform)) throw usageError(`platform must be one of ${SOCIAL_PLATFORMS.join(', ')}`);
  requireKey(ctx);
  const json = { platform, query };
  if (ctx.flags.cursor) json.cursor = ctx.flags.cursor;
  const data = await readJson(await request(ctx, 'POST', '/api/v1/social/search', { json }));
  if (ctx.flags.json) return ctx.out(toJson(data));
  ctx.out(formatSocialResults(pickArray(data, 'results'), ctx.colors, { showPlatform: platform === 'all' }));
  for (const p of pickArray(data, 'platforms')) if (p?.error) ctx.err(`${p.platform} failed: ${p.error}\n`);
  const credits = typeof data?.credits === 'number' ? `${data.credits} credits` : '';
  ctx.err(`${credits}${data?.next_cursor ? `${credits ? ' · ' : ''}more: anymd social ${platform} ${JSON.stringify(query)} --cursor '${data.next_cursor}'` : ''}${credits || data?.next_cursor ? '\n' : ''}`);
}

async function cmdList(ctx, args) {
  expectArgs(args, 0, 'anymd ls [--limit 20] [--domain x] [--tag a,b]');
  const limit = parseLimit(ctx.flags.limit, 20);
  const tag = ctx.flags.tag === undefined ? undefined : parseTagList(ctx.flags.tag, '--tag').join(',') || undefined;
  const data = await readJson(
    await request(ctx, 'GET', '/api/v1/library', { query: { limit, domain: ctx.flags.domain, tag } }),
  );
  if (ctx.flags.json) return ctx.out(toJson(data));
  const items = pickArray(data, 'items', 'documents');
  if (!items.length) return ctx.out('No documents.\n');
  const rows = items.map((d) => [
    pick(d, 'id') ?? '-',
    pick(d, 'kind') ?? '-',
    formatDate(pick(d, 'created_at', 'createdAt')),
    truncate(oneLine(pick(d, 'title') || pick(d, 'url', 'source_url') || 'Untitled'), 70),
  ]);
  ctx.out(formatTable(['ID', 'KIND', 'CREATED', 'TITLE'], rows, ctx.colors));
  const next = pick(data, 'next_cursor', 'nextCursor');
  if (next !== undefined) ctx.out(ctx.colors.dim(`More documents available (next_cursor: ${next})\n`));
}

async function cmdGet(ctx, args) {
  const [id] = expectArgs(args, 1, 'anymd get <id> [--json] [-o file]');
  const res = await request(ctx, 'GET', `/api/v1/library/${enc(id)}`, {
    query: { format: ctx.flags.json ? undefined : 'md' },
    accept: ctx.flags.json ? 'application/json' : 'text/markdown, application/json;q=0.9',
  });
  await emit(ctx, await conversionText(res, ctx.flags.json), res);
}

/** A background YouTube video download started by a conversion (account setting downloadVideo). */
async function cmdVideo(ctx, args) {
  const [id] = expectArgs(args, 1, 'anymd video <id> [--json]');
  const job = await readJson(await request(ctx, 'GET', `/api/v1/videos/${enc(id)}`));
  if (ctx.flags.json) return ctx.out(toJson(job));
  const lines = [['id', job.id], ['status', job.status], ['quality', job.quality], ['cdn_url', job.cdn_url], ['credits', job.credits], ['error', job.error]];
  const analysis = job.analysis;
  if (analysis) lines.push(['analysis', `${analysis.status} (${analysis.model}${analysis.credits ? `, ${analysis.credits} credits` : ''}${analysis.error ? `, ${analysis.error}` : ''})`]);
  ctx.out(lines.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k.padEnd(9)}${v}\n`).join(''));
  if (analysis?.status === 'ready' && analysis.markdown) ctx.out(`\n${analysis.markdown}\n`);
  const running = job.status === 'queued' || job.status === 'downloading' || (job.status === 'ready' && (analysis?.status === 'queued' || analysis?.status === 'running'));
  if (running) ctx.out(ctx.colors.dim('Still running: check again in 15–30 seconds.\n'));
}

async function cmdRemove(ctx, args) {
  const [id] = expectArgs(args, 1, 'anymd rm <id>');
  await request(ctx, 'DELETE', `/api/v1/library/${enc(id)}`);
  ctx.out(`Deleted ${id}\n`);
}

/** Split a comma-separated flag value into trimmed, non-empty tags. */
export function parseTagList(value, flag) {
  const tags = String(value).split(',').map((t) => t.trim()).filter(Boolean);
  if (tags.some((t) => t.length > 40)) throw usageError(`${flag}: tags can be at most 40 characters`);
  return tags;
}

async function cmdTag(ctx, args) {
  const usage = 'anymd tag <id> [--add a,b] [--remove c] | --set a,b';
  const [id] = expectArgs(args, 1, usage);
  const body = {};
  if (ctx.flags.add !== undefined) body.add = parseTagList(ctx.flags.add, '--add');
  if (ctx.flags.remove !== undefined) body.remove = parseTagList(ctx.flags.remove, '--remove');
  if (ctx.flags.set !== undefined) body.set = parseTagList(ctx.flags.set, '--set');
  if (body.set && (body.add || body.remove)) throw usageError('use either --set, or --add and/or --remove, not both');
  for (const flag of ['add', 'remove']) if (body[flag]?.length === 0) throw usageError(`--${flag} needs at least one tag (use --set "" to clear all tags)`);
  if (!body.set && !body.add && !body.remove) throw usageError(`usage: ${usage}`);
  const data = await readJson(await request(ctx, 'POST', `/api/v1/library/${enc(id)}/tags`, { json: body }));
  if (ctx.flags.json) return ctx.out(toJson(data));
  const tags = pickArray(data, 'tags');
  ctx.out(tags.length ? `${tags.map((t) => `#${t}`).join(' ')}\n` : 'No tags.\n');
}

async function cmdTags(ctx, args) {
  expectArgs(args, 0, 'anymd tags [--limit 100] [--json]');
  const limit = parseLimit(ctx.flags.limit, 100, 500);
  const data = await readJson(await request(ctx, 'GET', '/api/v1/library/tags', { query: { limit } }));
  if (ctx.flags.json) return ctx.out(toJson(data));
  const items = pickArray(data, 'items');
  if (!items.length) return ctx.out('No tags.\n');
  ctx.out(formatTable(['TAG', 'DOCS'], items.map((t) => [pick(t, 'tag') ?? '-', String(pick(t, 'count') ?? 0)]), ctx.colors));
}

async function cmdUsage(ctx, args) {
  expectArgs(args, 0, 'anymd usage [--json]');
  const data = await readJson(await request(ctx, 'GET', '/api/v1/usage'));
  ctx.out(ctx.flags.json ? toJson(data) : formatKeyValues(data));
}

async function cmdLogin(ctx, args) {
  expectArgs(args, 0, 'anymd login [--key amd_…]');
  let key = nonEmpty(ctx.flags.key);
  if (!key) {
    ctx.err(`Create an API key in Dashboard → API keys at ${ctx.base}\n`);
    key = nonEmpty(await ctx.io.prompt('API key: '));
  }
  if (!key) throw new CliError('invalid_key', 'no API key entered');
  if (!key.startsWith('amd_')) throw new CliError('invalid_key', 'anymd API keys start with "amd_"');
  ctx.secrets.push(key);

  const me = await readJson(await request({ ...ctx, key }, 'GET', '/api/v1/me'));
  const config = await loadConfig(ctx.configFile, ctx.warn);
  config.api_key = key;
  if (ctx.flags.base) config.base_url = ctx.base;
  try {
    await saveConfig(ctx.configFile, config);
  } catch (err) {
    throw new CliError('config_write_failed', `cannot write ${ctx.configFile}: ${err.message}`);
  }
  const who = pick(me, 'email', 'name', 'id') ?? 'unknown user';
  const detail = [pick(me, 'role'), pick(me, 'plan')].filter(Boolean).join(', ');
  ctx.out(`Logged in as ${ctx.colors.bold(who)}${detail ? ` (${detail})` : ''}.\n`);
  ctx.out(`Saved key ${maskKey(key)} to ${ctx.configFile}\n`);
}

async function cmdLogout(ctx, args) {
  expectArgs(args, 0, 'anymd logout');
  const config = await loadConfig(ctx.configFile, ctx.warn);
  if (!config.api_key) {
    ctx.out('No saved API key.\n');
  } else {
    delete config.api_key;
    try {
      if (Object.keys(config).length) await saveConfig(ctx.configFile, config);
      else await unlink(ctx.configFile);
    } catch (err) {
      throw new CliError('config_write_failed', `cannot update ${ctx.configFile}: ${err.message}`);
    }
    ctx.out(`Removed saved API key from ${ctx.configFile}\n`);
  }
  if (nonEmpty(ctx.io.env.ANYMD_API_KEY)) ctx.warn('ANYMD_API_KEY is still set in your environment');
}

async function cmdWhoami(ctx, args) {
  expectArgs(args, 0, 'anymd whoami [--json]');
  const me = await readJson(await request(ctx, 'GET', '/api/v1/me'));
  if (ctx.flags.json) return ctx.out(toJson(me));
  const scopes = Array.isArray(me.scopes) ? me.scopes.join(', ') : me.scopes;
  const lines = [
    ['email', me.email], ['name', me.name], ['role', me.role], ['plan', me.plan], ['scopes', scopes],
    ['key', `${maskKey(ctx.key)} (from ${ctx.keySource})`], ['base', ctx.base],
  ];
  ctx.out(lines.filter(([, v]) => v).map(([k, v]) => `${k.padEnd(7)}${v}\n`).join(''));
}

const unwrapPage = (data) => (data?.page && typeof data.page === 'object' ? data.page : data);

async function readOpsFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new CliError('file_not_found', `cannot read ${file}: ${err.code ?? err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new CliError('invalid_ops_file', `${file} is not valid JSON: ${err.message}`);
  }
  if (Array.isArray(data)) return { ops: data };
  if (data && typeof data === 'object' && Array.isArray(data.ops)) return { ...data };
  throw new CliError('invalid_ops_file', `${file} must contain an ops array or {"baseRevision", "ops": [...]}`);
}

const PAGES_USAGE =
  'anymd pages ls | get <id> | create --slug <slug> --title <title> [--template <t>] | ops <id> --file ops.json | publish <id> | blocks';

async function cmdPages(ctx, args) {
  const [sub, ...rest] = args;
  const { json } = ctx.flags;
  switch (sub) {
    case 'ls':
    case 'list': {
      expectArgs(rest, 0, 'anymd pages ls');
      const data = await readJson(await request(ctx, 'GET', '/api/v1/admin/pages'));
      if (json) return ctx.out(toJson(data));
      const pages = pickArray(data, 'pages', 'items');
      if (!pages.length) return ctx.out('No pages.\n');
      const rows = pages.map((p) => [
        pick(p, 'id') ?? '-',
        pick(p, 'status') ?? (p.published_at || p.publishedAt ? 'published' : 'draft'),
        pick(p, 'slug') ?? '-',
        pick(p, 'revision') ?? '-',
        formatDate(pick(p, 'updated_at', 'updatedAt')),
        truncate(oneLine(pick(p, 'title') ?? ''), 60),
      ]);
      return ctx.out(formatTable(['ID', 'STATUS', 'SLUG', 'REV', 'UPDATED', 'TITLE'], rows, ctx.colors));
    }
    case 'get': {
      const [id] = expectArgs(rest, 1, 'anymd pages get <id>');
      const data = await readJson(await request(ctx, 'GET', `/api/v1/admin/pages/${enc(id)}`));
      return ctx.out(json ? toJson(data) : formatKeyValues(unwrapPage(data)));
    }
    case 'create': {
      expectArgs(rest, 0, 'anymd pages create --slug <slug> --title <title> [--template <t>]');
      const slug = nonEmpty(ctx.flags.slug);
      const title = nonEmpty(ctx.flags.title);
      if (!slug || !title) throw usageError('pages create requires --slug and --title');
      const body = { slug, title };
      if (nonEmpty(ctx.flags.template)) body.template = ctx.flags.template.trim();
      const data = await readJson(await request(ctx, 'POST', '/api/v1/admin/pages', { json: body }));
      if (json) return ctx.out(toJson(data));
      const page = unwrapPage(data);
      const revision = pick(page, 'revision');
      return ctx.out(`Created page ${pick(page, 'id') ?? ''} (/p/${pick(page, 'slug') ?? slug})` +
        `${revision !== undefined ? ` at revision ${revision}` : ''}\n`);
    }
    case 'ops': {
      const [id] = expectArgs(rest, 1, 'anymd pages ops <id> --file ops.json');
      if (!ctx.flags.file) throw usageError('pages ops requires --file ops.json');
      const payload = await readOpsFile(ctx.flags.file);
      if (payload.baseRevision === undefined) {
        const current = unwrapPage(await readJson(await request(ctx, 'GET', `/api/v1/admin/pages/${enc(id)}`)));
        payload.baseRevision = pick(current, 'revision');
        if (payload.baseRevision === undefined) {
          throw new CliError('missing_revision', 'could not determine the page revision; set "baseRevision" in the ops file');
        }
      }
      const data = await readJson(
        await request(ctx, 'POST', `/api/v1/admin/pages/${enc(id)}/ops`, { json: payload }),
      );
      if (json) return ctx.out(toJson(data));
      const revision = pick(data, 'revision') ?? pick(unwrapPage(data), 'revision');
      return ctx.out(`Applied ${payload.ops.length} op(s) to page ${id}` +
        `${revision !== undefined ? `; now at revision ${revision}` : ''}\n`);
    }
    case 'publish': {
      const [id] = expectArgs(rest, 1, 'anymd pages publish <id>');
      const data = await readJson(await request(ctx, 'POST', `/api/v1/admin/pages/${enc(id)}/publish`, { json: {} }));
      if (json) return ctx.out(toJson(data));
      const page = unwrapPage(data);
      const url = pick(data, 'url') ?? pick(page, 'url') ??
        (pick(page, 'slug') ? `${ctx.base}/p/${pick(page, 'slug')}` : undefined);
      return ctx.out(`Published page ${id}${url ? `: ${url}` : ''}\n`);
    }
    case 'blocks': {
      expectArgs(rest, 0, 'anymd pages blocks');
      const data = await readJson(await request(ctx, 'GET', '/api/v1/admin/blocks'));
      if (json) return ctx.out(toJson(data));
      const blocks = pickArray(data, 'blocks', 'items');
      if (!blocks.length) return ctx.out('No blocks.\n');
      const list = (v) => (Array.isArray(v) ? v.join('|') : v ?? '-');
      const rows = blocks.map((b) => [
        pick(b, 'type', 'name') ?? '-',
        list(pick(b, 'sizes')),
        list(pick(b, 'slots')),
        truncate(oneLine(pick(b, 'description', 'title') ?? ''), 70),
      ]);
      return ctx.out(formatTable(['TYPE', 'SIZES', 'SLOTS', 'DESCRIPTION'], rows, ctx.colors));
    }
    default:
      throw usageError(sub ? `unknown pages command "${sub}"; usage: ${PAGES_USAGE}` : `usage: ${PAGES_USAGE}`);
  }
}

export function mcpSnippets(base, keyLabel = '<key>') {
  const url = `${base}/mcp`;
  const auth = `Bearer ${keyLabel}`;
  return {
    url,
    claudeCode: `claude mcp add --transport http anymd ${url} --header "Authorization: ${auth}"`,
    httpClients: { mcpServers: { anymd: { url, headers: { Authorization: auth } } } },
    claudeDesktop: {
      mcpServers: {
        anymd: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: ${auth}`] },
      },
    },
  };
}

async function cmdMcp(ctx, args) {
  expectArgs(args, 0, 'anymd mcp');
  const s = mcpSnippets(ctx.base);
  const { bold, dim } = ctx.colors;
  const indent = (text) => text.replace(/^/gm, '  ');
  let out = `${bold('MCP endpoint:')} ${s.url} ${dim('(Streamable HTTP; API key or OAuth)')}\n\n`;
  out += `${bold('Claude Code')}\n  ${s.claudeCode}\n\n`;
  out += `${bold('Cursor')} ${dim('(~/.cursor/mcp.json) and other clients that accept a URL')}\n`;
  out += `${indent(JSON.stringify(s.httpClients, null, 2))}\n\n`;
  out += `${bold('Claude Desktop')} ${dim('(claude_desktop_config.json, via the mcp-remote bridge)')}\n`;
  out += `${indent(JSON.stringify(s.claudeDesktop, null, 2))}\n\n`;
  out += `Replace <key> with your API key${ctx.key ? ` (current: ${maskKey(ctx.key)})` : ''}. ` +
    'Clients that support OAuth can omit the Authorization header.\n';
  ctx.out(out);
}

const PREFS_PATH = '/api/v1/account/reading-preferences';

/** `key=value` pairs for `anymd prefs set`: booleans take true/false/on/off/1/0, limits take integers. */
export function parsePreferenceAssignments(args) {
  if (!args.length) throw usageError('usage: anymd prefs set <field>=<value>… (e.g. expandThread=true maxThreadPosts=30)');
  const booleans = ['expandThread', 'includeComments', 'keepImages', 'analyzeImages', 'downloadVideo', 'analyzeVideo'];
  const out = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : '';
    const raw = eq > 0 ? arg.slice(eq + 1).trim().toLowerCase() : '';
    if (booleans.includes(key)) {
      if (['true', 'on', '1', 'yes'].includes(raw)) out[key] = true;
      else if (['false', 'off', '0', 'no'].includes(raw)) out[key] = false;
      else throw usageError(`${key} must be true or false`);
    } else if (Object.hasOwn(READING_LIMITS, key)) {
      const [min, max] = READING_LIMITS[key];
      const value = Number(raw);
      if (!raw || !Number.isInteger(value) || value < min || value > max) throw usageError(`${key} must be an integer between ${min} and ${max}`);
      out[key] = value;
    } else {
      throw usageError(`unknown preference "${arg}"; fields: ${[...booleans, ...Object.keys(READING_LIMITS)].join(', ')}`);
    }
  }
  return out;
}

function formatPreferences(data, colors) {
  const p = data.preferences ?? {};
  const { bold, dim } = colors;
  const onOff = (v) => (v ? 'on' : 'off');
  return `${bold('Reading defaults')} ${dim(data.saved ? '(saved)' : '(safe defaults: deep reading off)')}
  keep image/media URLs   ${onOff(p.keepImages)}            ${dim('no extra credits')}
  expand X threads        ${onOff(p.expandThread)}  max ${p.maxThreadPosts} posts   ${dim('extra credits')}
  comments & replies      ${onOff(p.includeComments)}  max ${p.maxComments}   ${dim('extra credits')}
  read images (OCR)       ${onOff(p.analyzeImages)}  max ${p.maxImages}   ${dim('extra credits')}
  max credits/conversion  ${p.maxCredits}
  YouTube video to CDN    ${onOff(p.downloadVideo)}            ${dim('extra credits, charged when ready')}
  AI video analysis       ${onOff(p.analyzeVideo)}            ${dim('extra credits by video length, needs video download')}
${dim('Flags on a single conversion override these; omitted flags use them.')}
`;
}

/** Saved defaults apply to every credential of the account, so changing them needs `keys:manage`. */
async function prefsWrite(ctx, method, options) {
  try {
    return await request(ctx, method, PREFS_PATH, options);
  } catch (err) {
    if (err instanceof CliError && err.status === 403) {
      err.hint = 'Changing saved defaults needs a key with the keys:manage scope, e.g. the "Everything my role allows" preset (anymd.cc/dashboard/keys), or use the dashboard.';
    }
    throw err;
  }
}

async function cmdPrefs(ctx, args) {
  const [sub = 'show', ...rest] = args;
  let res;
  if (sub === 'show') {
    expectArgs(rest, 0, 'anymd prefs [show]');
    res = await request(ctx, 'GET', PREFS_PATH);
  } else if (sub === 'set') {
    res = await prefsWrite(ctx, 'PUT', { json: parsePreferenceAssignments(rest) });
  } else if (sub === 'reset') {
    expectArgs(rest, 0, 'anymd prefs reset');
    res = await prefsWrite(ctx, 'DELETE');
  } else {
    throw usageError('usage: anymd prefs [show] | set <field>=<value>… | reset');
  }
  const data = await readJson(res);
  if (ctx.flags.json) return ctx.out(toJson(data));
  ctx.out(formatPreferences(data, ctx.colors));
}

const COMMANDS = {
  convert: cmdConvert, file: cmdFile, search: cmdSearch, social: cmdSocial, ls: cmdList, get: cmdGet, rm: cmdRemove,
  tag: cmdTag, tags: cmdTags,
  usage: cmdUsage, login: cmdLogin, logout: cmdLogout, whoami: cmdWhoami, pages: cmdPages, mcp: cmdMcp,
  prefs: cmdPrefs, video: cmdVideo,
};

export function helpText(colors = makeColors(false)) {
  const { bold, dim } = colors;
  return `${bold('anymd')} ${VERSION} — convert any URL or file to clean Markdown (https://anymd.cc)

${bold('Usage')}
  anymd <url>                          Convert a URL to Markdown (same as convert)
  anymd convert <url> [--json] [-o file] [--no-save] [--fresh]
  anymd file <path> [--json] [-o file] Convert a local file (PDF, DOCX, XLSX, CSV, images…; max 20 MB)
  anymd search <query> [--mode hybrid] [--limit 10] [--json]
  anymd social <platform> <query> [--cursor c] [--json]
                                       Search public posts on ${SOCIAL_PLATFORMS.join(', ')}
                                       or all of them (requires a key; per page with results:
                                       10 credits, LinkedIn 100, all = sum of platforms)
  anymd ls [--limit 20] [--domain x] [--tag a,b]
                                       List documents in your library (--tag: all tags must match)
  anymd get <id> [-o file]             Print a library document as Markdown
  anymd rm <id>                        Delete a library document
  anymd tag <id> [--add a,b] [--remove c] | --set a,b
                                       Edit a document's tags (--set "" clears; max 20 per document)
  anymd tags [--limit 100]             List your tags with document counts
  anymd usage                          Show plan, quota and usage
  anymd login [--key amd_…]            Save an API key (validated against the server)
  anymd logout                         Remove the saved API key
  anymd whoami                         Show the account behind the current key
  anymd pages ls | get <id> | create --slug <s> --title <t> [--template <t>]
              | ops <id> --file ops.json | publish <id> | blocks
  anymd mcp                            Print MCP client configuration snippets
  anymd prefs [show] | set <field>=<value>… | reset
                                       Show or change your saved reading defaults
  anymd video <id> [--json]            Check a YouTube video download and its AI analysis (prefs set downloadVideo=on analyzeVideo=on)

${bold('Options')}
  --json            Print raw JSON
  -o, --output <f>  Write the result to a file instead of stdout
  --no-save         Do not save the conversion to your library
  --fresh           Bypass the cache
  Reading options (omitted ones follow your saved defaults; deep reading is off unless enabled):
  --expand-thread     Expand the same-author X thread (requires a key; extra credits)
  --max-thread-posts <n>  Thread post limit, 1–100 (default 20)
  --include-comments  Read comments and replies (requires a key; extra credits)
  --analyze-images    OCR and describe article images (requires a key; extra credits)
  --no-expand-thread, --no-include-comments, --no-analyze-images
                      Turn an enrichment off for this conversion only
  --keep-images, --no-images  Keep or strip image/media URLs (no extra credits)
  --max-comments <n>  Comment/reply limit, 1–1000 (default 100)
  --max-images <n>    Image limit, 1–20 (default 10)
  --max-credits <n>   Hard request credit limit, 1–1000 (default 100)
  --mode <m>        Search mode: ${SEARCH_MODES.join(', ')}
  --limit <n>       Number of results
  --cursor <c>      Next page of social search results (next_cursor of the previous page)
  --key <amd_…>     API key (overrides ANYMD_API_KEY and the config file)
  --base <url>      API base URL (default ${DEFAULT_BASE}; env ANYMD_BASE_URL)
  -h, --help        Show this help
  -v, --version     Show the version

${bold('Configuration')}
  Precedence: flags > ANYMD_API_KEY / ANYMD_BASE_URL > config file written by \`anymd login\`
  (${dim('$XDG_CONFIG_HOME/anymd/config.json, ~/.config/anymd/config.json, or %APPDATA%\\anymd\\config.json')}).
  Without a key, conversions use the free public URL API (50 per day per IP).
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function defaultPrompt(question, input, output) {
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  try {
    return await new Promise((resolve, reject) => {
      rl.once('close', () => resolve('')); // stdin ended without a line
      rl.question(question).then(resolve, reject);
    });
  } finally {
    rl.close();
  }
}

/**
 * Run the CLI. Every side effect goes through `io` so tests can inject fetch, env and streams.
 * @returns {Promise<number>} process exit code
 */
export async function run(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const runtime = {
    env,
    stdout,
    stderr,
    fetch: io.fetch ?? globalThis.fetch,
    platform: io.platform ?? process.platform,
    homedir: io.homedir ?? osHomedir(),
    prompt: io.prompt ?? ((question) => defaultPrompt(question, stdin, stderr)),
  };
  const colorAllowed = env.NO_COLOR === undefined;
  const colors = makeColors(colorAllowed && Boolean(stdout.isTTY));
  const errColors = makeColors(colorAllowed && Boolean(stderr.isTTY));
  const secrets = [];
  const redact = (text) => secrets.reduce((acc, s) => acc.split(s).join(maskKey(s)), String(text));
  const warn = (message) => stderr.write(`${errColors.yellow('warning:')} ${redact(message)}\n`);

  try {
    if (typeof runtime.fetch !== 'function') {
      throw new CliError('unsupported_runtime', `anymd needs Node.js >= 18 (found ${process.version})`);
    }
    const { flags, positionals } = parseArgs(argv);
    if (flags.version) {
      stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (flags.help || positionals.length === 0) {
      stdout.write(helpText(colors));
      return 0;
    }
    let [command, ...args] = positionals;
    if (!Object.hasOwn(COMMANDS, command)) {
      if (!looksLikeUrl(command)) throw usageError(`unknown command "${command}"`);
      args = [command, ...args];
      command = 'convert';
    }
    const configFile = configPath(runtime);
    const settings = resolveSettings(flags, env, await loadConfig(configFile, warn));
    if (settings.key) secrets.push(settings.key);
    const ctx = {
      ...settings,
      flags,
      io: runtime,
      colors,
      configFile,
      secrets,
      warn,
      out: (text) => stdout.write(text),
      err: (text) => stderr.write(redact(text)),
    };
    await COMMANDS[command](ctx, args);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      stderr.write(`${errColors.red(`${err.code}:`)} ${redact(err.message)}\n`);
      if (err.hint) stderr.write(`${errColors.dim(`hint: ${err.hint}`)}\n`);
    } else {
      stderr.write(`${errColors.red('internal_error:')} ${redact(err?.stack ?? err)}\n`);
    }
    return 1;
  }
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0); // e.g. `anymd <url> | head`
    throw err;
  });
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
