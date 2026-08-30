/**
 * Constantes épinglées du pipeline de release (doc 03 §3). Toute mise à jour du runtime passe ici
 * (version = `.node-version`, sha256 = `SHASUMS256.txt` officiel) : le build refuse un téléchargement
 * dont l'empreinte diffère.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');

export const NODE_VERSION = readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim();

/** Plateformes packagées : nom MMO → distribution Node officielle. */
export const PLATFORMS = {
  'win-x64': {
    node: `node-v${NODE_VERSION}-win-x64.zip`,
    nodeSha256: '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73',
    archive: 'zip',
    nodeBinary: 'node.exe',
  },
  'linux-x64': {
    node: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    nodeSha256: 'f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4',
    archive: 'tar.gz',
    nodeBinary: 'bin/node',
  },
  'linux-arm64': {
    node: `node-v${NODE_VERSION}-linux-arm64.tar.gz`,
    nodeSha256: 'd28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f',
    archive: 'tar.gz',
    nodeBinary: 'bin/node',
  },
  'darwin-arm64': {
    node: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeSha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
    archive: 'tar.gz',
    nodeBinary: 'bin/node',
  },
};

export const NODE_DIST = `https://nodejs.org/dist/v${NODE_VERSION}/`;

/**
 * Plancher de glibc des archives Linux : Ubuntu 20.04 (2.31), la plus ancienne distribution encore
 * en service chez un utilisateur du projet. Tout `.node` embarqué qui exige davantage rend
 * l'archive inutilisable — c'est ce qui est sorti sans être vu en 1.0.2 et 1.0.3.
 */
export const GLIBC_FLOOR = [2, 31];

/** shawl (service Windows, doc 03 §3), épinglé. */
export const SHAWL = {
  version: '1.9.0',
  url: 'https://github.com/mtkennerly/shawl/releases/download/v1.9.0/shawl-v1.9.0-win64.zip',
  sha256: 'f883c5d09c9beae2efaeabd8513e7d3f57cd1d0864cec3df4f4a7b6ee904351c',
  legalUrl: 'https://github.com/mtkennerly/shawl/releases/download/v1.9.0/shawl-v1.9.0-legal.zip',
};

/** Plateforme courante au format MMO (`undefined` si non packagée). */
export function hostPlatform() {
  const os = process.platform === 'win32' ? 'win' : process.platform;
  const key = `${os}-${process.arch}`;
  return key in PLATFORMS ? key : undefined;
}
