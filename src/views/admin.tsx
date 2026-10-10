/** Admin screens: landing pages (builder), blog posts, users & roles, site opt-outs, settings. */
import { ROLE_TEMPLATES } from '../auth/roles';
import type { PostRow } from '../cms/posts';
import type { PageRow } from '../cms/pages';
import type { SiteOptout } from '../convert/optouts';
import { TEMPLATES } from '../cms/pages';
import type { BlogPost } from '../content';
import type { RoleName } from '../env';
import { humanDate, timeAgo } from '../lib/util';
import { SETTING_FIELDS } from '../services/admin/settings';
import type { UserSummary } from '../services/admin/users';
import { Icon } from './components/icons';

function StatusChip({ status }: { status: string }) {
  const cls = status === 'published' ? 'chip-mint' : status === 'bundled' ? '' : '!bg-warn-soft !text-warn !border-warn-line';
  return <span class={`chip !py-0 ${cls}`}>{status}</span>;
}

export function PagesListPage({ pages, canWrite, error }: { pages: PageRow[]; canWrite: boolean; error?: string }) {
  return (
    <>
      {error ? <p class="mb-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}
      {canWrite ? (
        <form method="post" action="/admin/pages" class="card mb-4 grid gap-3 p-5 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
          <div>
            <label class="label" for="pg-title">
              Title
            </label>
            <input id="pg-title" name="title" class="input" required maxlength={140} placeholder="Markdown for researchers" />
          </div>
          <div>
            <label class="label" for="pg-slug">
              Slug
            </label>
            <div class="flex items-center rounded-xl border border-line bg-card pl-3 focus-within:border-accent">
              <span class="font-mono text-sm text-muted">/p/</span>
              <input id="pg-slug" name="slug" class="min-w-0 flex-1 bg-transparent px-1 py-3 outline-none" required maxlength={80} placeholder="researchers" />
            </div>
          </div>
          <div>
            <label class="label" for="pg-template">
              Template
            </label>
            <select id="pg-template" name="template" class="input">
              {Object.entries(TEMPLATES).map(([id, t]) => (
                <option value={id}>{t.label}</option>
              ))}
            </select>
          </div>
          <button class="btn btn-dark h-[46px]" type="submit">
            <Icon name="plus" size={16} /> New page
          </button>
        </form>
      ) : null}
      {pages.length ? (
        <div class="card overflow-hidden">
          <ul>
            {pages.map((p) => (
              <li class="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5 last:border-0">
                <div class="min-w-0 flex-1">
                  <a href={`/admin/pages/${p.id}`} class="font-semibold hover:underline">
                    {p.title}
                  </a>
                  <p class="text-xs text-muted">
                    /p/{p.slug} · rev {p.revision}
                    {p.published_revision ? ` · live rev ${p.published_revision}` : ''} · edited {timeAgo(p.updated_at)}
                  </p>
                </div>
                <StatusChip status={p.status} />
                {p.status === 'published' ? (
                  <a href={`/p/${p.slug}`} target="_blank" class="btn btn-ghost btn-sm" rel="noopener">
                    <Icon name="external" size={14} /> View
                  </a>
                ) : null}
                <a href={`/admin/pages/${p.id}`} class="btn btn-dark btn-sm">
                  Edit
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div class="card px-6 py-14 text-center text-sm text-muted">No pages yet. Create one above, or let an agent do it over MCP with the page tools.</div>
      )}
    </>
  );
}

/** Page editor shell; `client/editor.ts` renders the outline, forms and live preview. */
export function PageEditorPage({ page, canPublish }: { page: PageRow; canPublish: boolean }) {
  const boot = { pageId: page.id, canPublish };
  return (
    <div data-editor>
      <script type="application/json" id="editor-boot" dangerouslySetInnerHTML={{ __html: JSON.stringify(boot).replace(/</g, '\\u003c') }} />
      <div class="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-line bg-paper/95 px-5 py-3 backdrop-blur md:px-8">
        <a href="/admin/pages" class="btn btn-ghost btn-sm" aria-label="Back to pages">
          ←
        </a>
        <div class="min-w-0 flex-1">
          <p class="truncate font-semibold" data-ed-title>
            {page.title}
          </p>
          <p class="truncate text-xs text-muted">
            /p/<span data-ed-slug>{page.slug}</span> · rev <span data-ed-rev>{page.revision}</span> · <span data-ed-status>{page.status}</span>
            <span data-ed-saving class="ml-2 hidden text-accent-ink">
              Saving…
            </span>
          </p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-ed-action="undo" title="Undo last change (restores previous revision as a new one)">
          Undo
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-ed-action="settings">
          <Icon name="settings" size={15} /> <span class="hidden sm:inline">Page settings</span>
        </button>
        <a class="btn btn-ghost btn-sm" data-ed-preview-link target="_blank" rel="noopener" href="#">
          <Icon name="eye" size={15} /> <span class="hidden sm:inline">Share preview</span>
        </a>
        {canPublish ? (
          <button type="button" class="btn btn-primary btn-sm" data-ed-action="publish">
            Publish
          </button>
        ) : null}
      </div>
      <div class="flex gap-1 border-b border-line bg-card px-5 py-2 lg:hidden" role="tablist" data-ed-tabs>
        {[
          ['outline', 'Blocks'],
          ['preview', 'Preview'],
          ['props', 'Edit'],
        ].map(([id, label], i) => (
          <button type="button" class="tab !text-muted aria-selected:!bg-ink aria-selected:!text-paper" role="tab" aria-selected={i === 0 ? 'true' : 'false'} data-ed-tab={id}>
            {label}
          </button>
        ))}
      </div>
      <div class="grid min-h-[calc(100dvh-140px)] grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        <section class="border-line bg-card p-4 lg:border-r" data-ed-pane="outline" aria-label="Blocks">
          <div class="flex items-center justify-between">
            <p class="font-bold">Blocks</p>
            <button type="button" class="btn btn-dark btn-sm" data-ed-action="add">
              <Icon name="plus" size={15} /> Add
            </button>
          </div>
          <ol class="mt-3 space-y-1.5" data-ed-outline />
          <div class="mt-4 hidden" data-ed-palette>
            <p class="mb-2 text-sm font-semibold text-muted">Insert a block</p>
            <div class="grid grid-cols-2 gap-1.5" data-ed-palette-list />
          </div>
        </section>
        <section class="hidden min-w-0 bg-paper-2/60 p-3 lg:block" data-ed-pane="preview" aria-label="Preview">
          <div class="mb-2 flex justify-end gap-1" role="group" aria-label="Preview width">
            {[
              ['375', 'Mobile'],
              ['768', 'Tablet'],
              ['100%', 'Desktop'],
            ].map(([w, l], i) => (
              <button type="button" class="chip aria-pressed:!bg-ink aria-pressed:!text-paper" aria-pressed={i === 2 ? 'true' : 'false'} data-ed-width={w}>
                {l}
              </button>
            ))}
          </div>
          <div class="mx-auto h-[calc(100dvh-200px)] overflow-hidden rounded-xl border border-line bg-card shadow-card transition-all" style="width:100%" data-ed-frame-wrap>
            <iframe title="Page preview" class="h-full w-full" data-ed-frame />
          </div>
        </section>
        <section class="hidden border-line bg-card p-4 lg:block lg:border-l" data-ed-pane="props" aria-label="Block properties">
          <div data-ed-props>
            <p class="text-sm text-muted">Select a block to edit its content, size and layout.</p>
          </div>
        </section>
      </div>
      <dialog class="w-[min(94vw,520px)] rounded-2xl border border-line p-0 shadow-pop backdrop:bg-night/60" data-ed-dialog>
        <form method="dialog" class="p-5" data-ed-settings-form>
          <p class="text-lg font-bold">Page settings</p>
          <div class="mt-4 space-y-3">
            <div>
              <label class="label" for="ed-set-title">Title</label>
              <input id="ed-set-title" class="input" name="title" required maxlength={140} />
            </div>
            <div>
              <label class="label" for="ed-set-slug">Slug</label>
              <input id="ed-set-slug" class="input" name="slug" required maxlength={80} />
            </div>
            <div>
              <label class="label" for="ed-set-description">Description</label>
              <textarea id="ed-set-description" class="input min-h-[80px]" name="description" maxlength={300} />
            </div>
            <div>
              <label class="label" for="ed-set-layout">Layout</label>
              <select id="ed-set-layout" class="input" name="layout">
                <option value="default">Default (site header + footer)</option>
                <option value="landing">Landing (minimal header, for ads)</option>
                <option value="article">Article</option>
              </select>
            </div>
            <div>
              <label class="label" for="ed-set-seo_title">SEO title</label>
              <input id="ed-set-seo_title" class="input" name="seo_title" maxlength={140} />
            </div>
            <div>
              <label class="label" for="ed-set-seo_description">SEO description</label>
              <textarea id="ed-set-seo_description" class="input min-h-[70px]" name="seo_description" maxlength={300} />
            </div>
            <div>
              <label class="label" for="ed-set-seo_image">Social image URL</label>
              <input id="ed-set-seo_image" class="input" name="seo_image" maxlength={500} placeholder="https://cdn.anymd.cc/…" />
            </div>
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" name="noindex" class="h-4 w-4 accent-[#05c977]" /> Hide from search engines (noindex)
            </label>
          </div>
          <div class="mt-5 flex justify-between gap-2">
            {canPublish ? (
              <button type="button" class="btn btn-ghost btn-sm !text-danger" data-ed-action="unpublish">
                Unpublish
              </button>
            ) : (
              <span />
            )}
            <div class="flex gap-2">
              <button value="cancel" class="btn btn-ghost btn-sm">
                Cancel
              </button>
              <button value="save" class="btn btn-dark btn-sm">
                Save
              </button>
            </div>
          </div>
        </form>
      </dialog>
    </div>
  );
}

type PostListItem = PostRow | (BlogPost & { id: null; status: 'bundled' });

export function PostsListPage({ posts, canWrite }: { posts: PostListItem[]; canWrite: boolean }) {
  return (
    <>
      {canWrite ? (
        <div class="mb-4 flex justify-end">
          <a href="/admin/posts/new" class="btn btn-dark">
            <Icon name="plus" size={16} /> New post
          </a>
        </div>
      ) : null}
      <div class="card overflow-hidden">
        <ul>
          {posts.map((p) => (
            <li class="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5 last:border-0">
              <div class="min-w-0 flex-1">
                <p class="font-semibold">{p.title}</p>
                <p class="text-xs text-muted">
                  /blog/{p.slug} · {'updated_at' in p ? `edited ${timeAgo(p.updated_at)}` : `bundled · ${humanDate(p.publishedAt)}`}
                </p>
              </div>
              <StatusChip status={p.status} />
              {p.status !== 'draft' ? (
                <a href={`/blog/${p.slug}`} class="btn btn-ghost btn-sm" target="_blank" rel="noopener">
                  View
                </a>
              ) : null}
              {p.id ? (
                <a href={`/admin/posts/${p.id}`} class="btn btn-dark btn-sm">
                  Edit
                </a>
              ) : canWrite ? (
                <form method="post" action="/admin/posts/fork">
                  <input type="hidden" name="slug" value={p.slug} />
                  <button class="btn btn-ghost btn-sm" type="submit" title="Copy into the database to edit">
                    Customize
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export function PostEditorPage({ post, canPublish, error, notice }: { post: PostRow | null; canPublish: boolean; error?: string; notice?: string }) {
  const v = post ?? ({ title: '', slug: '', excerpt: '', markdown: '', cover_url: '', tags: '', category: 'article', seo_title: '', seo_description: '', status: 'draft' } as Partial<PostRow>);
  return (
    <form method="post" action={post ? `/admin/posts/${post.id}` : '/admin/posts/new'} class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_340px]" data-post-editor>
      <div class="space-y-4">
        {error ? <p class="rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}
        {notice ? <p class="rounded-xl border border-ok-line bg-accent-soft px-4 py-3 text-sm text-accent-ink">{notice}</p> : null}
        <input name="title" class="input !min-h-14 font-display !text-2xl font-extrabold" placeholder="Post title" required maxlength={160} value={v.title} aria-label="Title" />
        <div class="card overflow-hidden" data-tabs>
          <div class="flex gap-1 border-b border-line bg-paper-2/60 p-2" role="tablist">
            <button type="button" class="tab !text-muted aria-selected:!bg-ink aria-selected:!text-paper" role="tab" aria-selected="true" data-tab="write">
              Write
            </button>
            <button type="button" class="tab !text-muted aria-selected:!bg-ink aria-selected:!text-paper" role="tab" aria-selected="false" data-tab="preview">
              Preview
            </button>
          </div>
          <div data-panel="write" role="tabpanel">
            <textarea name="markdown" class="block min-h-[60vh] w-full resize-y bg-card p-5 font-mono text-[14px] leading-relaxed outline-none" required placeholder="## Start writing in Markdown…" aria-label="Markdown" data-md-source>
              {v.markdown}
            </textarea>
          </div>
          <div data-panel="preview" role="tabpanel" class="hidden p-6">
            <div class="prose-md" data-md-preview />
          </div>
        </div>
      </div>
      <aside class="space-y-4">
        <div class="card space-y-3 p-5">
          <div class="flex items-center justify-between">
            <p class="font-bold">Publish</p>
            <StatusChip status={v.status ?? 'draft'} />
          </div>
          <button class="btn btn-dark w-full" type="submit" name="intent" value="save">
            Save draft
          </button>
          {canPublish && post ? (
            <button class="btn btn-primary w-full" type="submit" name="intent" value={post.status === 'published' ? 'unpublish' : 'publish'}>
              {post.status === 'published' ? 'Unpublish' : 'Save & publish'}
            </button>
          ) : null}
          {post ? (
            <button class="btn btn-ghost w-full !text-danger" type="submit" name="intent" value="delete" data-confirm="Delete this post permanently?">
              Delete
            </button>
          ) : null}
        </div>
        <div class="card space-y-3 p-5">
          <div>
            <label class="label" for="p-slug">
              Slug
            </label>
            <input id="p-slug" name="slug" class="input" value={v.slug} maxlength={80} placeholder="auto from title" />
          </div>
          <div>
            <label class="label" for="p-excerpt">
              Excerpt
            </label>
            <textarea id="p-excerpt" name="excerpt" class="input min-h-[80px]" maxlength={400}>
              {v.excerpt}
            </textarea>
          </div>
          <div>
            <label class="label" for="p-cat">
              Category
            </label>
            <select id="p-cat" name="category" class="input">
              {['article', 'announcement', 'guide'].map((c) => (
                <option value={c} selected={v.category === c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label class="label" for="p-tags">
              Tags
            </label>
            <input id="p-tags" name="tags" class="input" value={v.tags} placeholder="markdown agents mcp" />
          </div>
          <div>
            <label class="label" for="p-cover">
              Cover image URL
            </label>
            <input id="p-cover" name="cover_url" class="input" value={v.cover_url} placeholder="https://cdn.anymd.cc/…" />
          </div>
          <div>
            <label class="label" for="p-seot">
              SEO title
            </label>
            <input id="p-seot" name="seo_title" class="input" value={v.seo_title} maxlength={160} />
          </div>
          <div>
            <label class="label" for="p-seod">
              SEO description
            </label>
            <textarea id="p-seod" name="seo_description" class="input min-h-[70px]" maxlength={300}>
              {v.seo_description}
            </textarea>
          </div>
        </div>
      </aside>
    </form>
  );
}

export interface UserFilters {
  search?: string;
  role?: string;
  status?: string;
}

const NOTICE_CLASS = 'mb-4 rounded-xl border border-ok-line bg-accent-soft px-4 py-3 text-sm text-accent-ink';
const ERROR_CLASS = 'mb-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger';

function Flash({ notice, error }: { notice?: string; error?: string }) {
  return (
    <>
      {notice ? <p class={NOTICE_CLASS}>{notice}</p> : null}
      {error ? (
        <p class={ERROR_CLASS} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * Users, newest first, with filters and cursor paging. Roles are edited here; plans are shown
 * read-only because the billing provider owns them (use credit grants for support allowances).
 */
export function UsersPage({
  users,
  nextCursor,
  filters,
  canWriteRole,
  canSuspend,
  me,
  notice,
  error,
}: {
  users: UserSummary[];
  nextCursor: string | null;
  filters: UserFilters;
  canWriteRole: boolean;
  canSuspend: boolean;
  me: string;
  notice?: string;
  error?: string;
}) {
  const next = new URLSearchParams(Object.entries({ ...filters, cursor: nextCursor ?? '' }).filter(([, v]) => v) as [string, string][]);
  return (
    <>
      <Flash notice={notice} error={error} />
      <form method="get" action="/admin/users" class="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div class="min-w-[200px] flex-1">
          <label class="label" for="u-search">
            Search
          </label>
          <input id="u-search" name="search" class="input" placeholder="Email, name or user id" value={filters.search ?? ''} maxlength={200} />
        </div>
        <div>
          <label class="label" for="u-role">
            Role
          </label>
          <select id="u-role" name="role" class="input !w-auto">
            <option value="">Any</option>
            {Object.entries(ROLE_TEMPLATES).map(([id, r]) => (
              <option value={id} selected={filters.role === id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label class="label" for="u-status">
            Status
          </label>
          <select id="u-status" name="status" class="input !w-auto">
            <option value="">Any</option>
            <option value="active" selected={filters.status === 'active'}>
              Active
            </option>
            <option value="suspended" selected={filters.status === 'suspended'}>
              Suspended
            </option>
          </select>
        </div>
        <button class="btn btn-ghost" type="submit">
          Filter
        </button>
      </form>
      <div class="card overflow-hidden">
        <div class="scroll-x">
          <table class="table min-w-[860px]">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Joined</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr>
                  <td>
                    <p class="font-semibold">{u.name || '—'}</p>
                    <p class="text-xs text-muted">{u.email}</p>
                  </td>
                  <td>
                    {canWriteRole && u.id !== me ? (
                      <form method="post" action={`/admin/users/${u.id}`} class="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="intent" value="role" />
                        <input type="hidden" name="expectedRole" value={u.role} />
                        <select name="role" class="input !min-h-9 !w-auto !py-1 text-sm" aria-label="Role">
                          {Object.entries(ROLE_TEMPLATES).map(([id, r]) => (
                            <option value={id} selected={u.role === id}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                        <button class="btn btn-ghost btn-sm" type="submit">
                          Save
                        </button>
                      </form>
                    ) : (
                      <span class="text-sm">{ROLE_TEMPLATES[u.role as RoleName]?.label ?? u.role}</span>
                    )}
                  </td>
                  <td>
                    <span class="text-sm" title="Plans follow the billing provider">
                      {u.plan}
                    </span>
                  </td>
                  <td>
                    {canSuspend && u.id !== me ? (
                      <form method="post" action={`/admin/users/${u.id}`} class="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="intent" value="status" />
                        <input type="hidden" name="expectedStatus" value={u.status} />
                        <input type="hidden" name="status" value={u.status === 'suspended' ? 'active' : 'suspended'} />
                        <input name="reason" class="input !min-h-9 !w-40 !py-1 text-sm" placeholder="Reason" required minlength={3} maxlength={300} aria-label="Reason" />
                        <button class={`btn btn-ghost btn-sm${u.status === 'suspended' ? '' : ' !text-danger'}`} type="submit">
                          {u.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                        </button>
                      </form>
                    ) : (
                      <span class={`text-sm${u.status === 'suspended' ? ' text-danger' : ''}`}>{u.status}</span>
                    )}
                  </td>
                  <td class="whitespace-nowrap text-muted">{humanDate(u.created_at)}</td>
                  <td class="whitespace-nowrap text-muted">{u.last_login_at ? timeAgo(u.last_login_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!users.length ? <p class="p-5 text-sm text-muted">No users match these filters.</p> : null}
      </div>
      {nextCursor ? (
        <p class="mt-4">
          <a class="btn btn-ghost" href={`/admin/users?${next.toString()}`}>
            Next page
          </a>
        </p>
      ) : null}
      <p class="mt-4 text-xs text-muted">Plans come from the billing provider and cannot be edited here. Grant credits for support allowances (owner, over the API or MCP).</p>
      <RoleTemplates />
    </>
  );
}

function RoleTemplates() {
  return (
    <div class="card mt-4 p-5">
      <p class="font-bold">Role templates</p>
      <p class="mt-1 text-sm text-muted">API keys and OAuth grants can only narrow these, never widen them.</p>
      <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(ROLE_TEMPLATES).map(([id, r]) => (
          <div class="rounded-xl border border-line p-4">
            <p class="font-semibold">
              {r.label} <code class="font-mono text-xs text-muted">{id}</code>
            </p>
            <p class="mt-1 text-sm text-muted">{r.description}</p>
            <p class="mt-2 flex flex-wrap gap-1">
              {r.scopes.map((s) => (
                <span class="chip !py-0 !text-[11px]">{s}</span>
              ))}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SettingsPage({ values, version, canWrite, notice, error }: { values: Record<string, string>; version: number; canWrite: boolean; notice?: string; error?: string }) {
  return (
    <>
      <Flash notice={notice} error={error} />
      <form method="post" action="/admin/settings" class="card max-w-2xl space-y-4 p-5">
        <input type="hidden" name="expectedVersion" value={String(version)} />
        {SETTING_FIELDS.map((f) => (
          <div>
            <label class="label" for={`s-${f.key}`}>
              {f.label}
            </label>
            <input id={`s-${f.key}`} name={f.key} class="input" value={values[f.key] ?? ''} maxlength={300} disabled={!canWrite} />
            <p class="mt-1 text-xs text-muted">{f.hint}</p>
          </div>
        ))}
        {canWrite ? (
          <button class="btn btn-dark" type="submit">
            Save settings
          </button>
        ) : (
          <p class="text-xs text-muted">Read-only: your role can view settings but not change them.</p>
        )}
        <p class="text-xs text-muted">Version {version}. Changes are recorded in the audit log.</p>
      </form>
      <RoleTemplates />
    </>
  );
}

export function OptoutsPage({
  optouts,
  total,
  search,
  nextCursor,
  canWrite,
  error,
  notice,
}: {
  optouts: SiteOptout[];
  total: number;
  search?: string;
  nextCursor: string | null;
  canWrite: boolean;
  error?: string;
  notice?: string;
}) {
  return (
    <>
      <Flash notice={notice} error={error} />
      {canWrite ? (
      <form method="post" action="/admin/optouts" class="card max-w-2xl space-y-4 p-5">
        <p class="text-sm text-muted">
          Blocks conversions of the domain and all its subdomains on every channel, including cached results. Use it for owner opt-out and takedown requests
          sent through <a class="underline" href="/legal/abuse">the abuse page</a>.
        </p>
        <div>
          <label class="label" for="o-domain">
            Domain
          </label>
          <input id="o-domain" name="domain" class="input" placeholder="example.com" required maxlength={253} autocomplete="off" />
        </div>
        <div>
          <label class="label" for="o-reason">
            Reason
          </label>
          <input id="o-reason" name="reason" class="input" placeholder="Owner request by email, 2026-09-26" maxlength={300} />
          <p class="mt-1 text-xs text-muted">Internal note. Not shown to users.</p>
        </div>
        <button class="btn btn-dark" type="submit" name="intent" value="add">
          Block domain
        </button>
      </form>
      ) : null}
      <form method="get" action="/admin/optouts" class="mt-4 flex max-w-2xl gap-2">
        <input name="search" class="input" placeholder="Find a domain" value={search ?? ''} maxlength={200} aria-label="Find a domain" />
        <button class="btn btn-ghost" type="submit">
          Search
        </button>
      </form>
      <p class="mt-2 text-xs text-muted">{total} blocked domain{total === 1 ? '' : 's'}</p>
      <div class="card mt-2 max-w-2xl overflow-hidden">
        {optouts.length ? (
          <div class="scroll-x">
            <table class="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th class="hidden sm:table-cell">Added</th>
                  <th>
                    <span class="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {optouts.map((o) => (
                  <tr>
                    <td>
                      <p class="break-all font-mono text-sm">{o.domain}</p>
                      {o.reason ? <p class="mt-0.5 text-xs text-muted">{o.reason}</p> : null}
                    </td>
                    <td class="hidden whitespace-nowrap text-muted sm:table-cell">{humanDate(o.created_at)}</td>
                    <td class="text-right">
                      {canWrite ? (
                      <form method="post" action="/admin/optouts">
                        <input type="hidden" name="domain" value={o.domain} />
                        <button class="btn btn-ghost btn-sm" type="submit" name="intent" value="remove" aria-label={`Unblock ${o.domain}`}>
                          <Icon name="trash" size={15} /> Unblock
                        </button>
                      </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="p-5 text-sm text-muted">{search ? 'No blocked domain matches.' : 'No domains are blocked.'}</p>
        )}
      </div>
      {nextCursor ? (
        <p class="mt-4">
          <a class="btn btn-ghost" href={`/admin/optouts?${new URLSearchParams({ ...(search ? { search } : {}), cursor: nextCursor }).toString()}`}>
            Next page
          </a>
        </p>
      ) : null}
    </>
  );
}