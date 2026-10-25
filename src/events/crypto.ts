/**
 * Cryptography for MCP Events webhooks: Standard Webhooks secrets and signatures, deterministic
 * subscription and event ids, and at-rest encryption of callback secrets.
 */
import type { Env } from '../env';
import { hex, sha256 } from '../lib/util';

const enc = new TextEncoder();

function fromBase64(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  let s = '';
  for (const b of buf instanceof Uint8Array ? buf : new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * A Standard Webhooks symmetric secret: `whsec_` + base64 of 24 to 64 bytes. Returns the key bytes,
 * or null when the value does not qualify.
 */
export function parseWebhookSecret(secret: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) return null;
  const body = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const bytes = fromBase64(body);
  return bytes && bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}

/** `v1,<base64 HMAC-SHA256(key, id + "." + timestamp + "." + body)>` for each secret, space separated. */
export async function signWebhook(secrets: string[], id: string, timestamp: number, body: string): Promise<string> {
  const signed = enc.encode(`${id}.${timestamp}.${body}`);
  const out: string[] = [];
  for (const secret of secrets) {
    const raw = parseWebhookSecret(secret);
    if (!raw) continue;
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    out.push(`v1,${toBase64(await crypto.subtle.sign('HMAC', key, signed))}`);
  }
  return out.join(' ');
}

/** JSON with object keys sorted at every level, so equal arguments always serialize identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Deterministic subscription id over the subscription key. A routing handle, never an authorization. */
export async function subscriptionId(principal: string, url: string, name: string, args: unknown): Promise<string> {
  return `sub_${(await sha256(canonicalJson([principal, url, name, args]))).slice(0, 24)}`;
}

/** Deterministic event id, so a re-run of the same transition cannot create a second event. */
export async function stableEventId(...parts: string[]): Promise<string> {
  return `evt_${(await sha256(parts.join('\u0000'))).slice(0, 32)}`;
}

/** Hash of a credential identity, for loop avoidance without storing the identity in the outbox. */
export async function actorHash(principal: string): Promise<string> {
  return (await sha256(`actor:${principal}`)).slice(0, 32);
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function randomNonce(bytes = 24): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

let cachedKey: { source: string; key: CryptoKey } | null = null;

async function secretKey(env: Pick<Env, 'EVENTS_SECRET_KEY'>): Promise<CryptoKey> {
  const source = env.EVENTS_SECRET_KEY;
  if (!source) throw new Error('EVENTS_SECRET_KEY is not set');
  if (cachedKey?.source === source) return cachedKey.key;
  const material = await crypto.subtle.importKey('raw', enc.encode(source), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('anymd-mcp-events'), info: enc.encode('callback-secret-v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  cachedKey = { source, key };
  return key;
}

/** AES-256-GCM, `v1.<iv>.<ciphertext>` in base64. */
export async function encryptSecret(env: Pick<Env, 'EVENTS_SECRET_KEY'>, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(env), enc.encode(plain));
  return `v1.${toBase64(iv)}.${toBase64(ct)}`;
}

export async function decryptSecret(env: Pick<Env, 'EVENTS_SECRET_KEY'>, stored: string): Promise<string | null> {
  const [v, iv, ct] = stored.split('.');
  const ivBytes = iv ? fromBase64(iv) : null;
  const ctBytes = ct ? fromBase64(ct) : null;
  if (v !== 'v1' || !ivBytes || !ctBytes) return null;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, await secretKey(env), ctBytes));
  } catch {
    return null;
  }
}
