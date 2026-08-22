/**
 * Phase 11 — distribution des archives d'installation de l'agent (doc 03 §3) : le panel sert les
 * archives par plateforme (`/dist/<fichier>`), les scripts `install.ps1` / `install.sh` (templates
 * `apps/panel/install/`, URL du panel injectée) et le manifeste (`/api/dist`). Le dossier
 * `<distDir>` (défaut `<dataDir>/dist`, env `MMO_DIST_DIR`) est alimenté par `tools/release/publish.mjs`
 * (upload admin) ou par une copie manuelle de `release/<version>/`. Importer un manifeste publie
 * aussi le bundle comme release d'agent (`ReleasesService`) si cette version n'existe pas encore.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  distManifestSchema,
  type DistManifest,
  type DistPlatformDto,
  type DistStatusDto,
} from '@mmo/protocol/client';

import { AppError, notFound } from '../errors.js';
import { normalizeOrigin } from '../util/origin.js';
import type { ReleasesService } from './releases.js';
import { SETTING_KEYS, type SettingsService } from './settings.js';

export interface DistributionServiceDeps {
  distDir: string;
  /** Dossier des templates `install.ps1` / `install.sh` (défaut : `apps/panel/install`). */
  installDir?: string | undefined;
  settings: SettingsService;
  releases: ReleasesService;
}

/** `apps/panel/install` relatif à ce fichier (valable depuis `src/services` comme `dist/services`). */
export const DEFAULT_INSTALL_DIR = path.resolve(import.meta.dirname, '../../install');

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/;
const SCRIPTS = {
  'install.ps1': 'text/plain; charset=utf-8',
  'install.sh': 'text/plain; charset=utf-8',
};
export type InstallScript = keyof typeof SCRIPTS;

export class DistributionService {
  private cache: { mtimeMs: number; manifest: DistManifest } | undefined;

  constructor(private readonly deps: DistributionServiceDeps) {}

  get directory(): string {
    return this.deps.distDir;
  }

  private get manifestPath(): string {
    return path.join(this.deps.distDir, 'manifest.json');
  }

  /** Manifeste courant (relu quand le fichier change), `undefined` si aucune distribution. */
  manifest(): DistManifest | undefined {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.manifestPath).mtimeMs;
    } catch {
      this.cache = undefined;
      return undefined;
    }
    if (this.cache?.mtimeMs === mtimeMs) return this.cache.manifest;
    try {
      const manifest = distManifestSchema.parse(
        JSON.parse(readFileSync(this.manifestPath, 'utf8')),
      );
      this.cache = { mtimeMs, manifest };
      return manifest;
    } catch {
      this.cache = undefined;
      return undefined;
    }
  }

  status(): DistStatusDto {
    const m = this.manifest();
    const publicUrl = this.deps.settings.get(SETTING_KEYS.publicUrl);
    const install =
      publicUrl === undefined
        ? null
        : {
            windows: `& ([scriptblock]::Create((irm ${publicUrl}/install.ps1)))`,
            unix: `curl -fsSL ${publicUrl}/install.sh | sh`,
          };
    if (!m) {
      return {
        available: false,
        version: null,
        protocolVersion: null,
        runtimeVersion: null,
        builtAt: null,
        signingKey: null,
        releasePublished: false,
        platforms: {},
        install,
      };
    }
    return {
      available: Object.keys(m.platforms).length > 0,
      version: m.version,
      protocolVersion: m.protocolVersion,
      runtimeVersion: m.runtimeVersion,
      builtAt: m.builtAt ?? null,
      signingKey: m.signingKey ?? null,
      releasePublished: this.deps.releases.get(m.version) !== undefined,
      platforms: Object.fromEntries(
        Object.entries(m.platforms).map(([p, f]) => [p, { ...f, url: `/dist/${f.file}` }]),
      ),
      install,
    };
  }

  platform(platform: string): DistPlatformDto {
    const m = this.manifest();
    const f = m && Object.hasOwn(m.platforms, platform) ? m.platforms[platform] : undefined;
    if (!m || !f) throw notFound('distribution', platform);
    return {
      platform,
      version: m.version,
      runtimeVersion: m.runtimeVersion,
      ...f,
      url: `/dist/${f.file}`,
    };
  }

  /** Chemin d'un fichier servi (archives et bundle listés par le manifeste uniquement). */
  filePath(file: string): { path: string; sha256: string; size: number } {
    const m = this.manifest();
    if (m) {
      const entry =
        m.bundle.file === file ? m.bundle : Object.values(m.platforms).find((f) => f.file === file);
      if (entry && FILE_NAME.test(file)) {
        const p = path.join(this.deps.distDir, file);
        if (existsSync(p)) return { path: p, sha256: entry.sha256, size: entry.size };
      }
    }
    throw notFound('distribution file', file);
  }

  /** Script d'installation, URL du panel injectée (`panel.publicUrl`, sinon l'origine de la requête). */
  installScript(
    name: InstallScript,
    requestOrigin: string | undefined,
  ): { body: string; type: string } {
    const template = readFileSync(
      path.join(this.deps.installDir ?? DEFAULT_INSTALL_DIR, name),
      'utf8',
    );
    const url =
      normalizeOrigin(this.deps.settings.get(SETTING_KEYS.publicUrl)) ??
      normalizeOrigin(requestOrigin);
    return {
      body: template.replaceAll('__PANEL_URL__', url ?? '__PANEL_URL__'),
      type: SCRIPTS[name],
    };
  }

  /** Dépose un fichier (archive ou bundle) dans `<distDir>` ; retourne sha256 + taille. */
  async putFile(
    file: string,
    body: Readable,
  ): Promise<{ file: string; sha256: string; size: number }> {
    if (!FILE_NAME.test(file) || file === 'manifest.json') {
      throw new AppError('E_VALIDATION', `invalid file name: ${file}`);
    }
    await mkdir(this.deps.distDir, { recursive: true });
    const target = path.join(this.deps.distDir, file);
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    const hash = createHash('sha256');
    let size = 0;
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.byteLength;
    });
    try {
      await pipeline(body, createWriteStream(tmp));
      if (size === 0) throw new AppError('E_VALIDATION', 'empty file');
      await rename(tmp, target);
    } finally {
      await rm(tmp, { force: true });
    }
    return { file, sha256: hash.digest('hex'), size };
  }

  /**
   * Installe un manifeste : chaque fichier listé doit être présent avec sha256 et taille exacts ;
   * publie le bundle comme release d'agent si absent (signature du manifeste).
   */
  async putManifest(input: unknown): Promise<DistStatusDto> {
    const manifest = distManifestSchema.parse(input);
    await mkdir(this.deps.distDir, { recursive: true });
    const files = [manifest.bundle, ...Object.values(manifest.platforms)];
    for (const f of files) {
      if (!FILE_NAME.test(f.file))
        throw new AppError('E_VALIDATION', `invalid file name: ${f.file}`);
      const p = path.join(this.deps.distDir, f.file);
      const st = await stat(p).catch(() => undefined);
      if (!st?.isFile()) {
        throw new AppError('E_VALIDATION', `missing file: ${f.file}`, {
          details: { file: f.file },
        });
      }
      if (st.size !== f.size) {
        throw new AppError('E_CHECKSUM_MISMATCH', `size mismatch for ${f.file}`, {
          details: { file: f.file, expected: f.size, actual: st.size },
        });
      }
      const actual = await hashFile(p);
      if (actual !== f.sha256) {
        throw new AppError('E_CHECKSUM_MISMATCH', `sha256 mismatch for ${f.file}`, {
          details: { file: f.file, expected: f.sha256, actual },
        });
      }
    }
    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    this.cache = undefined;
    if (this.deps.releases.get(manifest.version) === undefined) {
      await this.deps.releases.publish(
        {
          version: manifest.version,
          signature: manifest.bundle.signature,
          protocolVersion: manifest.protocolVersion,
          runtimeVersion: manifest.runtimeVersion,
        },
        createReadStream(path.join(this.deps.distDir, manifest.bundle.file)),
      );
    }
    return this.status();
  }

  /**
   * Au démarrage : si un manifeste est présent (archive du panel : `dist-agent/`, ou copie manuelle)
   * et que sa version n'est pas encore une release d'agent, la publie (`agent.update` disponible
   * sans action admin). Fichiers vérifiés comme pour `putManifest`.
   */
  async syncRelease(): Promise<boolean> {
    const m = this.manifest();
    if (!m || this.deps.releases.get(m.version) !== undefined) return false;
    const p = path.join(this.deps.distDir, m.bundle.file);
    const st = await stat(p).catch(() => undefined);
    if (!st?.isFile() || st.size !== m.bundle.size || (await hashFile(p)) !== m.bundle.sha256) {
      return false;
    }
    await this.deps.releases.publish(
      {
        version: m.version,
        signature: m.bundle.signature,
        protocolVersion: m.protocolVersion,
        runtimeVersion: m.runtimeVersion,
      },
      createReadStream(p),
    );
    return true;
  }

  /** Supprime la distribution (manifeste + fichiers listés). La release d'agent reste. */
  async clear(): Promise<void> {
    const m = this.manifest();
    if (m) {
      for (const f of [m.bundle, ...Object.values(m.platforms)]) {
        if (FILE_NAME.test(f.file)) await rm(path.join(this.deps.distDir, f.file), { force: true });
      }
    }
    await rm(this.manifestPath, { force: true });
    this.cache = undefined;
  }

  /** Lecture d'un manifeste sur disque (tests, import local). */
  static async readManifest(file: string): Promise<DistManifest> {
    return distManifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
