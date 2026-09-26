import { defineConfig } from 'vitest/config';

// Worker-side unit tests only; the CLI package runs its own suite with `node --test`.
export default defineConfig({
  // Wrangler bundles Markdown as text (see `rules` in wrangler.jsonc); mirror that here.
  plugins: [{ name: 'md-as-text', transform: (code, id) => (id.endsWith('.md') ? { code: `export default ${JSON.stringify(code)};`, map: null } : null) }],
  resolve: { alias: { 'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
