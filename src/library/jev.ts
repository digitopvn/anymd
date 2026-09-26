/**
 * Jev decider (TypeSafe System One, served through OpenRouter's decisions endpoint, or TypeSafe
 * directly when only TYPESAFE_API_KEY is set). Only consulted when the fused ranking is ambiguous: it picks
 * which close candidate best answers the query. It is advisory — any failure, low confidence or
 * model drift falls back to the rank order. It never decides access; the candidates were already
 * scoped to the caller's library.
 */
import type { Env } from '../env';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const OPENROUTER_MODEL = '~typesafe/jev-latest';
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const TYPESAFE_MODEL = 'jev-1.13.0';
/** Accept answers only from the Jev 1.x line; a new major version must be re-validated first. */
const MODEL_LINE = /^(typesafe\/)?jev-1\./;
const TIMEOUT_MS = 3000;
const MAX_CANDIDATES = 12;
const CHOICE_FLOOR = 0.85;
const MARGIN = 0.2;
/** Consult Jev only when the gap between #1 and #2 is less than this share of #1's score. */
export const RANK_GAP_RATIO = 0.25;

export interface JevCandidate {
  id: string;
  title: string;
  snippet: string;
  domain: string;
}

export interface JevDecision {
  used: boolean;
  choice: string | null;
  confidence: number | null;
  reason: string;
}

function sanitizeQuery(q: string): string {
  return q
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '[email]')
    .replace(/\b(?:amd|sk|pk|ghp|gho)_[A-Za-z0-9_-]{8,}\b/g, '[key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

export function isAmbiguous(scores: number[]): boolean {
  if (scores.length < 2 || scores[0] <= 0) return false;
  return (scores[0] - scores[1]) / scores[0] < RANK_GAP_RATIO;
}

export async function jevDecide(env: Env, query: string, candidates: JevCandidate[]): Promise<JevDecision> {
  const viaOpenRouter = Boolean(env.OPENROUTER_API_KEY);
  const apiKey = env.OPENROUTER_API_KEY || env.TYPESAFE_API_KEY;
  if (!apiKey) return { used: false, choice: null, confidence: null, reason: 'disabled' };
  const pool = candidates.slice(0, MAX_CANDIDATES);
  const criteria: Record<string, string | null> = {};
  pool.forEach((c, i) => {
    criteria[`c${i}`] = `${c.title} (${c.domain}): ${c.snippet.replace(/<\/?mark>/g, '').slice(0, 280)}`;
  });
  criteria.none = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(viaOpenRouter ? OPENROUTER_ENDPOINT : TYPESAFE_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(viaOpenRouter ? { 'HTTP-Referer': env.PUBLIC_URL, 'X-Title': 'anymd.cc' } : {}),
      },
      body: JSON.stringify({
        state: { query: sanitizeQuery(query) },
        model: viaOpenRouter ? OPENROUTER_MODEL : TYPESAFE_MODEL,
        questions: {
          choice: {
            type: 'choice',
            instructions: 'Pick the saved document that most directly answers the search query. Choose none if no candidate answers it.',
            criteria,
          },
        },
      }),
    });
    if (!res.ok) return { used: false, choice: null, confidence: null, reason: `http_${res.status}` };
    const body = (await res.json()) as {
      model?: string;
      answers?: { choice?: { choice?: string; probabilities?: Record<string, number>; confidence?: number } };
    };
    if (body.model && !MODEL_LINE.test(body.model)) return { used: false, choice: null, confidence: null, reason: 'model_drift' };
    const answer = body.answers?.choice;
    if (!answer?.choice || answer.choice === 'none') return { used: true, choice: null, confidence: null, reason: 'none' };
    const probs = Object.values(answer.probabilities ?? {}).sort((a, b) => b - a);
    const top = answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0;
    const runnerUp = probs[1] ?? 0;
    if (top < CHOICE_FLOOR || top - runnerUp < MARGIN) return { used: true, choice: null, confidence: top, reason: 'low_confidence' };
    const idx = Number(answer.choice.slice(1));
    const picked = pool[idx];
    if (!picked) return { used: true, choice: null, confidence: top, reason: 'unknown_choice' };
    return { used: true, choice: picked.id, confidence: top, reason: 'decided' };
  } catch (err) {
    return { used: false, choice: null, confidence: null, reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}
