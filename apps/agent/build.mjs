// Bundle universel de l'agent : un seul fichier CJS, sans module natif, exécuté par le runtime Node embarqué.
import { build } from 'esbuild';
import { copyFile, writeFile } from 'node:fs/promises';

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

// Launcher figé (doc 03 §3) : copié tel quel à côté du bundle.
await copyFile('launcher/launcher.cjs', 'dist/launcher.cjs');

// Le package est ESM (`"type": "module"`) : on force l'interprétation CJS du bundle dans dist/.
await writeFile('dist/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
