/** Sign-in, sign-up, password reset and the OAuth consent screen. */
import type { Child } from 'hono/jsx';
import { ROLE_TEMPLATES } from '../auth/roles';
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
              Every page you convert becomes <span class="text-accent">memory</span> your agents can search.
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

export function LoginPage({ next, error, notice, email }: { next: string; error?: string; notice?: string; email?: string }) {
  return (
    <AuthShell title="Welcome back" lead="Log in to your library, keys and usage.">
      <Alert error={error} notice={notice} />
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

export function SignupPage({ next, error, email, name, plan, interval }: { next: string; error?: string; email?: string; name?: string; plan?: string; interval?: string }) {
  return (
    <AuthShell title="Create your account" lead="500 free credits a month. No card required.">
      <Alert error={error} />
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

const SCOPE_LABELS: Record<string, string> = {
  convert: 'Convert URLs to Markdown (uses your credits)',
  'library:read': 'Read and search your library',
  'library:write': 'Save and delete library documents',
  'usage:read': 'Read usage and traces',
  'keys:manage': 'Manage API keys',
  'content:read': 'Read blog posts',
  'content:write': 'Write blog posts',
  'content:publish': 'Publish blog posts',
  'pages:read': 'Read landing pages',
  'pages:write': 'Edit landing pages',
  'pages:publish': 'Publish landing pages',
  'settings:write': 'Change site settings',
  'users:read': 'Read users',
  'users:write': 'Change user roles',
};

export function ConsentPage({ clientName, clientUri, scopes, state, userEmail, role }: { clientName: string; clientUri?: string; scopes: Scope[]; state: string; userEmail: string; role: string }) {
  return (
    <AuthShell title={`Connect ${clientName}`} lead="An MCP client wants to use anymd on your behalf." aside={false}>
      <div class="card p-5">
        <p class="text-sm text-muted">
          Signed in as <strong class="text-ink">{userEmail}</strong> ({ROLE_TEMPLATES[role as keyof typeof ROLE_TEMPLATES]?.label ?? role})
        </p>
        {clientUri ? <p class="mt-1 truncate text-xs text-muted">{clientUri}</p> : null}
        <p class="mt-4 text-sm font-semibold">It will be able to:</p>
        <ul class="mt-2 space-y-2 text-sm">
          {scopes.map((s) => (
            <li class="flex gap-2">
              <Icon name="check" size={16} class="mt-0.5 shrink-0 text-accent-ink" stroke={2.4} /> {SCOPE_LABELS[s] ?? s}
            </li>
          ))}
        </ul>
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
