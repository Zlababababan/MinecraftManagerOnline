#!/usr/bin/env node
/**
 * Construit les archives de distribution de l'agent (doc 03 §3) :
 *   node tools/release/build.mjs [--platforms win-x64,linux-x64,linux-arm64,darwin-arm64]
 *        [--out release] [--key <private.pem>] [--release] [--skip-build] [--panel]
 *
 * Produit `<out>/<version>/` :
 *   agent-<v>.js                          bundle universel (publié dans le panel, `agent.update`)
 *   mmo-agent-<v>-<plateforme>.zip|tar.gz archive d'installation = runtime Node épinglé + bundle + launcher
 *                                          + scripts install/uninstall (+ shawl sous Windows)
 *   manifest.json                         versions, sha256, tailles, signature Ed25519 du bundle
 *   mmo-panel-<v>-<hôte>.zip|tar.gz       (--panel) panel pour la plateforme de build : runtime + `pnpm deploy`
 *                                          (modules natifs de l'hôte) + front + dist-agent/ (les archives ci-dessus)
 *
 * Reproductible : runtime/shawl épinglés par sha256 (constants.mjs), entrées triées, horodatages fixes
 * (SOURCE_DATE_EPOCH ou 0). Signature : `--key` / `MMO_SIGNING_KEY` (clé du mainteneur, hors dépôt) ;
 * sans clé, la clé de développement est utilisée et `--release` refuse.
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readArchive, writeTarGz, writeZip } from './archive.mjs';
import { NODE_DIST, NODE_VERSION, PLATFORMS, ROOT, SHAWL, hostPlatform } from './constants.mjs';
import { download, sha256 } from './download.mjs';

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}
const platforms = opt('platforms', Object.keys(PLATFORMS).join(',')).split(',');
const outRoot = path.resolve(ROOT, opt('out', 'release'));
const isRelease = args.includes('--release');
const keyPath = opt('key', process.env.MMO_SIGNING_KEY);
const DEV_KEY = path.join(ROOT, 'tools/signing/dev.private.pem');
const mtime = Number(process.env.SOURCE_DATE_EPOCH ?? 0);

for (const p of platforms) {
  if (!(p in PLATFORMS)) {
    console.error(`plateforme inconnue : ${p} (connues : ${Object.keys(PLATFORMS).join(', ')})`);
    process.exit(2);
  }
}

// --- Versions et bundle ---------------------------------------------------------------------

function readConstant(file, name) {
  const m = readFileSync(path.join(ROOT, file), 'utf8').match(
    new RegExp(`${name}\\s*=\\s*['"]?([^'";]+)['"]?;`),
  );
  if (!m) throw new Error(`${name} introuvable dans ${file}`);
  return m[1];
}

const version = readConstant('apps/agent/src/agent.ts', 'AGENT_VERSION');
const panelVersion = readConstant('apps/panel/src/version.ts', 'PANEL_VERSION');
const withPanel = args.includes('--panel');
if (withPanel && panelVersion !== version) {
  console.error(
    `refus : PANEL_VERSION (${panelVersion}) ≠ AGENT_VERSION (${version}) — une release embarque l'agent de même version`,
  );
  process.exit(2);
}
const protocolVersion = Number(
  readConstant('packages/protocol/src/version.ts', 'PROTOCOL_VERSION'),
);

function pnpm(...argv) {
  execFileSync('pnpm', argv, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // --release : le bundle agent n'accepte que les clés de release (apps/agent/src/update/keys.ts).
    env: { ...process.env, MMO_RELEASE_BUILD: isRelease ? '1' : '' },
  });
}
if (!args.includes('--skip-build')) {
  console.log('[release] pnpm build');
  if (withPanel) pnpm('build');
  else pnpm('--filter', '@mmo/agent', 'build');
}
const agentDist = path.join(ROOT, 'apps/agent/dist');
const bundle = readFileSync(path.join(agentDist, 'agent.js'));
const launcher = readFileSync(path.join(agentDist, 'launcher.cjs'));
const installPs1 = readFileSync(path.join(ROOT, 'apps/panel/install/install.ps1'));
const installSh = readFileSync(path.join(ROOT, 'apps/panel/install/install.sh'));

// --- Signature ------------------------------------------------------------------------------

const usingDevKey = keyPath === undefined;
if (usingDevKey && isRelease) {
  console.error(
    'refus : --release exige la clé de signature du mainteneur (--key <pem> ou MMO_SIGNING_KEY), jamais la clé de développement',
  );
  process.exit(2);
}
const privateKey = createPrivateKey(readFileSync(keyPath ?? DEV_KEY));
const publicKeyB64 = createPublicKey(privateKey)
  .export({ type: 'spki', format: 'der' })
  .toString('base64');
const keysSource = readFileSync(path.join(ROOT, 'apps/agent/src/update/keys.ts'), 'utf8');
if (!keysSource.includes(publicKeyB64)) {
  console.error(
    `refus : la clé publique correspondante (${publicKeyB64}) n'est pas dans apps/agent/src/update/keys.ts — les agents rejetteraient cette release`,
  );
  process.exit(2);
}
if (usingDevKey) console.warn('[release] ATTENTION : signature avec la clé de DÉVELOPPEMENT');
const signature = sign(null, bundle, privateKey).toString('base64');

// --- Archives -------------------------------------------------------------------------------

const outDir = path.join(outRoot, version);
mkdirSync(outDir, { recursive: true });
const bundleName = `agent-${version}.js`;
writeFileSync(path.join(outDir, bundleName), bundle);

const manifest = {
  version,
  protocolVersion,
  runtimeVersion: NODE_VERSION,
  builtAt: mtime * 1000,
  signingKey: usingDevKey ? 'dev' : publicKeyB64,
  bundle: { file: bundleName, sha256: sha256(bundle), size: bundle.length, signature },
  platforms: {},
};

function commonEntries(platform) {
  const entries = [
    { name: 'mmo-agent/launcher.cjs', data: launcher, mode: 0o755 },
    { name: `mmo-agent/versions/${version}/agent.js`, data: bundle },
    {
      name: 'mmo-agent/current.json',
      data: Buffer.from(JSON.stringify({ version }, null, 2) + '\n'),
    },
    {
      name: 'mmo-agent/runtime-current.json',
      data: Buffer.from(JSON.stringify({ version: NODE_VERSION }, null, 2) + '\n'),
    },
    {
      name: 'mmo-agent/manifest.json',
      data: Buffer.from(
        JSON.stringify(
          {
            version,
            protocolVersion,
            runtimeVersion: NODE_VERSION,
            platform,
            bundle: manifest.bundle,
          },
          null,
          2,
        ) + '\n',
      ),
    },
    { name: 'mmo-agent/install.ps1', data: installPs1 },
    { name: 'mmo-agent/install.sh', data: installSh, mode: 0o755 },
    {
      name: 'mmo-agent/README.txt',
      data: Buffer.from(
        [
          `MinecraftManagerOnline — agent ${version} (${platform}, Node ${NODE_VERSION})`,
          '',
          'Guided install: in the panel, "Add a machine" gives the command to paste.',
          'Offline install: install.ps1 (Windows) / install.sh (Linux, macOS) with --archive <this file>.',
          'Uninstall: install.ps1 -Uninstall / install.sh --uninstall.',
          'Manual launch: runtime/<version>/node(.exe) launcher.cjs run --panel wss://<panel>/ws/agent',
          '',
        ].join('\n'),
      ),
    },
  ];
  return entries;
}

for (const platform of platforms) {
  const spec = PLATFORMS[platform];
  const nodeArchive = await download(NODE_DIST + spec.node, spec.nodeSha256);
  const nodeEntries = readArchive(spec.node, nodeArchive);
  const prefix = spec.node.replace(/\.(zip|tar\.gz)$/, '') + '/';
  const pick = (rel) => {
    const e = nodeEntries.find((x) => x.name === prefix + rel || x.name === './' + prefix + rel);
    if (!e) throw new Error(`${spec.node}: ${rel} introuvable`);
    return e;
  };
  const nodeBin = pick(spec.nodeBinary);
  const entries = commonEntries(platform);
  entries.push(
    {
      name: `mmo-agent/runtime/${NODE_VERSION}/${spec.nodeBinary}`,
      data: nodeBin.data,
      mode: 0o755,
    },
    { name: `mmo-agent/runtime/${NODE_VERSION}/LICENSE`, data: pick('LICENSE').data },
  );
  if (platform === 'win-x64') {
    const shawlZip = await download(SHAWL.url, SHAWL.sha256);
    const shawl = readArchive('shawl.zip', shawlZip).find((e) => e.name === 'shawl.exe');
    if (!shawl) throw new Error('shawl.exe introuvable dans le zip shawl');
    entries.push({ name: 'mmo-agent/shawl.exe', data: shawl.data, mode: 0o755 });
    entries.push({
      name: 'mmo-agent/shawl-LICENSE.txt',
      data: Buffer.from(
        `shawl ${SHAWL.version} (https://github.com/mtkennerly/shawl), MIT — mentions légales complètes : ${SHAWL.legalUrl}\n`,
      ),
    });
  }
  const file = `mmo-agent-${version}-${platform}.${spec.archive}`;
  const data = spec.archive === 'zip' ? writeZip(entries) : writeTarGz(entries, { mtime });
  writeFileSync(path.join(outDir, file), data);
  manifest.platforms[platform] = { file, sha256: sha256(data), size: data.length };
  console.log(`[release] ${file} (${(data.length / 1048576).toFixed(1)} Mo)`);
}

writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[release] manifest.json → ${outDir}`);

// --- Panel (plateforme de build uniquement : modules natifs better-sqlite3 / argon2) -------------

/** Entrées d'archive d'un dossier (récursif, liens suivis), préfixe donné. */
function collectDir(dir, prefix, filter = () => true) {
  const entries = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const full = path.join(abs, name);
      const relName = rel === '' ? name : `${rel}/${name}`;
      if (!filter(relName)) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, relName);
      else if (st.isFile()) {
        entries.push({
          name: `${prefix}/${relName}`,
          data: readFileSync(full),
          mode:
            process.platform === 'win32'
              ? /\.(sh|node)$|\/bin\//.test(relName)
                ? 0o755
                : 0o644
              : st.mode & 0o777,
        });
      }
    }
  };
  walk(dir, '');
  return entries;
}

if (withPanel) {
  const host = hostPlatform();
  if (!host)
    throw new Error(`plateforme de build non packagée : ${process.platform}/${process.arch}`);
  const spec = PLATFORMS[host];
  const deployDir = path.join(os.tmpdir(), `mmo-panel-deploy-${process.pid}`);
  rmSync(deployDir, { recursive: true, force: true });
  console.log(`[release] pnpm deploy (panel, ${host}) → ${deployDir}`);
  pnpm(
    '--filter',
    '@mmo/panel',
    'deploy',
    '--prod',
    '--legacy',
    '--config.node-linker=hoisted',
    deployDir,
  );
  // better-sqlite3 (13.x) embarque des prebuilds amont liés à une glibc récente (≥ 2.33, constaté
  // en réel sur Ubuntu 20.04 ARM avec les releases 1.0.2/1.0.3) : sur Linux, recompilation depuis
  // les sources contre la glibc de l'hôte de build (conteneur ubuntu:20.04 en CI → plancher 2.31,
  // doc 03 §3), écrasement du prebuild de la plateforme, purge du dossier de compilation (sinon
  // archivé), puis VÉRIFICATION par un require() réel — une archive Linux inchargeable sur l'hôte
  // de build ne peut plus sortir.
  if (process.platform === 'linux') {
    console.log('[release] better-sqlite3 : recompilation contre la glibc locale');
    execFileSync('npm', ['rebuild', 'better-sqlite3', '--build-from-source'], {
      cwd: deployDir,
      stdio: 'inherit',
    });
    const bsDir = path.join(deployDir, 'node_modules', 'better-sqlite3');
    const built = path.join(bsDir, 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(built)) throw new Error('better-sqlite3 : binaire recompilé introuvable');
    copyFileSync(built, path.join(bsDir, 'prebuilds', `linux-${process.arch}.node`));
    rmSync(path.join(bsDir, 'build'), { recursive: true, force: true });
    execFileSync(process.execPath, ['-e', "require('better-sqlite3')"], {
      cwd: deployDir,
      stdio: 'inherit',
    });
  }
  const entries = [];
  const keep = new Set(['dist', 'node_modules', 'drizzle', 'install', 'package.json']);
  entries.push(
    ...collectDir(
      deployDir,
      'mmo-panel/app',
      (rel) => keep.has(rel.split('/')[0]) && !rel.endsWith('.map'),
    ),
  );
  rmSync(deployDir, { recursive: true, force: true });
  entries.push(...collectDir(path.join(ROOT, 'apps/web/dist'), 'mmo-panel/web'));
  const nodeEntries = readArchive(
    spec.node,
    await download(NODE_DIST + spec.node, spec.nodeSha256),
  );
  const prefix = spec.node.replace(/\.(zip|tar\.gz)$/, '') + '/';
  const nodeBin = nodeEntries.find((x) => x.name === prefix + spec.nodeBinary);
  const nodeLicense = nodeEntries.find((x) => x.name === prefix + 'LICENSE');
  if (!nodeBin || !nodeLicense) throw new Error(`${spec.node}: runtime introuvable`);
  entries.push(
    {
      name: `mmo-panel/runtime/${NODE_VERSION}/${spec.nodeBinary}`,
      data: nodeBin.data,
      mode: 0o755,
    },
    { name: `mmo-panel/runtime/${NODE_VERSION}/LICENSE`, data: nodeLicense.data },
  );
  for (const f of [
    bundleName,
    'manifest.json',
    ...Object.values(manifest.platforms).map((p) => p.file),
  ]) {
    entries.push({ name: `mmo-panel/dist-agent/${f}`, data: readFileSync(path.join(outDir, f)) });
  }
  if (host === 'win-x64') {
    const shawl = readArchive('shawl.zip', await download(SHAWL.url, SHAWL.sha256)).find(
      (e) => e.name === 'shawl.exe',
    );
    entries.push({ name: 'mmo-panel/shawl.exe', data: shawl.data, mode: 0o755 });
    entries.push({
      name: 'mmo-panel/mmo-panel.cmd',
      data: Buffer.from(
        [
          '@echo off',
          'rem MinecraftManagerOnline — panel. Variables : MMO_PORT (3000), MMO_HOST (127.0.0.1), MMO_DATA_DIR (.\\data)',
          'setlocal',
          'set "HERE=%~dp0"',
          'if "%MMO_DATA_DIR%"=="" set "MMO_DATA_DIR=%HERE%data"',
          'set "MMO_WEB_DIR=%HERE%web"',
          'if "%MMO_DIST_DIR%"=="" set "MMO_DIST_DIR=%HERE%dist-agent"',
          `"%HERE%runtime\\${NODE_VERSION}\\node.exe" "%HERE%app\\dist\\main.js" %*`,
          '',
        ].join('\r\n'),
      ),
    });
  } else {
    entries.push({
      name: 'mmo-panel/mmo-panel.sh',
      mode: 0o755,
      data: Buffer.from(
        [
          '#!/bin/sh',
          '# MinecraftManagerOnline — panel. Variables : MMO_PORT (3000), MMO_HOST (127.0.0.1), MMO_DATA_DIR (./data)',
          'HERE="$(cd "$(dirname "$0")" && pwd)"',
          'export MMO_DATA_DIR="${MMO_DATA_DIR:-$HERE/data}"',
          'export MMO_WEB_DIR="$HERE/web"',
          'export MMO_DIST_DIR="${MMO_DIST_DIR:-$HERE/dist-agent}"',
          `exec "$HERE/runtime/${NODE_VERSION}/bin/node" "$HERE/app/dist/main.js" "$@"`,
          '',
        ].join('\n'),
      ),
    });
  }
  entries.push({
    name: 'mmo-panel/README.txt',
    data: Buffer.from(
      [
        `MinecraftManagerOnline — panel ${panelVersion} (${host}, Node ${NODE_VERSION})`,
        '',
        'Start: mmo-panel.cmd (Windows) / ./mmo-panel.sh (Linux, macOS), then open http://127.0.0.1:3000',
        'Data: ./data (MMO_DATA_DIR) — back up this folder. Agent archives served from ./dist-agent (MMO_DIST_DIR).',
        'Service and remote access: docs/guide/installation.md',
        '',
      ].join('\n'),
    ),
  });
  const file = `mmo-panel-${panelVersion}-${host}.${spec.archive}`;
  const data = spec.archive === 'zip' ? writeZip(entries) : writeTarGz(entries, { mtime });
  writeFileSync(path.join(outDir, file), data);
  const panelManifest = {
    version: panelVersion,
    platform: host,
    runtimeVersion: NODE_VERSION,
    file,
    sha256: sha256(data),
    size: data.length,
  };
  writeFileSync(
    path.join(outDir, `panel-${host}.json`),
    JSON.stringify(panelManifest, null, 2) + '\n',
  );
  console.log(`[release] ${file} (${(data.length / 1048576).toFixed(1)} Mo)`);
}
