/**
 * Admin screens. Access follows the session principal's scopes (derived from the role), the same
 * scopes the API and MCP enforce, so a screen never offers an action its backend would refuse.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import type { Child } from 'hono/jsx';
import { markVia, requireUserPage, sameOriginWrites, type AppContext } from '../auth/middleware';
import { createPage, getPage, listPages, PageError, TEMPLATES } from '../cms/pages';
import { createPost, deletePost, forkBundledPost, getPostRow, listAllPosts, PostInputSchema, setPostPublished, updatePost, type PostRow } from '../cms/posts';
import { PAGE_BUILDER_GUIDE } from '../content';
import type { AppBindings, Scope } from '../env';
import { renderMarkdown } from '../lib/markdown';
import { addSiteOptout, listSiteOptouts, removeSiteOptout } from '../services/admin/optouts';
import { readSettings, SETTING_FIELDS, updateSettings } from '../services/admin/settings';
import { AdminError } from '../services/admin/shared';
import { listUsers, setUserStatus, updateUserRole } from '../services/admin/users';
import { OptoutsPage, PageEditorPage, PagesListPage, PostEditorPage, PostsListPage, SettingsPage, UsersPage, type UserFilters } from '../views/admin';
import { DashShell } from '../views/dashboard';
import { formData, renderMessage, renderPage } from './shared';

export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use('*', requireUserPage, sameOriginWrites);

const can = (c: AppContext, scope: Scope) => c.get('principal').scopes.includes(scope);

function needs(scope: Scope): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!can(c, scope)) return renderMessage(c, 403, 'Not allowed', `Your role does not include ${scope}. Ask an admin to change your role.`, <a class="btn btn-dark" href="/dashboard">Back to dashboard</a>);
    markVia(c, 'web');
    await next();
  };
}

function shell(c: AppContext, current: string, title: string, children: Child, opts: { actions?: Child; status?: number; scripts?: string[]; variant?: 'app' | 'bare' } = {}) {
  return renderPage(
    c,
    { title, path: current, noindex: true, markdownPath: null, variant: opts.variant ?? 'app', scripts: opts.scripts },
    <DashShell user={c.get('user')!} current={current} title={title} actions={opts.actions}>
      {children}
    </DashShell>,
    opts.status,
  );
}

adminRoutes.get('/', (c) => c.redirect(can(c, 'pages:read') ? '/admin/pages' : '/dashboard'));

// ─── Pages (builder) ────────────────────────────────────────────────────────

async function pagesList(c: AppContext, error?: string, status = 200) {
  const pages = (await listPages(c.env)).filter((p) => p.status !== 'archived');
  const guide = (
    <a class="btn btn-ghost btn-sm" href="/admin/docs/page-builder">
      Builder guide
    </a>
  );
  return shell(c, '/admin/pages', 'Pages', <PagesListPage pages={pages} canWrite={can(c, 'pages:write')} error={error} />, { status, actions: guide });
}

adminRoutes.get('/pages', needs('pages:read'), (c) => pagesList(c));

adminRoutes.get('/docs/page-builder', needs('pages:read'), (c) => {
  const { html } = renderMarkdown(PAGE_BUILDER_GUIDE.markdown, { trusted: true });
  return shell(
    c,
    '/admin/pages',
    PAGE_BUILDER_GUIDE.title,
    <article class="card max-w-[860px] p-5 md:p-8">
      {PAGE_BUILDER_GUIDE.description ? <p class="text-lg text-muted">{PAGE_BUILDER_GUIDE.description}</p> : null}
      <div class="prose-md mt-6" dangerouslySetInnerHTML={{ __html: html }} />
    </article>,
    { actions: <a class="btn btn-ghost btn-sm" href="/admin/pages">Back to pages</a> },
  );
});

adminRoutes.post('/pages', needs('pages:write'), async (c) => {
  const f = await formData(c);
  const title = (f.title ?? '').trim();
  if (!title) return pagesList(c, 'Give the page a title.', 400);
  const template = f.template && TEMPLATES[f.template] ? f.template : 'blank';
  try {
    const row = await createPage(c.env, c.get('principal'), { title: title.slice(0, 140), slug: (f.slug || title).slice(0, 80), template });
    return c.redirect(`/admin/pages/${row.id}`);
  } catch (e) {
    if (e instanceof PageError) return pagesList(c, e.message, e.status);
    throw e;
  }
});

adminRoutes.get('/pages/:id', needs('pages:read'), async (c) => {
  const page = await getPage(c.env, c.req.param('id'));
  if (!page || page.status === 'archived') return renderMessage(c, 404, 'Page not found', 'It may have been archived.', <a class="btn btn-dark" href="/admin/pages">All pages</a>);
  // The editor is a full-screen tool: no dashboard chrome.
  return renderPage(c, { title: `Edit · ${page.title}`, path: `/admin/pages/${page.id}`, noindex: true, markdownPath: null, variant: 'bare', scripts: ['/assets/js/editor.js'] }, <PageEditorPage page={page} canPublish={can(c, 'pages:publish')} />);
});

// ─── Blog posts ─────────────────────────────────────────────────────────────

adminRoutes.get('/posts', needs('content:read'), async (c) => shell(c, '/admin/posts', 'Blog posts', <PostsListPage posts={await listAllPosts(c.env)} canWrite={can(c, 'content:write')} />));

function editor(c: AppContext, post: PostRow | null, extra: { error?: string; notice?: string } = {}, status = 200) {
  return shell(c, '/admin/posts', post ? `Edit post` : 'New post', <PostEditorPage post={post} canPublish={can(c, 'content:publish')} error={extra.error} notice={extra.notice} />, { status, scripts: ['/assets/js/md-preview.js'] });
}

/** Form fields → PostInput (tags are comma or space separated in the form). */
function postInput(f: Record<string, string>) {
  return PostInputSchema.safeParse({
    title: (f.title ?? '').trim(),
    markdown: f.markdown ?? '',
    slug: f.slug?.trim() || undefined,
    excerpt: f.excerpt?.trim() || '',
    category: ['article', 'announcement', 'guide'].includes(f.category) ? f.category : 'article',
    tags: (f.tags ?? '')
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12),
    cover_url: f.cover_url?.trim() || '',
    seo_title: f.seo_title?.trim() || '',
    seo_description: f.seo_description?.trim() || '',
  });
}

const issueText = (issues: { path: PropertyKey[]; message: string }[]) => issues.map((i) => `${String(i.path[0] ?? 'form')}: ${i.message}`).join(' · ');

adminRoutes.get('/posts/new', needs('content:write'), (c) => editor(c, null));

adminRoutes.post('/posts/new', needs('content:write'), async (c) => {
  const f = await formData(c);
  const parsed = postInput(f);
  if (!parsed.success) return editor(c, null, { error: issueText(parsed.error.issues) }, 422);
  try {
    const row = await createPost(c.env, c.get('principal'), parsed.data);
    if (f.intent === 'publish' && can(c, 'content:publish')) await setPostPublished(c.env, c.get('principal'), row.id, true);
    return c.redirect(`/admin/posts/${row.id}?saved=${f.intent === 'publish' ? 'published' : 'draft'}`);
  } catch (e) {
    return editor(c, null, { error: (e as Error).message }, (e as { status?: number }).status ?? 400);
  }
});

/** Copy a bundled (file-based) post into the database so it can be edited. */
adminRoutes.post('/posts/fork', needs('content:write'), async (c) => {
  const f = await formData(c);
  const out = await forkBundledPost(c.env, c.get('principal'), f.slug ?? '');
  if (!out) return renderMessage(c, 404, 'Post not found', 'That bundled post does not exist.');
  return c.redirect(out.forked ? `/admin/posts/${out.post.id}?saved=forked` : `/admin/posts/${out.post.id}`);
});

const SAVED: Record<string, string> = {
  draft: 'Draft saved.',
  published: 'Published — it is live on the blog.',
  unpublished: 'Unpublished — the post is a draft again.',
  forked: 'Copied into the editor. Publish to replace the bundled version.',
};

adminRoutes.get('/posts/:id', needs('content:read'), async (c) => {
  const post = await getPostRow(c.env, c.req.param('id'));
  if (!post) return renderMessage(c, 404, 'Post not found', 'It may have been deleted.', <a class="btn btn-dark" href="/admin/posts">All posts</a>);
  return editor(c, post, { notice: SAVED[c.req.query('saved') ?? ''] });
});

adminRoutes.post('/posts/:id', needs('content:write'), async (c) => {
  const f = await formData(c);
  const actor = c.get('principal');
  const post = await getPostRow(c.env, c.req.param('id'));
  if (!post) return renderMessage(c, 404, 'Post not found', 'It may have been deleted.');
  if (f.intent === 'delete') {
    await deletePost(c.env, actor, post.id);
    return c.redirect('/admin/posts');
  }
  if ((f.intent === 'publish' || f.intent === 'unpublish') && !can(c, 'content:publish')) return editor(c, post, { error: 'Your role cannot publish. Save the draft and ask an editor.' }, 403);
  const parsed = postInput(f);
  if (!parsed.success) return editor(c, { ...post, ...f } as PostRow, { error: issueText(parsed.error.issues) }, 422);
  try {
    await updatePost(c.env, actor, post.id, parsed.data);
  } catch (e) {
    return editor(c, { ...post, ...f } as PostRow, { error: (e as Error).message.includes('UNIQUE') ? 'That slug is already used by another post.' : (e as Error).message }, 409);
  }
  if (f.intent === 'publish') await setPostPublished(c.env, actor, post.id, true);
  if (f.intent === 'unpublish') await setPostPublished(c.env, actor, post.id, false);
  return c.redirect(`/admin/posts/${post.id}?saved=${f.intent === 'publish' ? 'published' : f.intent === 'unpublish' ? 'unpublished' : 'draft'}`);
});

// ─── Users & roles ──────────────────────────────────────────────────────────
// Thin adapters over services/admin: the services own rank rules, concurrency guards and audit.

/** Business-rule failures render inline; anything else is a real error. */
function adminFailure(err: unknown): string {
  if (err instanceof AdminError) return err.message;
  throw err;
}

const USER_NOTICES: Record<string, string> = { role: 'Role updated.', suspended: 'Account suspended and signed out.', active: 'Account reactivated.' };

async function usersList(c: AppContext, error?: string, status = 200) {
  const q = c.req.query();
  const filters: UserFilters = { search: q.search || undefined, role: q.role || undefined, status: q.status || undefined };
  let page: Awaited<ReturnType<typeof listUsers>> = { items: [], next_cursor: null };
  try {
    page = await listUsers(c.env, c.get('principal'), { ...filters, cursor: q.cursor || undefined, limit: 50 });
  } catch (err) {
    error = adminFailure(err);
    status = 400;
  }
  return shell(
    c,
    '/admin/users',
    'Users & roles',
    <UsersPage
      users={page.items}
      nextCursor={page.next_cursor}
      filters={filters}
      canWriteRole={can(c, 'users:roles:write')}
      canSuspend={can(c, 'users:sessions:write')}
      me={c.get('user')!.id}
      notice={USER_NOTICES[q.saved ?? '']}
      error={error}
    />,
    { status },
  );
}

adminRoutes.get('/users', needs('users:read'), (c) => usersList(c));

adminRoutes.post('/users/:id', needs('users:read'), async (c) => {
  const f = await formData(c);
  const userId = c.req.param('id');
  try {
    if (f.intent === 'status') {
      const out = await setUserStatus(c.env, c.get('principal'), { userId, status: f.status, reason: f.reason ?? '', expectedStatus: f.expectedStatus || undefined });
      return c.redirect(`/admin/users?saved=${out.user.status}`);
    }
    await updateUserRole(c.env, c.get('principal'), { userId, role: f.role, expectedRole: f.expectedRole || undefined });
    return c.redirect('/admin/users?saved=role');
  } catch (err) {
    const message = adminFailure(err);
    return usersList(c, message, err instanceof AdminError ? err.status : 400);
  }
});

// ─── Site opt-outs ──────────────────────────────────────────────────────────

const OPTOUT_NOTICES: Record<string, string> = { added: 'Domain blocked. Conversions stop right away.', removed: 'Domain unblocked.' };

async function optoutsList(c: AppContext, error?: string, status = 200) {
  const search = c.req.query('search') || undefined;
  let page: Awaited<ReturnType<typeof listSiteOptouts>> = { items: [], next_cursor: null, total: 0 };
  try {
    page = await listSiteOptouts(c.env, c.get('principal'), { search, cursor: c.req.query('cursor') || undefined, limit: 100 });
  } catch (err) {
    error = adminFailure(err);
    status = 400;
  }
  return shell(
    c,
    '/admin/optouts',
    'Site opt-outs',
    <OptoutsPage optouts={page.items} total={page.total} search={search} nextCursor={page.next_cursor} canWrite={can(c, 'optouts:write')} error={error} notice={OPTOUT_NOTICES[c.req.query('saved') ?? '']} />,
    { status },
  );
}

adminRoutes.get('/optouts', needs('optouts:read'), (c) => optoutsList(c));

adminRoutes.post('/optouts', needs('optouts:write'), async (c) => {
  const f = await formData(c);
  try {
    if (f.intent === 'remove') await removeSiteOptout(c.env, c.get('principal'), { domain: f.domain ?? '' });
    else await addSiteOptout(c.env, c.get('principal'), { domain: f.domain ?? '', reason: (f.reason ?? '').trim().slice(0, 300) });
  } catch (err) {
    const message = adminFailure(err);
    return optoutsList(c, message, err instanceof AdminError ? err.status : 400);
  }
  return c.redirect(`/admin/optouts?saved=${f.intent === 'remove' ? 'removed' : 'added'}`);
});

// ─── Settings ───────────────────────────────────────────────────────────────

async function settingsPage(c: AppContext, error?: string, status = 200) {
  const { settings, version } = await readSettings(c.env, c.get('principal'));
  return shell(
    c,
    '/admin/settings',
    'Settings',
    <SettingsPage values={settings} version={version} canWrite={can(c, 'settings:write')} error={error} notice={c.req.query('saved') ? 'Settings saved. Public pages pick them up right away.' : undefined} />,
    { status },
  );
}

adminRoutes.get('/settings', needs('settings:read'), (c) => settingsPage(c));

adminRoutes.post('/settings', needs('settings:write'), async (c) => {
  const f = await formData(c);
  const patch: Record<string, string> = {};
  for (const field of SETTING_FIELDS) patch[field.key] = (f[field.key] ?? '').trim().slice(0, 1000);
  try {
    await updateSettings(c.env, c.get('principal'), { patch, expectedVersion: Number(f.expectedVersion) || undefined });
  } catch (err) {
    const message = adminFailure(err);
    return settingsPage(c, message, err instanceof AdminError ? err.status : 400);
  }
  return c.redirect('/admin/settings?saved=1');
});
