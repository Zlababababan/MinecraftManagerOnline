#!/usr/bin/env node
/**
 * Smoke test d'une release (CI) : pour chaque archive de `<out>/<version>/` (ou seulement celle de la
 * plateforme courante avec `--host`), extraction avec notre lecteur, vérification sha256/taille du
 * manifeste, présence des fichiers attendus ; sur la plateforme courante, exécution réelle de
 * `runtime/<v>/node launcher.cjs --version` (doit imprimer la version de l'agent).
 *   node tools/release/smoke.mjs [--out release] [--host]
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
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
      for (const e of entries) {
        const p = path.join(tmp, e.name);
        if (e.type === 'dir') {
          mkdirSync(p, { recursive: true });
          continue;
        }
        if (e.type !== 'file') continue;
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, e.data);
        if (process.platform !== 'win32') chmodSync(p, e.mode);
      }
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
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
if (failures > 0) {
  console.error(`${failures} échec(s)`);
  process.exit(1);
}
console.log('smoke OK');
