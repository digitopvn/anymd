/** Sign-in, sign-up, password reset and the OAuth consent screen. */
import type { Child } from 'hono/jsx';
import { ELEVATED_SCOPES, ROLE_TEMPLATES, SCOPE_LABELS } from '../auth/roles';
import { SSO_LABEL, type SsoProvider } from '../auth/sso';
import type { Scope } from '../env';
import { Icon, Logo } from './components/icons';
import { BrandLink } from './components/marketing';

function AuthShell({ title, lead, children, aside = true }: { title: string; lead?: string; children: Child; aside?: boolean }) {
  return (
    <div class="grid min-h-[100dvh] lg:grid-cols-2">
      <div class="flex flex-col px-5 py-8 sm:px-10">
        <a href="/" aria-label="anymd home" class="w-fit">
          <Logo />
        </a>
        <div class="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
          <h1 class="font-display text-[34px] font-extrabold leading-tight">{title}</h1>
          {lead ? <p class="mt-2 text-muted">{lead}</p> : null}
          <div class="mt-8">{children}</div>
        </div>
        <p class="text-center text-xs text-muted">
          <a href="/legal/terms" class="underline">
            Terms
          </a>{' '}
          ·{' '}
          <a href="/legal/privacy" class="underline">
            Privacy
          </a>{' '}
          · © <BrandLink to="owner" />
        </p>
      </div>
      {aside ? (
        <div class="relative hidden overflow-hidden bg-night p-12 text-white lg:flex lg:flex-col lg:justify-between">
          <div class="grid-bg pointer-events-none absolute inset-0 opacity-[0.06]" aria-hidden="true" />
          <img src="/logo/anymd-logo-512.webp" alt="" width="240" height="240" class="relative w-56 animate-float rounded-3xl bg-card/95 p-4" />
          <div class="relative">
            <p class="font-display text-[34px] font-extrabold leading-tight">
              Every source your agents read becomes <span class="text-accent">context</span> they can search.
            </p>
            <ul class="mt-6 space-y-2 text-[#c5d2d0]">
              {['500 free credits every month', 'BM25 + semantic + fan-out search', 'API, CLI, MCP and WebMCP'].map((t) => (
                <li class="flex items-center gap-2">
                  <Icon name="check" size={16} class="text-accent" stroke={2.4} /> {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Alert({ error, notice }: { error?: string; notice?: string }) {
  if (error) return <p class="mb-5 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">{error}</p>;
  if (notice) return <p class="mb-5 rounded-xl border border-ok-line bg-accent-soft px-4 py-3 text-sm text-accent-ink" role="status">{notice}</p>;
  return null;
}

/** Google's four-colour "G"; its brand rules ask for the mark in colour. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** "Continue with …" buttons plus an "or" divider. Renders nothing when no provider is configured. */
function SsoButtons({ providers, next }: { providers: SsoProvider[]; next: string }) {
  if (!providers.length) return null;
  const query = next && next !== '/dashboard' ? `?next=${encodeURIComponent(next)}` : '';
  return (
    <div>
      <div class="grid grid-cols-1 gap-3">
        {providers.map((p) => (
          <a href={`/api/auth/oauth/${p}${query}`} class="btn btn-ghost h-12 w-full gap-2.5" data-sso={p}>
            {p === 'google' ? <GoogleMark /> : <Icon name="github" size={18} />}
            Continue with {SSO_LABEL[p]}
          </a>
        ))}
      </div>
      <div class="my-6 flex items-center gap-3 text-xs font-medium uppercase tracking-wider text-muted" role="separator">
        <span class="h-px flex-1 bg-line" />
        or with email
        <span class="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}

export function LoginPage({ next, error, notice, email, providers = [] }: { next: string; error?: string; notice?: string; email?: string; providers?: SsoProvider[] }) {
  return (
    <AuthShell title="Welcome back" lead="Log in to your library, keys and usage.">
      <Alert error={error} notice={notice} />
      <SsoButtons providers={providers} next={next} />
      <form method="post" action="/login" class="space-y-4">
        <input type="hidden" name="next" value={next} />
        <div>
          <label class="label" for="email">
            Email
          </label>
          <input class="input" id="email" name="email" type="email" autocomplete="email" required value={email ?? ''} />
        </div>
        <div>
          <div class="flex items-center justify-between">
            <label class="label" for="password">
              Password
            </label>
            <a href="/forgot" class="mb-1.5 text-sm text-muted underline">
              Forgot?
            </a>
          </div>
          <input class="input" id="password" name="password" type="password" autocomplete="current-password" required minlength={8} />
        </div>
        <button class="btn btn-primary h-12 w-full" type="submit">
          Log in
        </button>
      </form>
      <p class="mt-6 text-center text-sm text-muted">
        New here?{' '}
        <a href={`/signup${next && next !== '/dashboard' ? `?next=${encodeURIComponent(next)}` : ''}`} class="font-semibold text-ink underline">
          Create a free account
        </a>
      </p>
    </AuthShell>
  );
}

export function SignupPage({ next, error, email, name, plan, interval, providers = [] }: { next: string; error?: string; email?: string; name?: string; plan?: string; interval?: string; providers?: SsoProvider[] }) {
  const paid = plan === 'pro' || plan === 'scale';
  const ssoNext = paid ? `/dashboard/billing?plan=${plan}&interval=${interval === 'year' ? 'year' : 'month'}` : next;
  return (
    <AuthShell title="Create your account" lead="500 free credits a month. No card required.">
      <Alert error={error} />
      {providers.length ? (
        <p class="mb-3 text-xs text-muted">
          By continuing with {providers.map((p) => SSO_LABEL[p]).join(' or ')}, you agree to the{' '}
          <a href="/legal/terms" class="underline" target="_blank">
            Terms
          </a>{' '}
          and{' '}
          <a href="/legal/privacy" class="underline" target="_blank">
            Privacy Policy
          </a>
          .
        </p>
      ) : null}
      <SsoButtons providers={providers} next={ssoNext} />
      <form method="post" action="/signup" class="space-y-4">
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="plan" value={plan ?? ''} />
        <input type="hidden" name="interval" value={interval === 'year' ? 'year' : 'month'} />
        <div>
          <label class="label" for="name">
            Name
          </label>
          <input class="input" id="name" name="name" autocomplete="name" maxlength={80} value={name ?? ''} />
        </div>
        <div>
          <label class="label" for="email">
            Email
          </label>
          <input class="input" id="email" name="email" type="email" autocomplete="email" required value={email ?? ''} />
        </div>
        <div>
          <label class="label" for="password">
            Password
          </label>
          <input class="input" id="password" name="password" type="password" autocomplete="new-password" required minlength={8} />
          <p class="mt-1.5 text-xs text-muted">At least 8 characters.</p>
        </div>
        <label class="flex items-start gap-2.5 text-sm text-muted">
          <input type="checkbox" name="terms" value="1" required class="mt-0.5 h-4 w-4 accent-[#05c977]" />
          <span>
            I agree to the{' '}
            <a href="/legal/terms" class="underline" target="_blank">
              Terms
            </a>{' '}
            and{' '}
            <a href="/legal/privacy" class="underline" target="_blank">
              Privacy Policy
            </a>
            .
          </span>
        </label>
        <button class="btn btn-primary h-12 w-full" type="submit">
          Create account
        </button>
      </form>
      <p class="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <a href="/login" class="font-semibold text-ink underline">
          Log in
        </a>
      </p>
    </AuthShell>
  );
}

export function ForgotPage({ notice, error }: { notice?: string; error?: string }) {
  return (
    <AuthShell title="Reset your password" lead="We’ll email you a link that works for one hour.">
      <Alert error={error} notice={notice} />
      <form method="post" action="/forgot" class="space-y-4">
        <div>
          <label class="label" for="email">
            Email
          </label>
          <input class="input" id="email" name="email" type="email" autocomplete="email" required />
        </div>
        <button class="btn btn-primary h-12 w-full" type="submit">
          Send reset link
        </button>
      </form>
      <p class="mt-6 text-center text-sm">
        <a href="/login" class="text-muted underline">
          Back to log in
        </a>
      </p>
    </AuthShell>
  );
}

export function ResetPage({ token, error }: { token: string; error?: string }) {
  return (
    <AuthShell title="Choose a new password">
      <Alert error={error} />
      <form method="post" action="/reset" class="space-y-4">
        <input type="hidden" name="token" value={token} />
        <div>
          <label class="label" for="password">
            New password
          </label>
          <input class="input" id="password" name="password" type="password" autocomplete="new-password" required minlength={8} />
        </div>
        <button class="btn btn-primary h-12 w-full" type="submit">
          Update password
        </button>
      </form>
    </AuthShell>
  );
}

export function ConsentPage({
  clientName,
  clientUri,
  scopes,
  unavailable = [],
  requestedNothing = false,
  state,
  userEmail,
  role,
}: {
  clientName: string;
  clientUri?: string;
  scopes: Scope[];
  unavailable?: string[];
  requestedNothing?: boolean;
  state: string;
  userEmail: string;
  role: string;
}) {
  const elevated = scopes.filter((s) => ELEVATED_SCOPES.has(s));
  const basic = scopes.filter((s) => !ELEVATED_SCOPES.has(s));
  return (
    <AuthShell title={`Connect ${clientName}`} lead="An MCP client wants to use anymd on your behalf." aside={false}>
      <div class="card p-5">
        <p class="text-sm text-muted">
          Signed in as <strong class="text-ink">{userEmail}</strong> ({ROLE_TEMPLATES[role as keyof typeof ROLE_TEMPLATES]?.label ?? role})
        </p>
        {clientUri ? <p class="mt-1 truncate text-xs text-muted">{clientUri}</p> : null}
        <p class="mt-4 text-sm font-semibold">It will be able to:</p>
        <ul class="mt-2 space-y-2 text-sm">
          {basic.map((s) => (
            <li class="flex gap-2">
              <Icon name="check" size={16} class="mt-0.5 shrink-0 text-accent-ink" stroke={2.4} /> {SCOPE_LABELS[s] ?? s}
            </li>
          ))}
        </ul>
        {elevated.length ? (
          <div class="mt-4 rounded-xl border border-warn-line bg-warn-soft p-3" data-elevated-scopes>
            <p class="text-sm font-semibold text-warn">Elevated access: other users' data or site-wide settings</p>
            <ul class="mt-2 space-y-2 text-sm text-warn">
              {elevated.map((s) => (
                <li class="flex gap-2">
                  <Icon name="shield" size={16} class="mt-0.5 shrink-0" stroke={2.4} /> {SCOPE_LABELS[s] ?? s} <code class="text-xs opacity-70">{s}</code>
                </li>
              ))}
            </ul>
            <p class="mt-2 text-xs text-warn">Only allow this for an agent you trust to administer anymd. Every change it makes is recorded in the audit log.</p>
          </div>
        ) : null}
        {requestedNothing ? <p class="mt-3 text-xs text-muted">The client did not ask for specific access, so it gets the basic set. It can ask for more later, and you will be asked again.</p> : null}
        {unavailable.length ? <p class="mt-3 text-xs text-muted">Not granted (your role does not include it): {unavailable.join(', ')}</p> : null}
      </div>
      <form method="post" action="/oauth/authorize" class="mt-6 flex gap-3">
        <input type="hidden" name="state" value={state} />
        <button name="decision" value="deny" class="btn btn-ghost h-12 flex-1" type="submit">
          Deny
        </button>
        <button name="decision" value="allow" class="btn btn-primary h-12 flex-1" type="submit">
          Allow
        </button>
      </form>
      <p class="mt-4 text-xs text-muted">You can revoke access anytime from Dashboard → API keys.</p>
    </AuthShell>
  );
}
