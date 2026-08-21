// Bundle universel de l'agent : un seul fichier CJS, sans module natif, exécuté par le runtime Node embarqué.
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'dist/agent.js',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});

// Le package est ESM (`"type": "module"`) : on force l'interprétation CJS du bundle dans dist/.
await writeFile('dist/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
