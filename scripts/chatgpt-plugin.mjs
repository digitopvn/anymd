// The ChatGPT plugin package in plugins/chatgpt: validate it against the OpenAI plugin directory rules,
// build the upload zip, check its public URLs and seed the reviewer library with the synthetic samples.
//   node scripts/chatgpt-plugin.mjs validate          (default; offline)
//   node scripts/chatgpt-plugin.mjs check-urls        (fetches every listing URL and the MCP endpoint)
//   node scripts/chatgpt-plugin.mjs pack [out.zip]    (validates first; leaves review/ out of the upload)
//   ANYMD_REVIEWER_KEY=amd_… node scripts/chatgpt-plugin.mjs seed [--base https://anymd.cc]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = join(ROOT, 'plugins/chatgpt');
const SAMPLES_BASE = 'https://github.com/digitopvn/anymd/blob/dev/plugins/chatgpt/review/samples';
// Files the reviewer never uploads: samples feed the reviewer library, they are not part of the package.
const PACK_EXCLUDE = ['review'];
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
  if (Array.isArray(value)) value.forEach((v, i) => findForbidden(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) out.push(`${path}.${k} must not ship in the package`);
      if (k === 'headers' && v && Object.keys(v).length) out.push(`${path}.headers must be empty; credentials come from OAuth`);
      findForbidden(v, `${path}.${k}`, out);
    }
  }
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
  if (existsSync(skillsDir)) for (const s of readdirSync(skillsDir)) {
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
    const res = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', signal: AbortSignal.timeout(20000) });
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
  execFileSync('mkdir', ['-p', dirname(target)]);
  rmSync(target, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', target, '.', ...PACK_EXCLUDE.flatMap((d) => ['-x', `${d}/*`])], { cwd: PLUGIN_DIR });
  return target;
}

async function seed(base) {
  const key = process.env.ANYMD_REVIEWER_KEY;
  if (!key?.startsWith('amd_')) throw new Error('Set ANYMD_REVIEWER_KEY to an API key (amd_…) of the reviewer account.');
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  for (const name of readdirSync(join(PLUGIN_DIR, 'review/samples')).filter((f) => f.endsWith('.md')).sort()) {
    const res = await fetch(`${base}/api/v1/convert`, { method: 'POST', headers, body: JSON.stringify({ url: `${SAMPLES_BASE}/${name}`, save: true }), signal: AbortSignal.timeout(70000) });
    const data = await res.json();
    if (!res.ok || !data.document_id) throw new Error(`${name}: convert failed (${res.status} ${data.error?.code ?? data.not_saved_reason ?? ''})`);
    const tag = await fetch(`${base}/api/v1/library/${data.document_id}/tags`, { method: 'POST', headers, body: JSON.stringify({ add: ['review-sample'] }) });
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
      const i = rest.indexOf('--base');
      await seed(i >= 0 ? rest[i + 1] : 'https://anymd.cc');
    } else {
      throw new Error(`Unknown mode "${mode}". Use validate, check-urls, pack or seed.`);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
