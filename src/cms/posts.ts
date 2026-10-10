/**
 * Blog posts: bundled Markdown seeds plus D1 posts managed through the admin API/MCP.
 * A D1 post with the same slug as a bundled one overrides it.
 */
import { z } from 'zod';
import { BUNDLED_POSTS, type BlogPost } from '../content';
import type { Env, Principal } from '../env';
import { newId, now, slugify } from '../lib/util';
import { recordAudit } from '../services/admin/audit';

export interface PostRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  markdown: string;
  cover_url: string;
  tags: string;
  category: string;
  author_name: string;
  status: 'draft' | 'published';
  seo_title: string;
  seo_description: string;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

export const PostInputSchema = z.object({
  slug: z.string().max(80).optional(),
  title: z.string().min(1).max(160),
  markdown: z.string().min(1).max(100_000),
  excerpt: z.string().max(400).optional(),
  tags: z.array(z.string().max(30)).max(12).optional(),
  category: z.enum(['article', 'announcement', 'guide']).optional(),
  cover_url: z.string().max(500).optional(),
  seo_title: z.string().max(160).optional(),
  seo_description: z.string().max(300).optional(),
});
export type PostInput = z.infer<typeof PostInputSchema>;

function rowToPost(r: PostRow): BlogPost {
  return {
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    category: r.category,
    tags: r.tags.split(/\s+/).filter(Boolean),
    publishedAt: r.published_at ?? r.created_at,
    seoTitle: r.seo_title,
    seoDescription: r.seo_description,
    coverUrl: r.cover_url,
    authorName: r.author_name,
    markdown: r.markdown,
    source: 'db',
  };
}

export async function publishedPosts(env: Env): Promise<BlogPost[]> {
  const { results } = await env.DB.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 200").all<PostRow>();
  const db = results.map(rowToPost);
  const slugs = new Set(db.map((p) => p.slug));
  return [...db, ...BUNDLED_POSTS.filter((p) => !slugs.has(p.slug))].sort((a, b) => b.publishedAt - a.publishedAt);
}

export async function findPublishedPost(env: Env, slug: string): Promise<BlogPost | null> {
  const row = await env.DB.prepare("SELECT * FROM posts WHERE slug = ? AND status = 'published'").bind(slug).first<PostRow>();
  if (row) return rowToPost(row);
  return BUNDLED_POSTS.find((p) => p.slug === slug) ?? null;
}

export async function listAllPosts(env: Env): Promise<(PostRow | (BlogPost & { id: null; status: 'bundled' }))[]> {
  const { results } = await env.DB.prepare('SELECT * FROM posts ORDER BY updated_at DESC LIMIT 200').all<PostRow>();
  const slugs = new Set(results.map((p) => p.slug));
  return [...results, ...BUNDLED_POSTS.filter((p) => !slugs.has(p.slug)).map((p) => ({ ...p, id: null, status: 'bundled' as const }))];
}

export async function getPostRow(env: Env, idOrSlug: string): Promise<PostRow | null> {
  return env.DB.prepare('SELECT * FROM posts WHERE id = ? OR slug = ?').bind(idOrSlug, idOrSlug).first<PostRow>();
}

async function audit(env: Env, actor: Principal, action: string, target: string, meta: Record<string, unknown> = {}) {
  await recordAudit(env, actor, { action, targetType: 'post', target, meta });
}

export async function createPost(env: Env, actor: Principal, input: PostInput): Promise<PostRow> {
  const slug = slugify(input.slug || input.title);
  if (!slug) throw new Error('A slug or title is required');
  if (await getPostRow(env, slug)) throw Object.assign(new Error(`Slug "${slug}" already exists`), { status: 409, code: 'slug_taken' });
  const ts = now();
  const id = newId('pst_');
  await env.DB.prepare(
    'INSERT INTO posts (id,slug,title,excerpt,markdown,cover_url,tags,category,status,seo_title,seo_description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(id, slug, input.title, input.excerpt ?? '', input.markdown, input.cover_url ?? '', (input.tags ?? []).join(' '), input.category ?? 'article', 'draft', input.seo_title ?? '', input.seo_description ?? '', ts, ts)
    .run();
  await audit(env, actor, 'post.create', id);
  return (await getPostRow(env, id))!;
}

export async function updatePost(env: Env, actor: Principal, id: string, input: Partial<PostInput>): Promise<PostRow | null> {
  const row = await getPostRow(env, id);
  if (!row) return null;
  const next = {
    slug: input.slug ? slugify(input.slug) : row.slug,
    title: input.title ?? row.title,
    excerpt: input.excerpt ?? row.excerpt,
    markdown: input.markdown ?? row.markdown,
    cover_url: input.cover_url ?? row.cover_url,
    tags: input.tags ? input.tags.join(' ') : row.tags,
    category: input.category ?? row.category,
    seo_title: input.seo_title ?? row.seo_title,
    seo_description: input.seo_description ?? row.seo_description,
  };
  await env.DB.prepare('UPDATE posts SET slug=?,title=?,excerpt=?,markdown=?,cover_url=?,tags=?,category=?,seo_title=?,seo_description=?,updated_at=? WHERE id=?')
    .bind(next.slug, next.title, next.excerpt, next.markdown, next.cover_url, next.tags, next.category, next.seo_title, next.seo_description, now(), row.id)
    .run();
  await audit(env, actor, 'post.update', row.id);
  return getPostRow(env, row.id);
}

export async function setPostPublished(env: Env, actor: Principal, id: string, publish: boolean): Promise<PostRow | null> {
  const row = await getPostRow(env, id);
  if (!row) return null;
  await env.DB.prepare('UPDATE posts SET status=?, published_at=COALESCE(published_at, ?), updated_at=? WHERE id=?')
    .bind(publish ? 'published' : 'draft', publish ? now() : null, now(), row.id)
    .run();
  await audit(env, actor, publish ? 'post.publish' : 'post.unpublish', row.id);
  return getPostRow(env, row.id);
}

export async function deletePost(env: Env, actor: Principal, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
  if (res.meta.changes) await audit(env, actor, 'post.delete', id);
  return res.meta.changes > 0;
}

/**
 * Copy a bundled (file-based) post into the database so it can be edited. Returns the existing
 * database post when one already has the slug; null when no bundled post has it.
 */
export async function forkBundledPost(env: Env, actor: Principal, slug: string): Promise<{ post: PostRow; forked: boolean } | null> {
  const existing = await getPostRow(env, slug);
  if (existing) return { post: existing, forked: false };
  const src = BUNDLED_POSTS.find((p) => p.slug === slug);
  if (!src) return null;
  const row = await createPost(env, actor, {
    slug: src.slug,
    title: src.title,
    markdown: src.markdown,
    excerpt: src.excerpt,
    category: (['article', 'announcement', 'guide'].includes(src.category) ? src.category : 'article') as 'article',
    tags: src.tags,
    cover_url: src.coverUrl,
    seo_title: src.seoTitle,
    seo_description: src.seoDescription,
  });
  // Keep the original date so the fork does not jump to the top of the blog once published.
  await env.DB.prepare('UPDATE posts SET published_at = ?, author_name = ? WHERE id = ?').bind(src.publishedAt || null, src.authorName, row.id).run();
  await audit(env, actor, 'post.fork', row.id, { slug: src.slug });
  return { post: (await getPostRow(env, row.id)) ?? row, forked: true };
}
