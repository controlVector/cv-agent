import { build } from 'esbuild';

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
});

console.log('Built dist/bundle.cjs');
