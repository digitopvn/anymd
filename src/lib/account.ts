/** Account-level data rights: full export and permanent deletion. */
import type { Env } from '../env';
import type { DocumentRow } from '../library/store';

export async function exportDocuments(env: Env, userId: string): Promise<DocumentRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<DocumentRow>();
  return results;
}

/** One Markdown file: every document with its own frontmatter, separated by a rule. */
export function documentsToMarkdown(docs: DocumentRow[]): string {
  const q = (s: string) => JSON.stringify(s ?? '');
  return docs
    .map((d) =>
      [
        '---',
        `title: ${q(d.title)}`,
        `source: ${q(d.url)}`,
        `kind: ${d.source_kind}`,
        d.tags ? `tags: [${d.tags.split(' ').filter(Boolean).map(q).join(', ')}]` : null,
        `saved: ${new Date(d.created_at).toISOString()}`,
        '---',
        '',
        d.markdown.trim(),
        '',
      ]
        .filter((l) => l !== null)
        .join('\n'),
    )
    .join('\n\n* * *\n\n');
}

/**
 * Delete everything tied to a user: vectors, documents, keys, sessions, logs, billing mirrors and
 * OAuth grants. Audit log rows stay (they record admin actions, not the user's content).
 */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  const { results } = await env.DB.prepare('SELECT id, embedded_chunks FROM documents WHERE user_id = ?').bind(userId).all<{ id: string; embedded_chunks: number }>();
  const vectorIds = results.flatMap((d) => Array.from({ length: d.embedded_chunks }, (_, i) => `${d.id}#${i}`));
  for (let i = 0; i < vectorIds.length; i += 1000) await env.VECTORS.deleteByIds(vectorIds.slice(i, i + 1000)).catch(() => undefined);

  try {
    const { items } = await env.OAUTH_PROVIDER.listUserGrants(userId);
    await Promise.all(items.map((g) => env.OAUTH_PROVIDER.revokeGrant(g.id, userId).catch(() => undefined)));
  } catch {
    // No OAuth grants store in this environment: nothing to revoke.
  }

  const tables = ['documents', 'api_keys', 'sessions', 'usage_events', 'traces', 'subscriptions', 'credit_grants'];
  await env.DB.batch([...tables.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId)), env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)]);
}
