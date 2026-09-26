// Bundles the browser scripts in client/ into public/assets/js/ (served by the ASSETS binding).
import { build } from 'esbuild';

const entries = {
  site: 'client/site.ts',
  editor: 'client/editor.ts',
  'md-preview': 'client/md-preview.ts',
};

await build({
  entryPoints: entries,
  outdir: 'public/assets/js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
