/**
 * Changelog from GitHub: releases when the repo has them (prerelease = beta), otherwise recent
 * commits on `main` (stable) and `dev` (beta). Cached in KV for 10 minutes.
 */
import type { Env } from '../env';
import type { ChangeEntry } from '../views/pages';
import { renderMarkdown } from './markdown';

export interface Changelog {
  entries: ChangeEntry[];
  source: 'releases' | 'commits' | 'none';
}

const CACHE_KEY = 'changelog:v1';

async function gh<T>(env: Env, path: string): Promise<T | null> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'anymd.cc' };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, { headers });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

interface Release {
  name: string | null;
  tag_name: string;
  html_url: string;
  body: string | null;
  prerelease: boolean;
  draft: boolean;
  published_at: string | null;
  created_at: string;
}

interface Commit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { date: string } | null };
}

function fromCommits(list: Commit[] | null, channel: ChangeEntry['channel']): ChangeEntry[] {
  return (list ?? [])
    .filter((c) => !/^Merge (pull request|branch)/.test(c.commit.message))
    .map((c) => {
      const [first, ...rest] = c.commit.message.split('\n');
      const body = rest.join('\n').replace(/^Co-Authored-By:.*$/gim, '').trim();
      return {
        channel,
        title: first.trim(),
        version: c.sha.slice(0, 7),
        url: c.html_url,
        date: Date.parse(c.commit.author?.date ?? '') || 0,
        html: body ? renderMarkdown(body).html : '',
      };
    });
}

export async function loadChangelog(env: Env): Promise<Changelog> {
  const cached = await env.CACHE.get<Changelog>(CACHE_KEY, 'json').catch(() => null);
  if (cached) return cached;
  let out: Changelog = { entries: [], source: 'none' };
  try {
    const releases = (await gh<Release[]>(env, '/releases?per_page=30'))?.filter((r) => !r.draft) ?? [];
    if (releases.length) {
      out = {
        source: 'releases',
        entries: releases.map((r) => ({
          channel: r.prerelease ? 'beta' : 'stable',
          title: r.name || r.tag_name,
          version: r.tag_name,
          url: r.html_url,
          date: Date.parse(r.published_at ?? r.created_at) || 0,
          html: renderMarkdown(r.body ?? '').html,
        })),
      };
    } else {
      const [main, dev] = await Promise.all([gh<Commit[]>(env, '/commits?sha=main&per_page=25'), gh<Commit[]>(env, '/commits?sha=dev&per_page=25')]);
      const seen = new Set((main ?? []).map((c) => c.sha));
      const entries = [...fromCommits(main, 'stable'), ...fromCommits((dev ?? []).filter((c) => !seen.has(c.sha)), 'beta')].sort((a, b) => b.date - a.date);
      if (entries.length) out = { source: 'commits', entries };
    }
  } catch {
    // GitHub unreachable: render the empty state rather than failing the page.
  }
  await env.CACHE.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: out.source === 'none' ? 120 : 600 }).catch(() => undefined);
  return out;
}

/** Markdown twin of the changelog. */
export function changelogMarkdown(log: Changelog, repo: string): string {
  const lines = ['# Changelog', '', `Stable ships from \`main\`, beta from \`dev\`. Source: https://github.com/${repo}`, ''];
  for (const e of log.entries) {
    lines.push(`## ${e.title}`, '', `- Channel: ${e.channel}`, `- Version: ${e.version}`, `- Date: ${new Date(e.date).toISOString().slice(0, 10)}`, `- Link: ${e.url}`, '');
  }
  if (!log.entries.length) lines.push('No entries yet.');
  return lines.join('\n');
}
