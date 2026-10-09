/** Page and blog operations that REST and the web admin already had, now over MCP too. */
import { z } from 'zod';
import { archivePage, getPage, listRevisions, pageToMarkdown, parseDoc, rotatePreviewToken, type PageRow } from '../cms/pages';
import { deletePost, forkBundledPost, getPostRow } from '../cms/posts';
import type { Env } from '../env';
import { DESTRUCTIVE, IDEMPOTENT_WRITE, READ_ONLY, ToolError, type ToolDef } from './tool-types';

async function livePage(env: Env, idOrSlug: string): Promise<PageRow> {
  const row = await getPage(env, idOrSlug);
  if (!row || row.status === 'archived') throw new ToolError('Page not found', 'not_found');
  return row;
}

const PAGE_ID = z.object({ pageId: z.string().min(1).max(120).describe('Page id or slug') });

export const CMS_PARITY_TOOLS: ToolDef[] = [
  {
    name: 'archive_page',
    title: 'Archive page',
    description: 'Take a page offline and archive it; its slug is freed. Archived pages are hidden from every page tool.',
    scope: 'pages:write',
    input: PAGE_ID,
    annotations: DESTRUCTIVE,
    run: async (a, t) => archivePage(t.env, t.principal, (await livePage(t.env, a.pageId)).id),
  },
  {
    name: 'list_page_revisions',
    title: 'List page revisions',
    description: 'The last 50 revisions of a page draft (revision, author, note, time), newest first.',
    scope: 'pages:read',
    input: PAGE_ID,
    annotations: READ_ONLY,
    run: async (a, t) => ({ items: await listRevisions(t.env, (await livePage(t.env, a.pageId)).id) }),
  },
  {
    name: 'rotate_page_preview_token',
    title: 'Rotate page preview link',
    description: 'Issue a new draft preview link; the previous link stops working.',
    scope: 'pages:write',
    input: PAGE_ID,
    annotations: { ...DESTRUCTIVE, idempotentHint: false },
    run: async (a, t) => {
      const page = await livePage(t.env, a.pageId);
      const token = await rotatePreviewToken(t.env, t.principal, page.id);
      return { pageId: page.id, previewUrl: `${t.origin}/p/${page.slug}?preview=${token}` };
    },
  },
  {
    name: 'get_page_markdown',
    title: 'Get page as Markdown',
    description: 'The page draft rendered as Markdown (title, description and every block).',
    scope: 'pages:read',
    input: PAGE_ID,
    annotations: READ_ONLY,
    run: async (a, t) => {
      const page = await livePage(t.env, a.pageId);
      const doc = parseDoc(page.draft);
      if (!doc) throw new ToolError('Page draft is unreadable', 'invalid_document');
      return { pageId: page.id, slug: page.slug, revision: page.revision, markdown: pageToMarkdown(page.title, page.description, doc) };
    },
  },
  {
    name: 'get_post',
    title: 'Get blog post',
    description: 'One database blog post by id or slug, with its Markdown body. Bundled posts must be copied with fork_post first.',
    scope: 'content:read',
    input: z.object({ id: z.string().min(1).max(200).describe('Post id or slug') }),
    annotations: READ_ONLY,
    run: async (a, t) => {
      const row = await getPostRow(t.env, a.id);
      if (!row) throw new ToolError('Post not found. Bundled posts appear in list_posts with status bundled; copy one with fork_post.', 'not_found');
      return { ...row, tags: row.tags.split(/\s+/).filter(Boolean) };
    },
  },
  {
    name: 'delete_post',
    title: 'Delete blog post',
    description: 'Permanently delete a database blog post. Prefer publish_post with publish=false to take it offline reversibly.',
    scope: 'content:write',
    input: z.object({ id: z.string().min(1).max(80).describe('Post id') }),
    annotations: DESTRUCTIVE,
    run: async (a, t) => {
      if (!(await deletePost(t.env, t.principal, a.id))) throw new ToolError('Post not found', 'not_found');
      return { deleted: true, id: a.id };
    },
  },
  {
    name: 'fork_post',
    title: 'Copy bundled post',
    description: 'Copy a bundled (file-based) post into the database as a draft so it can be edited with upsert_post. Returns the existing copy when there is one.',
    scope: 'content:write',
    input: z.object({ slug: z.string().min(1).max(200) }),
    annotations: IDEMPOTENT_WRITE,
    run: async (a, t) => {
      const out = await forkBundledPost(t.env, t.principal, a.slug);
      if (!out) throw new ToolError('No bundled post has that slug', 'not_found');
      return { id: out.post.id, slug: out.post.slug, status: out.post.status, forked: out.forked };
    },
  },
];
