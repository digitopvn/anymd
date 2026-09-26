/** Helpers shared by the HTML routes: page rendering, Markdown responses, form parsing. */
import type { Child } from 'hono/jsx';
import type { AppContext } from '../auth/middleware';
import { getSettings } from '../lib/settings';
import { Layout, type LayoutProps } from '../views/layout';
import { MessagePage } from '../views/pages';

export function originOf(c: AppContext): string {
  return new URL(c.req.url).origin;
}

type PageOptions = Omit<LayoutProps, 'children' | 'origin' | 'user' | 'announcement'>;

export async function renderPage(c: AppContext, meta: PageOptions, children: Child, status = 200) {
  const user = c.get('user');
  let announcement: LayoutProps['announcement'] = null;
  if ((meta.variant ?? 'default') === 'default') {
    const s = await getSettings(c.env).catch(() => ({}) as Record<string, string>);
    if (s.announcement) announcement = { text: s.announcement, href: s.announcement_href || undefined };
  }
  const html = (
    <Layout {...meta} origin={originOf(c)} user={user ? { name: user.name, email: user.email, role: user.role } : null} announcement={announcement}>
      {children}
    </Layout>
  );
  c.header('Vary', 'Accept, Cookie');
  return c.html('<!doctype html>' + html.toString(), status as 200);
}

export function renderMessage(c: AppContext, status: number, title: string, body: string, children?: Child) {
  return renderPage(c, { title, path: new URL(c.req.url).pathname, markdownPath: null, noindex: true }, <MessagePage code={String(status)} title={title} body={body} children={children} />, status);
}

/** A client asked for Markdown: `Accept: text/markdown` (and not HTML first). */
export function wantsMarkdown(c: AppContext): boolean {
  const accept = c.req.header('accept') ?? '';
  return /text\/markdown|text\/x-markdown/i.test(accept) && !/^text\/html/i.test(accept);
}

export function markdownResponse(c: AppContext, markdown: string, canonical?: string, status = 200) {
  const headers: Record<string, string> = {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'Access-Control-Allow-Origin': '*',
    Vary: 'Accept',
  };
  if (canonical) headers.Link = `<${canonical}>; rel="canonical"`;
  return c.body(markdown, status as 200, headers);
}

export async function formData(c: AppContext): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Only allow same-site relative redirects (`/dashboard`, not `//evil.com`). */
export function safeNext(raw: string | undefined | null, fallback = '/dashboard'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  return raw;
}

export function clientIp(c: AppContext): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
}
