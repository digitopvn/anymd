# DESIGN.md

Visual language for anymd.cc. The tokens live in [`src/styles/app.css`](src/styles/app.css) (Tailwind v4 `@theme`); this file explains how to use them. When the two disagree, the CSS wins. Fix this file.

## Principles

1. **Content first, chrome last.** The product strips pages down to what matters; the site should feel the same. Generous whitespace, one idea per section, no decorative clutter.
2. **Markdown is the hero.** Show real Markdown output (dark code panels, `#` eyebrows, mono accents) instead of abstract illustrations.
3. **Fast and honest.** Motion supports reading order, never blocks it. Every claim on the page is backed by something the product actually does.
4. **Same system everywhere.** Marketing, docs, dashboard, admin and builder pages share tokens and components. Page-builder blocks render with the same classes as hand-written pages.

## Color

| Token | Value | Use |
| --- | --- | --- |
| `paper` / `paper-2` | `#f5f7f4` / `#eaefea` | Page background, subtle fills, inline code |
| `card` | `#ffffff` | Cards, inputs |
| `ink` / `ink-2` | `#10161a` / `#263037` | Headings / body text |
| `muted` | `#5d6b70` | Secondary text (meets 4.5:1 on paper) |
| `line` | `#dde5df` | Borders, dividers, table rules |
| `accent` | `#05c977` | Brand green: primary buttons, focus rings, carets |
| `accent-ink` | `#067a4e` | Green **text** on light backgrounds (links, eyebrows); `accent` itself is too light for text |
| `accent-2` | `#02b9a3` | Second stop of the brand gradient |
| `accent-soft` | `#e4f9ef` | Accent chips, highlighted rows |
| `night` / `night-2` / `night-3` | `#0b1013` / `#141c20` / `#23303a` | Dark sections, code panels, terminal mockups |
| `coral`, `violet`, `sky`, `gold`, `mint` | | Source-type badges, charts, the ecosystem grid. Never for body text or primary actions |

Brand gradient: `135deg, #07ce6e → #01b9a3` (`.bg-brand`, `.btn-primary`, `.text-brand`). Text on the gradient is `ink`, not white.

Status colours are tokens too, never raw hex: `danger` / `danger-soft` / `danger-line`, `info-*`, `warn-*`, `violet-soft` / `violet-line`, `mint-soft` / `mint-ink` / `mint-line`, `ok-line`. Use `bg-card`, not `bg-white`.

### Dark theme

The header icon cycles **System → Light → Dark**. The choice is saved in `localStorage` (`anymd:theme`); an inline head script applies it as `html[data-theme]` before first paint, and without a saved choice `prefers-color-scheme` decides. Dark values for every token above live in `src/styles/app.css`. The rules that keep it working:

- `night*` surfaces (code panels, terminals, the offer bar, founder card) stay dark in both themes. Use `bg-night`, not `bg-ink`, for a panel that must stay dark.
- `bg-ink` means "inverted", for selected chips and tabs or `.btn-dark`. Pair it with `text-paper`, never `text-white`, so it flips with the theme.
- `.bg-brand`, `.bg-accent`, `.btn-primary` and `.btn-light` stay light-toned and reset the text tokens to their light values, so `text-ink` and `text-muted` inside them stay readable. Hover states that turn green use `text-night`.

## Typography

- **Display:** Bricolage Grotesque (h1–h3, `.font-display`), tight tracking `-0.025em`, weight 800 for section titles.
- **Body:** Inter with `cv11`/`ss01`.
- **Mono:** JetBrains Mono for code, eyebrows, Markdown output and numbers in tables.
- Scale: section titles `clamp(30px, 4.6vw, 52px)`; leads `clamp(16px, 1.6vw, 19px)` at 1.6 line height; long-form prose 17px / 1.75 (`.prose-md`).
- Inputs are at least 16px so iOS never zooms on focus.

## Layout and spacing

- Content width: `.container-x`, max 1200px, 20px gutters (32px from 768px).
- Sections: `.section`, 72px vertical rhythm (112px from 768px).
- Breakpoints follow Tailwind (`sm` 640, `md` 768, `lg` 1024, `xl` 1280). Verify every page at **375, 768 and 1440** wide. No horizontal page scroll at any width. Wide tables and code scroll inside `.scroll-x`.
- Dashboard: sidebar nav (`.dash-nav`) from `lg`, horizontal scrolling tab row below it.

## Components

| Class | Notes |
| --- | --- |
| `.btn` + `.btn-primary` / `.btn-dark` / `.btn-ghost` / `.btn-light`, `.btn-sm` | 44px minimum touch target (36px for `.btn-sm` in dense UI only). One primary button per view |
| `.card`, `.card-night` | 18px radius, soft two-layer shadow |
| `.chip`, `.chip-accent`, `.chip-mint` | Status, plan and tag labels |
| `.eyebrow` | Mono uppercase label prefixed with a green `#`, which echoes a Markdown heading |
| `.input`, `.label` | 46px tall, green focus ring |
| `.table` | Uppercase muted headers, row rules, wrapped in `.scroll-x` on small screens |
| `.tab[aria-selected]` | Dark code-tab switcher |
| `.toast` | Bottom-centered confirmation ("Copied") |
| `.prose-md` | Rendered Markdown for blog, docs, legal and library previews |
| `.md-output` + `.tk-*` | Syntax-tinted Markdown in dark panels |
| `.hl`, `.md-mark`, `.caret`, `.grid-bg` | Marketing accents: highlighter underline, `#`/`**` marks, blinking caret, faded grid |

Icons come from the inline SVG set in [`src/views/components/icons.tsx`](src/views/components/icons.tsx) (24px grid, 1.8 stroke, `currentColor`). Don't add an icon font.

## Motion

- Scroll reveal: `.reveal` elements are hidden only under `html.js` (set by an inline head script) and fade in when the client script adds `.is-in` via IntersectionObserver (0.7s, `cubic-bezier(.2,.7,.2,1)`, staggered with `.reveal-d1..3`). Without JS, content stays visible.
- Ambient loops (`marquee`, `float`, `pulse-ring`, rotating founder quotes) stay slow and small.
- `prefers-reduced-motion: reduce` disables animations and shows reveals immediately. Keep it that way for anything new.

## Brand assets

- Logo: `public/logo/anymd-logo.png` (wordmark), `public/logo/anymd-mark.png` (square mark); favicons and PWA icons in `public/`.
- Ecosystem logos: `public/brand/`. Keep them monochrome-friendly and the same visual height.
- Founder avatar: `https://cdn.zuey.me/avatar.png`. Media uploads go to R2 and are served from `cdn.anymd.cc`.
- Social card: `public/og/share.jpg` (1200×630, mozjpeg ~100 KB), resized from the source artwork `public/og/share.png`, which is excluded from deploys by `public/.assetsignore`. Pages can override it with their own image.

## Accessibility checklist

- Check text contrast in both themes (light and dark).
- Visible `:focus-visible` ring on every interactive element; no `outline: none` without a replacement.
- Text contrast of at least 4.5:1. Use `accent-ink`, not `accent`, for green text on light surfaces.
- Buttons are `<button>`, navigation is `<a>`. Icon-only controls carry `aria-label`.
- Forms have labels. Errors are shown in text, not by color alone.
- The page builder editor works with keyboard (move up/down controls) as well as drag and touch.
