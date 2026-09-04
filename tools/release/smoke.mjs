#!/usr/bin/env node
/**
 * Smoke test d'une release (CI) : pour chaque archive de `<out>/<version>/` (ou seulement celle de la
 * plateforme courante avec `--host`), extraction avec notre lecteur, vérification sha256/taille du
 * manifeste, présence des fichiers attendus ; sur la plateforme courante, exécution réelle de
 * `runtime/<v>/node launcher.cjs --version` (doit imprimer la version de l'agent).
 * `--panel` vérifie EN PLUS l'archive du panel de la plateforme courante : empreinte, contenu
 * (dont les migrations Drizzle), puis **démarrage réel** du panel avec son runtime embarqué et
 * attente de `GET /api/health`. C'est le garde-fou qui manquait : ni la CI ni le smoke ne
 * construisaient l'archive du panel, ce qui a laissé sortir les archives Linux cassées 1.0.2,
 * 1.0.3 et deux 1.0.4.
 *   node tools/release/smoke.mjs [--out release] [--host] [--panel]
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { readArchive } from './archive.mjs';
import { NODE_VERSION, PLATFORMS, ROOT, hostPlatform } from './constants.mjs';
import { sha256 } from './download.mjs';

const args = process.argv.slice(2);
const outRoot = path.resolve(
  ROOT,
  args.includes('--out') ? args[args.indexOf('--out') + 1] : 'release',
);
const versions = readdirSync(outRoot).sort();
const version = versions[versions.length - 1];
if (!version) throw new Error(`aucune release dans ${outRoot}`);
const dir = path.join(outRoot, version);
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const host = hostPlatform();
const targets = args.includes('--host') ? [host].filter(Boolean) : Object.keys(manifest.platforms);
let failures = 0;

function check(cond, message) {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${message}`);
  } else console.log(`  ✓ ${message}`);
}

/** Extrait les entrées d'une archive lue par `readArchive` dans un dossier. */
function extract(entries, root) {
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.type === 'dir') {
      mkdirSync(p, { recursive: true });
      continue;
    }
    if (e.type !== 'file') continue;
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, e.data);
    if (process.platform !== 'win32') chmodSync(p, e.mode);
  }
}

/** Port libre : on laisse l'OS en choisir un et on le rend aussitôt. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bundle = readFileSync(path.join(dir, manifest.bundle.file));
console.log(`bundle ${manifest.bundle.file}`);
check(
  sha256(bundle) === manifest.bundle.sha256 && bundle.length === manifest.bundle.size,
  'sha256 + taille',
);

for (const platform of targets) {
  const spec = PLATFORMS[platform];
  const art = manifest.platforms[platform];
  console.log(`${platform} → ${art.file}`);
  const data = readFileSync(path.join(dir, art.file));
  check(sha256(data) === art.sha256 && data.length === art.size, 'sha256 + taille du manifeste');
  const entries = readArchive(art.file, data);
  const names = new Set(entries.map((e) => e.name));
  const expected = [
    'mmo-agent/launcher.cjs',
    `mmo-agent/versions/${version}/agent.js`,
    'mmo-agent/current.json',
    'mmo-agent/runtime-current.json',
    `mmo-agent/runtime/${NODE_VERSION}/${spec.nodeBinary}`,
    'mmo-agent/install.sh',
    'mmo-agent/install.ps1',
    'mmo-agent/manifest.json',
  ];
  if (platform === 'win-x64') expected.push('mmo-agent/shawl.exe');
  for (const n of expected) check(names.has(n), n);
  const agent = entries.find((e) => e.name === `mmo-agent/versions/${version}/agent.js`);
  check(agent && sha256(agent.data) === manifest.bundle.sha256, 'bundle embarqué = bundle signé');
  const node = entries.find(
    (e) => e.name === `mmo-agent/runtime/${NODE_VERSION}/${spec.nodeBinary}`,
  );
  check(node && (node.mode & 0o111) !== 0, 'runtime exécutable (mode)');

  if (platform === host) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mmo-smoke-'));
    try {
      extract(entries, tmp);
      const nodeBin = path.join(tmp, `mmo-agent/runtime/${NODE_VERSION}/${spec.nodeBinary}`);
      const out = execFileSync(nodeBin, [path.join(tmp, 'mmo-agent/launcher.cjs'), '--version'], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      check(
        out.includes(`agent ${version}`) && out.includes(`v${NODE_VERSION}`),
        `launcher --version : ${out.trim()}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
  }
}
// --- Archive du panel (`--panel`) --------------------------------------------------------------
if (args.includes('--panel')) {
  const spec = PLATFORMS[host];
  const manifestFile = path.join(dir, `panel-${host}.json`);
  console.log(`panel ${host}`);
  if (!existsSync(manifestFile)) {
    check(false, `panel-${host}.json présent (produit par build.mjs --panel)`);
  } else {
    const pm = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const data = readFileSync(path.join(dir, pm.file));
    check(sha256(data) === pm.sha256 && data.length === pm.size, 'sha256 + taille du manifeste');
    const entries = readArchive(pm.file, data);
    const names = new Set(entries.map((e) => e.name));
    const wrapper = host === 'win-x64' ? 'mmo-panel/mmo-panel.cmd' : 'mmo-panel/mmo-panel.sh';
    for (const n of [
      'mmo-panel/app/dist/main.js',
      'mmo-panel/app/package.json',
      'mmo-panel/web/index.html',
      `mmo-panel/runtime/${NODE_VERSION}/${spec.nodeBinary}`,
      'mmo-panel/dist-agent/manifest.json',
      wrapper,
    ]) {
      check(names.has(n), n);
    }
    // Les migrations voyagent avec le code : une archive sans elles démarre puis échoue au
    // premier schéma manquant (oubli réel lors d'un déploiement à la main, session 5).
    check(
      entries.some(
        (e) => e.name.startsWith('mmo-panel/app/drizzle/mmo/') && e.name.endsWith('.sql'),
      ),
      'migrations Drizzle mmo embarquées',
    );

    // Démarrage RÉEL avec le runtime embarqué : c'est le seul contrôle qui aurait arrêté les
    // archives Linux dont le module natif ne se chargeait pas.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mmo-smoke-panel-'));
    let child;
    try {
      extract(entries, tmp);
      const root = path.join(tmp, 'mmo-panel');
      const nodeBin = path.join(root, 'runtime', NODE_VERSION, spec.nodeBinary);
      const port = await freePort();
      const log = [];
      child = spawn(nodeBin, [path.join(root, 'app', 'dist', 'main.js')], {
        cwd: root,
        env: {
          ...process.env,
          MMO_DATA_DIR: path.join(root, 'data'),
          MMO_WEB_DIR: path.join(root, 'web'),
          MMO_DIST_DIR: path.join(root, 'dist-agent'),
          MMO_HOST: '127.0.0.1',
          MMO_PORT: String(port),
        },
      });
      child.stdout.on('data', (d) => log.push(d.toString()));
      child.stderr.on('data', (d) => log.push(d.toString()));
      let health;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
          if (res.ok) {
            health = await res.json();
            break;
          }
        } catch {
          /* pas encore à l'écoute */
        }
        await sleep(250);
      }
      if (!health) {
        check(
          false,
          `panel démarré et /api/health atteignable
${log.join('').slice(-4000)}`,
        );
      } else {
        check(true, `panel démarré, /api/health répond`);
        check(health.version === version, `version annoncée ${health.version} = ${version}`);
        check(
          health.sqlite?.driver === 'node:sqlite',
          `driver SQLite : ${health.sqlite?.driver ?? 'absent'}`,
        );
        // La base a réellement été créée et migrée dans le dossier de données.
        check(existsSync(path.join(root, 'data', 'mmo.db')), 'mmo.db créée et migrée');
      }
    } finally {
      child?.kill();
      // Windows garde la main sur `mmo.db` quelques instants après la mort du processus : un
      // `rmSync` immédiat échoue en EPERM et ferait échouer un smoke dont TOUTES les
      // vérifications sont pourtant passées. On attend la sortie, puis on réessaie.
      if (child !== undefined && child.exitCode === null) {
        await new Promise((resolve) => {
          const done = () => {
            resolve(undefined);
          };
          child.once('exit', done);
          setTimeout(done, 5_000).unref?.();
        });
      }
      rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
  }
}

if (failures > 0) {
  console.error(`${failures} échec(s)`);
  process.exit(1);
}
console.log('smoke OK');
