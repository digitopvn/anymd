/**
 * Best-effort secret and personal-data scrubbing for feedback that will become a public GitHub
 * issue. High-confidence credentials block the submission (the user edits and retries); lower-risk
 * personal data is redacted in place. Not an assurance: the user still reviews the whole body.
 */

export type BlockKind = 'api_key' | 'payment_key' | 'package_token' | 'webhook_url' | 'github_token' | 'ai_key' | 'cloud_key' | 'private_key' | 'jwt' | 'auth_header' | 'bearer_token' | 'secret_assignment';
export type RedactKind = 'email' | 'private_url' | 'url_credentials' | 'url_token' | 'private_ip';

const BLOCK_PATTERNS: [BlockKind, RegExp][] = [
  ['api_key', /\bamd_[A-Za-z0-9_]{16,}/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['ai_key', /\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['payment_key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['package_token', /\bnpm_[A-Za-z0-9]{30,}|\bglpat-[A-Za-z0-9_-]{20}/],
  ['webhook_url', /hooks\.slack\.com\/services\/\S{10,}|(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/\S{10,}/i],
  ['cloud_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
  ['auth_header', /\b(?:proxy-)?authorization\s*:\s*(?:(?:basic|bearer|token|digest)\s+)?\S{8,}|\bx-api-key\s*:\s*\S{8,}|\b(?:set-)?cookie\s*:\s*\S{8,}/i],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ['secret_assignment', /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|token|password|passwd)\b["']?\s*[=:]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i],
];

const SENSITIVE_QUERY = /^(?:key|auth|code|sid|pwd|jwt)$|token|signature|credential|secret|passw|session|authorization|api[-_]?key|^sig$|x-amz-|x-goog-/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_IN_TEXT = /https?:\/\/[^\s<>()"'`\]]+/gi;
const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/g;

/** Controlled characters out (keeps tab and newline), CRLF normalised, bidi overrides dropped. */
export function cleanText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '')
    .trim();
}

export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (h.includes(':')) return true; // IPv6 literals are never a public reference
  if (/^\d+$/.test(h) || /^0x/i.test(h)) return true; // decimal / hex IPv4 forms
  return !h.includes('.');
}

/**
 * A public reference URL: http(s), no credentials, a public host. Query and hash are dropped
 * because they are where tokens and signed parameters live. Returns null when unusable.
 */
export function safePublicUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || isPrivateHostname(url.hostname)) return null;
  return `${url.origin}${url.pathname}`;
}

export interface ScrubResult {
  text: string;
  blocked: BlockKind[];
  redacted: RedactKind[];
}

/** Scrub one text field. `blocked` is non-empty when a high-confidence credential is present. */
export function scrubText(input: string): ScrubResult {
  let text = cleanText(input);
  const blocked: BlockKind[] = [];
  for (const [kind, re] of BLOCK_PATTERNS) if (re.test(text)) blocked.push(kind);
  const redacted = new Set<RedactKind>();

  text = text.replace(URL_IN_TEXT, (match) => {
    let url: URL;
    try {
      url = new URL(match.replace(/[.,;:!?]+$/, ''));
    } catch {
      return match;
    }
    const trailing = match.slice(match.replace(/[.,;:!?]+$/, '').length);
    if (url.username || url.password) {
      redacted.add('url_credentials');
      return `[URL with credentials redacted]${trailing}`;
    }
    if (isPrivateHostname(url.hostname)) {
      redacted.add('private_url');
      return `[private URL redacted]${trailing}`;
    }
    const sensitive = [...url.searchParams.keys()].some((k) => SENSITIVE_QUERY.test(k));
    if (sensitive || /(?:access_token|token|key|sig)=/i.test(url.hash)) {
      redacted.add('url_token');
      return `${url.origin}${url.pathname}${trailing}`;
    }
    return match;
  });
  text = text.replace(PRIVATE_IP, () => {
    redacted.add('private_ip');
    return '[private IP redacted]';
  });
  text = text.replace(EMAIL, () => {
    redacted.add('email');
    return '[email redacted]';
  });
  return { text, blocked, redacted: [...redacted] };
}

/** Stop user text from pinging people (`@name`) or cross-linking other threads' ids. */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, '$1@​')
    .replace(/\bfb_[0-9a-f]{20}\b/g, 'fb_[removed]')
    // owner/repo#N and links to GitHub threads would add backlinks in other repositories.
    .replace(/\b([\w.-]+\/[\w.-]+)#(\d+)/g, '$1 #$2')
    .replace(/https?:\/\/(?:www\.)?github\.com\//gi, 'github[.]com/');
}

/** Quote user text so it cannot imitate the server-written structure, and defuse HTML (comments, tags). */
export function quoteUserText(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}
