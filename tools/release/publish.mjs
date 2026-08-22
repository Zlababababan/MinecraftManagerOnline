#!/usr/bin/env node
/**
 * Publie une release dans un panel (doc 03 §3) :
 *   node tools/release/publish.mjs --panel https://panel --user admin [--password …] [--out release] [--version v]
 *   node tools/release/publish.mjs --dist-dir <dataDir>/dist [--out release]            (copie locale, panel arrêté ou non)
 *
 * Mode panel : connexion (`POST /api/auth/login`), dépôt des archives et du bundle
 * (`PUT /api/admin/dist/files/<fichier>`), puis du manifeste (`PUT /api/admin/dist/manifest`) — le panel
 * vérifie sha256/tailles et publie le bundle comme release d'agent (`agent.update`). Mot de passe :
 * `--password`, sinon `MMO_PANEL_PASSWORD`, sinon saisie masquée.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { ROOT } from './constants.mjs';

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}
const outRoot = path.resolve(ROOT, opt('out', 'release'));
const version = opt('version', readdirSync(outRoot).sort().at(-1));
if (!version) throw new Error(`aucune release dans ${outRoot}`);
const dir = path.join(outRoot, version);
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const files = [manifest.bundle.file, ...Object.values(manifest.platforms).map((p) => p.file)];

const distDir = opt('dist-dir');
if (distDir) {
  mkdirSync(distDir, { recursive: true });
  for (const f of [...files, 'manifest.json'])
    copyFileSync(path.join(dir, f), path.join(distDir, f));
  console.log(
    `[publish] ${version} copiée dans ${distDir} (${files.length} fichiers + manifest.json)`,
  );
  console.log(
    "[publish] note : la release d'agent (agent.update) est créée par le panel à la lecture du manifeste via l'API ; en copie locale, publiez aussi le bundle avec PUT /api/admin/agent-releases si besoin",
  );
  process.exit(0);
}

const panel = opt('panel')?.replace(/\/+$/, '');
const user = opt('user');
if (!panel || !user) {
  console.error(
    'usage: publish.mjs --panel <url> --user <admin> [--password …] | --dist-dir <dir>',
  );
  process.exit(2);
}
let password = opt('password', process.env.MMO_PANEL_PASSWORD);
if (password === undefined) password = await askHidden(`mot de passe de ${user} : `);

const login = await fetch(`${panel}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: user, password }),
});
if (!login.ok) throw new Error(`login : HTTP ${login.status} ${await login.text()}`);
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const headers = { cookie };

for (const f of files) {
  const data = readFileSync(path.join(dir, f));
  process.stdout.write(`[publish] ${f} (${(data.length / 1048576).toFixed(1)} Mo)… `);
  const res = await fetch(`${panel}/api/admin/dist/files/${f}`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    body: data,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  console.log('ok');
}
const res = await fetch(`${panel}/api/admin/dist/manifest`, {
  method: 'PUT',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(manifest),
});
if (!res.ok) throw new Error(`manifest : HTTP ${res.status} ${await res.text()}`);
const status = await res.json();
console.log(
  `[publish] ${status.version} publiée sur ${panel} — plateformes : ${Object.keys(status.platforms).join(', ')} ; release d'agent : ${status.releasePublished ? 'oui' : 'non'}`,
);
await fetch(`${panel}/api/auth/logout`, { method: 'POST', headers }).catch(() => undefined);

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const write = rl._writeToOutput;
    rl.question(prompt, (answer) => {
      rl._writeToOutput = write;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    rl._writeToOutput = () => undefined;
  });
}
