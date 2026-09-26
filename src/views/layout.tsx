import type { Child } from 'hono/jsx';
import { NAV, SITE } from '../content/site';
import { Icon, Logo } from './components/icons';
import { BrandLink } from './components/marketing';

const THEME_BOOT = "(function(d){d.classList.add('js');try{var t=JSON.parse(localStorage.getItem('anymd:theme'));if(t==='light'||t==='dark')d.dataset.theme=t}catch(e){}})(document.documentElement)";

/** Cycles System → Light → Dark. The visible icon follows `html[data-theme]` in CSS, so it is right before JS runs. */
function ThemeToggle() {
  return (
    <button type="button" class="btn btn-ghost btn-sm !px-2.5" data-theme-toggle aria-label="Color theme: System" title="Color theme: System">
      <Icon name="monitor" size={18} class="theme-icon-system" />
      <Icon name="sun" size={18} class="theme-icon-light" />
      <Icon name="moon" size={18} class="theme-icon-dark" />
    </button>
  );
}

export interface PageMeta {
  title: string;
  description?: string;
  /** Canonical path, e.g. "/pricing". */
  path: string;
  /** Path of the Markdown twin; defaults to `${path}.md` (or "/index.md" for "/"). Pass null for none. */
  markdownPath?: string | null;
  image?: string;
  type?: 'website' | 'article';
  jsonLd?: Record<string, unknown>[];
  noindex?: boolean;
  publishedAt?: string;
}

export interface LayoutProps extends PageMeta {
  children: Child;
  origin: string;
  user?: { name: string; email: string; role: string } | null;
  variant?: 'default' | 'landing' | 'app' | 'bare';
  /** Show the floating "Markdown / Send to AI" actions. */
  pageActions?: boolean;
  scripts?: string[];
  /** Site-wide announcement from admin settings. */
  announcement?: { text: string; href?: string } | null;
}

function Announcement({ text, href }: { text: string; href?: string }) {
  const body = <span class="font-medium">{text}</span>;
  return (
    <div class="bg-accent-soft text-center text-[13px] text-ink sm:text-sm">
      <div class="container-x py-2">
        {href ? (
          <a href={href} class="underline decoration-accent underline-offset-4 hover:text-accent-ink">
            {body} →
          </a>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

export function markdownPathFor(path: string): string {
  return path === '/' ? '/index.md' : `${path.replace(/\/$/, '')}.md`;
}

export function Layout(props: LayoutProps) {
  const { origin, title, path } = props;
  const description = props.description || SITE.description;
  const canonical = origin + path;
  const image = props.image || `${origin}/og/share.jpg`;
  const mdPath = props.markdownPath === null ? null : props.markdownPath || markdownPathFor(path);
  const fullTitle = title.includes('anymd') ? title : `${title} · anymd`;
  const variant = props.variant ?? 'default';
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: SITE.owner,
      url: SITE.ownerUrl,
      email: SITE.email,
      logo: `${origin}/brand/digitop.png`,
      sameAs: [SITE.github, SITE.x],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'anymd',
      url: origin,
      potentialAction: { '@type': 'SearchAction', target: `${origin}/{search_term_string}`, 'query-input': 'required name=search_term_string' },
    },
    ...(props.jsonLd ?? []),
  ];

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{fullTitle}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        {props.noindex ? <meta name="robots" content="noindex, nofollow" /> : <meta name="robots" content="index, follow, max-image-preview:large" />}
        {mdPath ? <link rel="alternate" type="text/markdown" title="Markdown" href={origin + mdPath} /> : null}
        <link rel="alternate" type="text/plain" title="llms.txt" href={`${origin}/llms.txt`} />
        <meta name="theme-color" content="#f5f7f4" media="(prefers-color-scheme: light)" data-theme-color />
        <meta name="theme-color" content="#10171b" media="(prefers-color-scheme: dark)" data-theme-color />
        <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <meta property="og:site_name" content="anymd" />
        <meta property="og:type" content={props.type ?? 'website'} />
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={image} />
        {image.endsWith(".jpg") ? <meta property="og:image:type" content="image/jpeg" /> : null}
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content={title} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@goon_nguyen" />
        <meta name="twitter:title" content={fullTitle} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={image} />
        {props.publishedAt ? <meta property="article:published_time" content={props.publishedAt} /> : null}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap"
        />
        <link rel="stylesheet" href="/assets/app.css" />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
        {/* Runs before first paint: marks JS as available and applies the saved theme so there is no flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <script src="/assets/js/site.js" defer />
        {(props.scripts ?? []).map((s) => (
          <script src={s} defer />
        ))}
      </head>
      <body class={variant === 'app' ? 'bg-paper' : ''}>
        <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] btn btn-dark btn-sm">
          Skip to content
        </a>
        {props.announcement?.text && variant === 'default' ? <Announcement {...props.announcement} /> : null}
        {variant === 'default' || variant === 'landing' ? <Header user={props.user} landing={variant === 'landing'} /> : null}
        <main id="main">{props.children}</main>
        {variant === 'default' || variant === 'landing' ? <Footer /> : null}
        {props.pageActions && mdPath ? <PageActions mdUrl={origin + mdPath} pageUrl={canonical} title={title} /> : null}
        <CookieBadge />
        <div id="toast" class="toast" role="status" aria-live="polite" />
      </body>
    </html>
  );
}

function Header({ user, landing }: { user?: LayoutProps['user']; landing?: boolean }) {
  return (
    <header class="sticky top-0 z-50 border-b border-line/70 bg-paper/85 backdrop-blur-md" data-header>
      <div class="container-x flex h-16 items-center justify-between gap-4">
        <a href="/" class="shrink-0" aria-label="anymd home">
          <Logo />
        </a>
        {landing ? null : (
          <nav class="hidden lg:flex items-center gap-1 text-[15px] font-medium text-ink-2" aria-label="Main">
            {NAV.map((n) => (
              <a href={n.href} class="whitespace-nowrap rounded-lg px-2 py-2 hover:bg-paper-2 xl:px-3">
                {n.label}
              </a>
            ))}
          </nav>
        )}
        <div class="flex items-center gap-2">
          <ThemeToggle />
          <a href="https://github.com/digitopvn/anymd" class="hidden sm:inline-flex btn btn-ghost btn-sm" rel="noopener" aria-label="GitHub repository">
            <Icon name="github" size={16} />
            <span class="hidden md:inline lg:hidden xl:inline">Star</span>
          </a>
          {user ? (
            <a href="/dashboard" class="btn btn-dark btn-sm">
              Dashboard
            </a>
          ) : (
            <>
              <a href="/login" class="hidden sm:inline-flex btn btn-ghost btn-sm">
                Log in
              </a>
              <a href="/signup" class="btn btn-primary btn-sm">
                Get started
              </a>
            </>
          )}
          {landing ? null : (
            <details class="lg:hidden relative" data-menu>
              <summary class="list-none btn btn-ghost btn-sm !px-2.5 cursor-pointer" aria-label="Open menu">
                <Icon name="menu" size={20} />
              </summary>
              <div class="absolute right-0 top-12 w-[min(86vw,320px)] card p-2 shadow-pop">
                <nav class="flex flex-col" aria-label="Mobile">
                  {NAV.map((n) => (
                    <a href={n.href} class="rounded-lg px-3 py-3 font-medium hover:bg-paper-2">
                      {n.label}
                    </a>
                  ))}
                  <a href="https://github.com/digitopvn/anymd" class="rounded-lg px-3 py-3 font-medium hover:bg-paper-2">
                    GitHub
                  </a>
                  {user ? null : (
                    <a href="/login" class="rounded-lg px-3 py-3 font-medium hover:bg-paper-2">
                      Log in
                    </a>
                  )}
                </nav>
              </div>
            </details>
          )}
        </div>
      </div>
    </header>
  );
}

const FOOTER_COLUMNS: { title: string; links: [string, string][] }[] = [
  {
    title: 'Product',
    links: [
      ['/', 'Converter'],
      ['/pricing', 'Pricing'],
      ['/changelog', 'Changelog'],
      ['/dashboard', 'Dashboard'],
      ['/status.json', 'Status'],
    ],
  },
  {
    title: 'Developers',
    links: [
      ['/docs', 'Documentation'],
      ['/docs/api', 'API reference'],
      ['/docs/cli', 'CLI'],
      ['/docs/mcp', 'MCP server'],
      ['/docs/webmcp', 'WebMCP'],
      ['/llms.txt', 'llms.txt'],
    ],
  },
  {
    title: 'Company',
    links: [
      ['/blog', 'Blog'],
      ['/ecosystem', 'Ecosystem'],
      ['https://digitop.ai', 'Digitop.ai'],
      ['mailto:hello@digitop.ai', 'Contact'],
      ['https://github.com/digitopvn/anymd', 'GitHub'],
    ],
  },
  {
    title: 'Legal',
    links: [
      ['/legal/terms', 'Terms'],
      ['/legal/privacy', 'Privacy'],
      ['/legal/refund', 'Refunds'],
      ['/legal/cookies', 'Cookies'],
      ['/legal/gdpr', 'GDPR'],
      ['/legal/abuse', 'Site owners'],
    ],
  },
];

function Footer() {
  return (
    <footer class="bg-night text-[#c5d2d0]">
      <div class="container-x py-14 md:py-20">
        <div class="grid gap-10 md:grid-cols-[1.3fr_repeat(4,1fr)]">
          <div class="max-w-xs">
            <Logo dark class="text-white" />
            <p class="mt-4 text-sm leading-relaxed text-[#9aa9ae]">{SITE.tagline} Open source, MIT-licensed, running on Cloudflare’s edge.</p>
            <a href="https://digitop.ai" class="mt-6 inline-block opacity-90 hover:opacity-100" rel="noopener" aria-label="Digitop.ai">
              <img src="/brand/digitop.png" alt="Digitop.ai" width="160" height="28" loading="lazy" class="h-7 w-auto" />
            </a>
          </div>
          {FOOTER_COLUMNS.map((col) => (
            <div>
              <h2 class="font-mono text-xs uppercase tracking-widest text-[#7f9098]">{col.title}</h2>
              <ul class="mt-4 space-y-2.5 text-[15px]">
                {col.links.map(([href, label]) => (
                  <li>
                    <a href={href} class="hover:text-white">
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div class="mt-14 flex flex-col gap-3 border-t border-night-3 pt-6 text-sm text-[#7f9098] md:flex-row md:items-center md:justify-between">
          <p>
            © {new Date().getUTCFullYear()} <BrandLink to="owner" class="hover:text-accent-2" /> · Made in Vietnam for agents everywhere.
          </p>
          <p class="font-mono text-xs">
            Every page here has a Markdown twin — add <span class="text-accent-2">.md</span> to the URL.
          </p>
        </div>
      </div>
    </footer>
  );
}

function PageActions({ mdUrl, pageUrl, title }: { mdUrl: string; pageUrl: string; title: string }) {
  return (
    <div class="fixed bottom-4 right-4 z-40" data-page-actions data-md-url={mdUrl} data-page-url={pageUrl} data-title={title}>
      <details class="relative">
        <summary class="list-none btn btn-dark btn-sm shadow-pop cursor-pointer" aria-label="Markdown and AI actions">
          <span class="md-mark !text-accent-2">#</span> Markdown
          <Icon name="down" size={14} />
        </summary>
        <div class="absolute bottom-12 right-0 w-64 card p-1.5 shadow-pop text-[14px]">
          <button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-paper-2" data-action="copy-md">
            <Icon name="copy" size={16} /> Copy page as Markdown
          </button>
          <button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-paper-2" data-action="copy-md-url">
            <Icon name="code" size={16} /> Copy Markdown URL
          </button>
          <a class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-paper-2" href={mdUrl} target="_blank" rel="noopener">
            <Icon name="external" size={16} /> Open .md
          </a>
          <div class="my-1 border-t border-line" />
          <button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-paper-2" data-action="send" data-target="chatgpt">
            <Icon name="send" size={16} /> Send to ChatGPT
          </button>
          <button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-paper-2" data-action="send" data-target="claude">
            <Icon name="send" size={16} /> Send to Claude
          </button>
          <button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-paper-2" data-action="send" data-target="gemini">
            <Icon name="send" size={16} /> Send to Gemini
          </button>
        </div>
      </details>
    </div>
  );
}

function CookieBadge() {
  return (
    <div class="fixed bottom-4 left-4 z-40 hidden" data-cookie-badge>
      {/* Only an essential session cookie exists, so this is a notice with one dismiss action, kept small enough not to cover content on phones. */}
      <div class="card flex max-w-[min(calc(100vw-2rem),380px)] items-center gap-3 py-2.5 pl-3.5 pr-2.5 shadow-pop text-[13px] sm:text-sm">
        <Icon name="cookie" size={18} class="shrink-0 text-accent-ink" />
        <p class="leading-snug text-ink-2">
          One essential cookie keeps you signed in. No ads, no trackers.{' '}
          <a href="/legal/cookies" class="underline underline-offset-2">
            Details
          </a>
        </p>
        <button type="button" class="btn btn-dark btn-sm shrink-0" data-cookie="accept">
          OK
        </button>
      </div>
      <button type="button" class="hidden btn btn-ghost btn-sm !rounded-full !px-2.5 bg-card shadow-card" data-cookie="reopen" aria-label="Cookie settings">
        <Icon name="cookie" size={18} />
      </button>
    </div>
  );
}
