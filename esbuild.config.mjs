import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/bundle.cjs',
  banner: { js: '#!/usr/bin/env node' },
  external: [],
  minify: false,
  sourcemap: true,
  define: {
    __CVA_VERSION__: JSON.stringify(pkg.version),
  },
});

console.log('Built dist/bundle.cjs');
