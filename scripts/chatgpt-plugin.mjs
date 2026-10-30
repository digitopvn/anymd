// The ChatGPT plugin package in plugins/chatgpt: validate it against the OpenAI plugin directory rules,
// build the upload zip, check its public URLs and seed the reviewer library with the synthetic samples.
//   node scripts/chatgpt-plugin.mjs validate          (default; offline)
//   node scripts/chatgpt-plugin.mjs check-urls        (fetches every listing URL and the MCP endpoint)
//   node scripts/chatgpt-plugin.mjs pack [out.zip]    (validates first; leaves review/ out of the upload)
//   ANYMD_REVIEWER_KEY=amd_… node scripts/chatgpt-plugin.mjs seed [--ref <commit>] [--base https://anymd.cc]
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = join(ROOT, 'plugins/chatgpt');
// Raw files are read as text, so the stored document is exactly the sample, titled by its file name.
const SAMPLES_RAW = 'https://raw.githubusercontent.com/digitopvn/anymd';
// The only top-level entries the upload holds. review/ feeds the reviewer library and is never uploaded.
const PACKAGE_ENTRIES = ['plugin.json', 'mcp.json', 'assets', 'skills'];
const ALLOWED_ENTRIES = new Set([...PACKAGE_ENTRIES, 'review']);
// Credential shapes that must never appear in shipped text: anymd keys, OpenAI-style keys, bearer tokens.
const SECRET_PATTERNS = [/\bamd_[A-Za-z0-9]{8,}/, /\bsk-[A-Za-z0-9_-]{16,}/, /\bBearer\s+(?!amd_…)[A-Za-z0-9._~+/=-]{16,}/];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_KEYS = new Set(['test_credentials', 'reviewer_instructions', 'clientSecret', 'client_secret', 'password']);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Width and height of a PNG, or null when the file is not a PNG. */
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

function findForbidden(value, path, out) {
  if (typeof value === 'string' && SECRET_PATTERNS.some((re) => re.test(value))) out.push(`${path} looks like it holds a credential`);
  if (Array.isArray(value)) value.forEach((v, i) => findForbidden(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) out.push(`${path}.${k} must not ship in the package`);
      if (k === 'headers' && v && Object.keys(v).length) out.push(`${path}.headers must be empty; credentials come from OAuth`);
      findForbidden(v, `${path}.${k}`, out);
    }
  }
}

/** Files under `rel` (relative to `dir`), depth first. Symlinks are listed, never followed. */
function walk(dir, rel = '') {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const p = rel ? `${rel}/${name}` : name;
    return lstatSync(join(dir, p)).isDirectory() ? walk(dir, p) : [p];
  });
}

/** MCP tool names the shipped skills tell the assistant to call. */
export function skillToolNames(dir = PLUGIN_DIR) {
  const names = new Set();
  for (const f of walk(dir, 'skills').filter((p) => p.endsWith('.md'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/`((?:read|search|get|list|tag|delete|convert)_[a-z_]+)`/g)) names.add(m[1]);
  }
  return [...names];
}

/** Every listing URL the directory shows, for the live check. */
export function listingUrls(dir = PLUGIN_DIR) {
  const ui = readJson(join(dir, 'plugin.json')).extensions?.['com.openai']?.interface ?? {};
  return ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'].map((k) => ui[k]).filter(Boolean);
}

/** The package's plugin.json. */
export const readPlugin = (dir = PLUGIN_DIR) => readJson(join(dir, 'plugin.json'));

/**
 * Problems that would fail directory validation or review. Empty when the package is ready to upload.
 * `plugin` replaces plugin.json, so a candidate edit can be checked before it is written.
 */
export function validatePlugin(dir = PLUGIN_DIR, plugin = undefined) {
  const errors = [];
  const need = (ok, message) => void (ok || errors.push(message));
  const text = (v, field, max) => need(typeof v === 'string' && v.trim() && v.length <= max, `${field} must be 1–${max} characters`);
  const https = (v, field) => need(typeof v === 'string' && /^https:\/\/[^\s/]+/.test(v), `${field} must be an https URL`);
  const file = (p, field) => {
    const ok = typeof p === 'string' && p.startsWith('./') && existsSync(join(dir, p)) && !relative(dir, join(dir, p)).startsWith('..');
    need(ok, `${field} must point to a file inside the package (./…)`);
    return ok ? join(dir, p) : null;
  };
  const image = (p, field) => {
    const f = file(p, field);
    if (!f) return;
    const size = pngSize(f);
    need(size, `${field} must be a PNG`);
    if (size) need(size.width === size.height && size.width >= 48 && size.bytes <= MAX_IMAGE_BYTES, `${field} must be square, at least 48px and at most 5 MiB (got ${size.width}×${size.height}, ${size.bytes} bytes)`);
  };

  let mcp;
  try { plugin ??= readPlugin(dir); } catch (e) { return [`plugin.json: ${e.message}`]; }
  try { mcp = readJson(join(dir, 'mcp.json')); } catch (e) { return [`mcp.json: ${e.message}`]; }

  need(plugin.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'plugin.json $schema must be the agent-plugins 1.0.0 plugin schema');
  need(/^[a-z0-9][a-z0-9-]*$/.test(plugin.name ?? ''), 'name must be lowercase letters, digits and hyphens');
  need(SEMVER.test(plugin.version ?? ''), 'version must be semver');
  text(plugin.description, 'description', 1024);
  need(plugin.author?.name, 'author.name is required');

  const oai = plugin.extensions?.['com.openai'] ?? {};
  const ui = oai.interface ?? {};
  text(ui.displayName, 'interface.displayName', 30);
  text(ui.shortDescription, 'interface.shortDescription', 30);
  text(ui.longDescription, 'interface.longDescription', 4000);
  text(ui.developerName, 'interface.developerName', 100);
  for (const k of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) https(ui[k], `interface.${k}`);
  need(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length >= 1 && ui.defaultPrompt.length <= 3, 'interface.defaultPrompt must hold 1–3 prompts');
  (ui.defaultPrompt ?? []).forEach((p, i) => text(p, `interface.defaultPrompt[${i}]`, 128));
  for (const k of ['brandColor', 'brandColorDark']) if (ui[k] !== undefined) need(/^#[0-9A-Fa-f]{6}$/.test(ui[k]), `interface.${k} must be #RRGGBB`);
  need(ui.logo, 'interface.logo is required');
  if (ui.logo) image(ui.logo, 'interface.logo');
  if (ui.composerIcon) image(ui.composerIcon, 'interface.composerIcon');
  if (oai.onboardingSkill) {
    const f = file(oai.onboardingSkill, 'onboardingSkill');
    if (f) need(/^---\n[\s\S]*?\bname:\s*\S[\s\S]*?\bdescription:\s*\S[\s\S]*?\n---/.test(readFileSync(f, 'utf8')), 'onboardingSkill must start with frontmatter carrying name and description');
  }
  // Every skill shipped in the package needs the same frontmatter.
  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir)) for (const s of readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory())) {
    const f = join(skillsDir, s, 'SKILL.md');
    need(existsSync(f) && /^---\n[\s\S]*?\bname:\s*\S[\s\S]*?\bdescription:\s*\S[\s\S]*?\n---/.test(readFileSync(f, 'utf8')), `skills/${s}/SKILL.md must exist with name and description frontmatter`);
  }

  const cases = oai.review?.test_cases ?? {};
  need(Array.isArray(cases.positive) && cases.positive.length === 5, 'review.test_cases.positive must hold exactly 5 cases');
  need(Array.isArray(cases.negative) && cases.negative.length === 3, 'review.test_cases.negative must hold exactly 3 cases');
  (cases.positive ?? []).forEach((c, i) => ['description', 'prompt', 'tools_triggered', 'expected_behavior'].forEach((k) => need(typeof c?.[k] === 'string' && c[k].trim(), `review.test_cases.positive[${i}].${k} is required`)));
  (cases.negative ?? []).forEach((c, i) => ['description', 'prompt'].forEach((k) => need(typeof c?.[k] === 'string' && c[k].trim(), `review.test_cases.negative[${i}].${k} is required`)));
  need(typeof oai.review?.commerce === 'boolean', 'review.commerce must be true or false');
  if (oai.review?.demo_recording_url !== undefined) https(oai.review.demo_recording_url, 'review.demo_recording_url');
  text(oai.publication?.release_notes, 'publication.release_notes', 4000);

  need(mcp.$schema === 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', 'mcp.json $schema must be the agent-plugins 1.0.0 mcp schema');
  const servers = Object.entries(mcp.mcpServers ?? {});
  need(servers.length >= 1, 'mcp.json must declare a server');
  for (const [name, s] of servers) {
    need(s.type === 'streamable-http', `mcpServers.${name}.type must be streamable-http`);
    https(s.url, `mcpServers.${name}.url`);
    const auth = s.extensions?.['com.openai']?.auth;
    need(auth?.type === 'oauth' && ['dcr', 'cimd'].includes(auth?.client?.mode), `mcpServers.${name} must use OAuth with dcr or cimd client registration`);
  }

  findForbidden(plugin, 'plugin.json', errors);
  findForbidden(mcp, 'mcp.json', errors);
  // The upload is an allowlist; anything unexpected (dotfiles, backups, links out of the package) fails here.
  for (const name of readdirSync(dir)) need(ALLOWED_ENTRIES.has(name), `${name} is not part of the package; remove it`);
  for (const f of PACKAGE_ENTRIES.filter((e) => existsSync(join(dir, e))).flatMap((e) => (lstatSync(join(dir, e)).isDirectory() ? walk(dir, e) : [e]))) {
    if (lstatSync(join(dir, f)).isSymbolicLink()) errors.push(`${f} is a symlink; ship real files only`);
    else if (/\.(md|json|txt)$/.test(f) && SECRET_PATTERNS.some((re) => re.test(readFileSync(join(dir, f), 'utf8')))) errors.push(`${f} looks like it holds a credential`);
  }
  return errors;
}

/** Fetches each listing URL and confirms the MCP endpoint answers with an OAuth challenge. */
export async function checkUrls(dir = PLUGIN_DIR) {
  const results = [];
  for (const url of listingUrls(dir)) {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) }).catch((e) => ({ status: 0, error: e.message }));
    results.push({ url, status: res.status, ok: res.status === 200 });
  }
  for (const s of Object.values(readJson(join(dir, 'mcp.json')).mcpServers)) {
    const res = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', signal: AbortSignal.timeout(20000) }).catch(() => ({ status: 0, headers: new Headers() }));
    const challenge = res.headers.get('www-authenticate') ?? '';
    results.push({ url: s.url, status: res.status, ok: res.status === 401 && challenge.includes('resource_metadata=') });
  }
  return results;
}

function pack(out) {
  const errors = validatePlugin();
  if (errors.length) throw new Error(`Package is not valid:\n- ${errors.join('\n- ')}`);
  const version = readJson(join(PLUGIN_DIR, 'plugin.json')).version;
  const target = resolve(out ?? join(ROOT, `dist/anymd-chatgpt-plugin-${version}.zip`));
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  try {
    execFileSync('zip', ['-r', '-X', '-q', '-y', target, ...PACKAGE_ENTRIES], { cwd: PLUGIN_DIR });
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'The zip command is not installed; install it or zip plugin.json, mcp.json, assets/ and skills/ by hand.' : e.message);
  }
  return target;
}

async function seed(base, ref) {
  const key = process.env.ANYMD_REVIEWER_KEY;
  if (!key?.startsWith('amd_')) throw new Error('Set ANYMD_REVIEWER_KEY to an API key (amd_…) of the reviewer account.');
  if (!/^[\w./-]+$/.test(ref ?? '')) throw new Error('Pass --ref <commit or tag> that is pushed to GitHub, so the samples match this checkout.');
  const origin = new URL(base).origin;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const json = async (res, name) => {
    try { return await res.json(); } catch { throw new Error(`${name}: ${res.status} with a non-JSON body`); }
  };
  for (const name of readdirSync(join(PLUGIN_DIR, 'review/samples')).filter((f) => f.endsWith('.md')).sort()) {
    const url = `${SAMPLES_RAW}/${ref}/plugins/chatgpt/review/samples/${name}`;
    const res = await fetch(`${origin}/api/v1/convert`, { method: 'POST', headers, body: JSON.stringify({ url, save: true, fresh: true }), signal: AbortSignal.timeout(70000) });
    const data = await json(res, name);
    if (!res.ok || !data.document_id) throw new Error(`${name}: convert failed (${res.status} ${data.error?.code ?? data.not_saved_reason ?? ''})`);
    const tag = await fetch(`${origin}/api/v1/library/${data.document_id}/tags`, { method: 'POST', headers, body: JSON.stringify({ add: ['review-sample'] }), signal: AbortSignal.timeout(20000) });
    if (!tag.ok) throw new Error(`${name}: tagging failed (${tag.status})`);
    console.log(`${name} → ${data.document_id} "${data.title}"`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode = 'validate', ...rest] = process.argv.slice(2);
  try {
    if (mode === 'validate') {
      const errors = validatePlugin();
      if (errors.length) throw new Error(`Package is not valid:\n- ${errors.join('\n- ')}`);
      console.log(`plugins/chatgpt is valid (${statSync(join(PLUGIN_DIR, 'plugin.json')).size} bytes plugin.json)`);
    } else if (mode === 'check-urls') {
      const results = await checkUrls();
      for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.status} ${r.url}`);
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    } else if (mode === 'pack') {
      console.log(pack(rest[0]));
    } else if (mode === 'seed') {
      const flag = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
      await seed(flag('--base', 'https://anymd.cc'), flag('--ref', undefined));
    } else {
      throw new Error(`Unknown mode "${mode}". Use validate, check-urls, pack or seed.`);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
