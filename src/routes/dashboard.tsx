/** Signed-in dashboard pages. Mutations are plain form POSTs so everything works without JS. */
import { Hono } from 'hono';
import { SESSION_COOKIE, type ApiKeyRow } from '../auth/identity';
import { deleteCookie } from 'hono/cookie';
import { markVia, requireUserPage, sameOriginWrites, type AppContext } from '../auth/middleware';
import { billingEnabled, createCheckout, customerPortalUrl, providerName } from '../billing/provider';
import type { PlanId } from '../billing/plans';
import type { AppBindings } from '../env';
import { deleteAccount, documentsToMarkdown, exportDocuments } from '../lib/account';
import { renderMarkdown } from '../lib/markdown';
import { quotaState, monthStart } from '../lib/usage';
import { getDocument, librarySummary, listDocuments } from '../library/store';
import { searchForPrincipal, parseMode, usageSummary } from '../services';
import {
  AccountPage,
  BillingPage,
  DashShell,
  DocumentPage,
  KeysPage,
  LibraryPage,
  OverviewPage,
  SearchPage,
  TraceDetailPage,
  TracesPage,
  UsagePage,
  type TraceRow,
} from '../views/dashboard';
import type { Child } from 'hono/jsx';
import { activeKeyCount, createOwnKey, grantsOf, revokeOwnGrant, revokeOwnKey } from '../services/admin/credentials';
import { AdminError } from '../services/admin/shared';
import { formData, originOf, renderMessage, renderPage } from './shared';

export const dashboardRoutes = new Hono<AppBindings>();

dashboardRoutes.use('*', requireUserPage, sameOriginWrites);

function shell(c: AppContext, current: string, title: string, children: Child, opts: { actions?: Child; status?: number } = {}) {
  const user = c.get('user')!;
  return renderPage(
    c,
    { title, path: current, noindex: true, markdownPath: null, variant: 'app' },
    <DashShell user={user} current={current} title={title} actions={opts.actions}>
      {children}
    </DashShell>,
    opts.status,
  );
}

dashboardRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const [quota, lib, recent, month, keyCount] = await Promise.all([
    quotaState(c.env, user.id, user.plan),
    librarySummary(c.env, user.id),
    listDocuments(c.env, user.id, { limit: 6 }),
    c.env.DB.prepare("SELECT COUNT(*) AS conversions, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors FROM usage_events WHERE user_id = ? AND kind = 'convert' AND created_at >= ?")
      .bind(user.id, monthStart())
      .first<{ conversions: number; errors: number | null }>(),
    activeKeyCount(c.env, user.id),
  ]);
  return shell(
    c,
    '/dashboard',
    `Hi, ${user.name?.split(' ')[0] || 'there'}`,
    <OverviewPage user={user} quota={quota} docs={lib.docs} words={lib.words} recent={recent} month={{ conversions: month?.conversions ?? 0, errors: month?.errors ?? 0 }} keyCount={keyCount} origin={originOf(c)} />,
  );
});

dashboardRoutes.get('/library', async (c) => {
  const user = c.get('user')!;
  const domain = c.req.query('domain') || undefined;
  const kind = c.req.query('kind') || undefined;
  const limit = 30;
  const [lib, docs] = await Promise.all([librarySummary(c.env, user.id), listDocuments(c.env, user.id, { limit, domain, kind, before: Number(c.req.query('before')) || undefined })]);
  return shell(
    c,
    '/dashboard/library',
    'Library',
    <LibraryPage docs={docs} domains={lib.domains} kinds={lib.kinds} filter={{ domain, kind }} nextCursor={docs.length === limit ? docs[docs.length - 1].created_at : null} total={lib.docs} />,
  );
});

dashboardRoutes.get('/library/:id', async (c) => {
  const user = c.get('user')!;
  const doc = await getDocument(c.env, user.id, c.req.param('id'));
  if (!doc) return renderMessage(c, 404, 'Document not found', 'It may have been deleted.', <a class="btn btn-dark" href="/dashboard/library">Back to library</a>);
  // Converted pages are third-party content: render untrusted (raw HTML stripped).
  const { html } = renderMarkdown(doc.markdown, { trusted: false });
  return shell(c, '/dashboard/library', doc.title || doc.url, <DocumentPage doc={doc} html={html} origin={originOf(c)} />);
});

dashboardRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const mode = parseMode(c.req.query('mode'));
  const fanout = c.req.query('fanout') === '1';
  const decide = c.req.query('decide') === '1';
  let result = null;
  let error: string | undefined;
  if (q) {
    try {
      const res = await searchForPrincipal(c.env, c.get('principal'), 'web', q, { mode, limit: 20, fanout, decide });
      result = res;
      if (res.gated.length) error = `${res.gated.map((g) => (g === 'fanout' ? 'Query fan-out' : 'Jev tie-break')).join(' and ')} ${res.gated.length > 1 ? 'are' : 'is'} a Pro feature — results below use standard ranking.`;
    } catch (e) {
      console.error('dashboard search', e);
      error = 'Search failed. Try a simpler query or another mode.';
    }
  }
  return shell(c, '/dashboard/search', 'Search', <SearchPage q={q} mode={mode} fanout={fanout} decide={decide} result={result} error={error} />);
});

dashboardRoutes.get('/usage', async (c) => {
  const user = c.get('user')!;
  const s = await usageSummary(c.env, user.id, user.plan, 30);
  return shell(c, '/dashboard/usage', 'Usage logs', <UsagePage quota={s.quota} daily={s.daily} events={s.events} byChannel={s.by_channel} />);
});

dashboardRoutes.get('/traces', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id,kind,target,status,duration_ms,spans,meta,created_at FROM traces WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(c.get('user')!.id).all<TraceRow>();
  return shell(c, '/dashboard/traces', 'Traces', <TracesPage traces={results} />);
});

dashboardRoutes.get('/traces/:id', async (c) => {
  const trace = await c.env.DB.prepare('SELECT id,kind,target,status,duration_ms,spans,meta,created_at FROM traces WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user')!.id).first<TraceRow>();
  if (!trace) return renderMessage(c, 404, 'Trace not found', 'Traces are kept for 30 days.', <a class="btn btn-dark" href="/dashboard/traces">All traces</a>);
  return shell(c, '/dashboard/traces', `Trace ${trace.id}`, <TraceDetailPage trace={trace} />);
});

// ─── API keys & connected apps ─────────────────────────────────────────────

async function keysPage(c: AppContext, extra: { newKey?: string; error?: string } = {}, status = 200) {
  const user = c.get('user')!;
  const [{ results }, grants] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC').bind(user.id).all<ApiKeyRow>(),
    grantsOf(c.env, user.id),
  ]);
  c.header('Cache-Control', 'no-store');
  return shell(c, '/dashboard/keys', 'API keys', <KeysPage keys={results} grants={grants} role={c.get('principal').role} newKey={extra.newKey} error={extra.error} />, { status });
}

dashboardRoutes.get('/keys', (c) => keysPage(c));

// Key and grant changes go through the credentials service, which caps scopes, enforces the key limit and audits.
dashboardRoutes.post('/keys', async (c) => {
  markVia(c, 'web');
  const f = await formData(c);
  const name = (f.name ?? '').trim();
  if (!name) return keysPage(c, { error: 'Give the key a name so you can recognise it later.' }, 400);
  try {
    const { key } = await createOwnKey(c.env, c.get('principal'), { name, preset: f.preset || 'convert-only', expiresInDays: Number(f.expires_in_days) || undefined });
    // The secret is shown exactly once, on this response.
    return keysPage(c, { newKey: key }, 201);
  } catch (err) {
    if (!(err instanceof AdminError)) throw err;
    const message = err.code === 'key_limit' ? 'Free accounts can have 2 active keys. Revoke one or upgrade to Pro.' : err.message;
    return keysPage(c, { error: message }, err.status);
  }
});

dashboardRoutes.post('/keys/:id/revoke', async (c) => {
  markVia(c, 'web');
  await revokeOwnKey(c.env, c.get('principal'), c.req.param('id')).catch((err) => {
    if (!(err instanceof AdminError)) throw err;
  });
  return c.redirect('/dashboard/keys');
});

dashboardRoutes.post('/grants/:id/revoke', async (c) => {
  markVia(c, 'web');
  await revokeOwnGrant(c.env, c.get('principal'), c.req.param('id')).catch((err) => {
    if (!(err instanceof AdminError)) console.error('grant revoke', err instanceof Error ? err.message : err);
  });
  return c.redirect('/dashboard/keys');
});

// ─── Billing ────────────────────────────────────────────────────────────────

async function billingPage(c: AppContext, extra: { notice?: string; error?: string } = {}, status = 200) {
  const user = c.get('user')!;
  const [quota, subscription] = await Promise.all([
    quotaState(c.env, user.id, user.plan),
    c.env.DB.prepare("SELECT status,billing_interval,current_period_end,cancel_at_period_end FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1")
      .bind(user.id)
      .first<{ status: string; billing_interval: string; current_period_end: number | null; cancel_at_period_end: number }>(),
  ]);
  const notice = extra.notice ?? (c.req.query('checkout') === 'success' ? 'Payment received — your plan updates within a few seconds. Refresh if it still shows the old plan.' : undefined);
  return shell(c, '/dashboard/billing', 'Billing', <BillingPage user={user} quota={quota} enabled={billingEnabled(c.env)} provider={providerName(c.env)} subscription={subscription} notice={notice} error={extra.error} chosen={{ plan: c.req.query('plan'), interval: c.req.query('interval') }} />, { status });
}

dashboardRoutes.get('/billing', (c) => billingPage(c));

dashboardRoutes.post('/billing/checkout', async (c) => {
  const f = await formData(c);
  const plan = f.plan === 'scale' ? 'scale' : f.plan === 'pro' ? 'pro' : null;
  if (!plan) return billingPage(c, { error: 'Pick a plan.' }, 400);
  if (!billingEnabled(c.env)) return billingPage(c, { error: 'Billing is not available on this environment yet.' }, 503);
  try {
    const url = await createCheckout(c.env, c.get('user')!, plan as PlanId, f.interval === 'year' ? 'year' : 'month');
    return c.redirect(url, 303);
  } catch (e) {
    console.error('checkout', e);
    return billingPage(c, { error: 'Could not start checkout. Try again in a minute, or email hello@digitop.ai.' }, 502);
  }
});

dashboardRoutes.post('/billing/portal', async (c) => {
  if (!billingEnabled(c.env)) return billingPage(c, { error: 'Billing is not available on this environment yet.' }, 503);
  try {
    return c.redirect(await customerPortalUrl(c.env, c.get('user')!.id), 303);
  } catch (e) {
    console.error('portal', e);
    return billingPage(c, { error: 'No billing account yet — subscribe to a plan first.' }, 400);
  }
});

// ─── Account: export & delete ───────────────────────────────────────────────

async function accountPage(c: AppContext, error?: string, status = 200) {
  const user = c.get('user')!;
  const lib = await librarySummary(c.env, user.id);
  return shell(c, '/dashboard/account', 'Account', <AccountPage user={user} docs={lib.docs} error={error} />, { status });
}

dashboardRoutes.get('/account', (c) => accountPage(c));

dashboardRoutes.get('/account/export', async (c) => {
  const user = c.get('user')!;
  const docs = await exportDocuments(c.env, user.id);
  const stamp = new Date().toISOString().slice(0, 10);
  c.header('Cache-Control', 'no-store');
  if (c.req.query('format') === 'json') {
    const body = { exported_at: new Date().toISOString(), account: { id: user.id, email: user.email, name: user.name, plan: user.plan, created_at: user.created_at }, documents: docs.map((d) => ({ ...d, tags: d.tags.split(' ').filter(Boolean) })) };
    return c.body(JSON.stringify(body, null, 2), 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="anymd-library-${stamp}.json"` });
  }
  return c.body(documentsToMarkdown(docs), 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="anymd-library-${stamp}.md"` });
});

dashboardRoutes.post('/account/delete', async (c) => {
  const user = c.get('user')!;
  const f = await formData(c);
  if (user.role === 'owner') return accountPage(c, 'The owner account cannot be deleted.', 403);
  if ((f.confirm ?? '').trim().toLowerCase() !== user.email.toLowerCase()) return accountPage(c, 'The email you typed does not match your account.', 400);
  await deleteAccount(c.env, user.id);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/?account=deleted', 303);
});
