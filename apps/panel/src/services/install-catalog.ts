/**
 * Lot 5 — catalogue des versions installables et construction du **plan** envoyé à l'agent
 * (doc 05 §6 « Installation », doc 06 §6ter). Le panel est le seul à parler aux fournisseurs :
 * l'agent ne connaît ni Mojang ni Fabric, il exécute une liste d'étapes.
 *
 * Tout ce qui interprète une réponse vit dans `@mmo/shared` (`minecraft/catalogs.ts`, pur et
 * testé hors réseau) ; ce service n'ajoute que les appels, un cache et la mise en plan.
 *
 * Cache : les listes de versions vieillissent (`ttlMs`, 1 h par défaut) ; le **détail** d'une
 * version publiée ne change plus jamais et est gardé sans expiration.
 */
import {
  CatalogFormatError,
  fabricGameUrl,
  fabricInstallerUrl,
  fabricLoaderUrl,
  fabricServerJarName,
  fabricServerJarUrl,
  parseFabricGameVersions,
  parseFabricInstallers,
  parseFabricLoaders,
  parseMcVersionDetail,
  parseMcVersionManifest,
  pickStable,
  MOJANG_VERSION_MANIFEST_URL,
  type McServerDownload,
  type McVersionEntry,
} from '@mmo/shared';
import { INSTALL_RUN_TIMEOUT_DEFAULT_SEC, type InstallStep } from '@mmo/protocol';
import type { CatalogVersionDto, InstallLoader } from '@mmo/protocol/client';

import { AppError } from '../errors.js';

export interface InstallCatalogDeps {
  fetchImpl: typeof fetch | undefined;
  now: () => number;
  logger: { warn: (obj: object, msg: string) => void };
  /** Durée de validité des listes de versions (défaut 1 h). */
  ttlMs?: number | undefined;
}

/** Plan d'installation prêt à partir, avec ce que le panel a appris en le construisant. */
export interface InstallPlan {
  steps: InstallStep[];
  loader: InstallLoader;
  mcVersion: string;
  loaderVersion: string | undefined;
  /** Java du **serveur** (le `runJar` d'installation, lui, se contente de ce qu'il trouve). */
  javaMajor: number | undefined;
}

interface Cached<T> {
  at: number;
  value: T;
}

const DEFAULT_TTL_MS = 3_600_000;

export class InstallCatalogService {
  private mojang: Cached<McVersionEntry[]> | undefined;
  private fabricGames: Cached<string[]> | undefined;
  private fabricInstaller: Cached<string> | undefined;
  private readonly fabricLoaders = new Map<string, Cached<string | undefined>>();
  private readonly details = new Map<string, McServerDownload>();

  constructor(private readonly deps: InstallCatalogDeps) {}

  private get ttl(): number {
    return this.deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  private fresh<T>(entry: Cached<T> | undefined): T | undefined {
    return entry !== undefined && this.deps.now() - entry.at < this.ttl ? entry.value : undefined;
  }

  /** Versions proposées pour un loader, les plus récentes d'abord. */
  async versions(loader: InstallLoader): Promise<CatalogVersionDto[]> {
    const mojang = await this.mojangVersions();
    if (loader === 'vanilla') {
      return mojang.map((v) => ({
        id: v.id,
        stable: v.type === 'release',
        releasedAt: v.releasedAt === 0 ? undefined : v.releasedAt,
      }));
    }
    const supported = new Set(await this.fabricGameVersions());
    // L'ordre et les dates viennent de Mojang ; Fabric ne dit que ce qu'il supporte.
    const known = mojang.filter((v) => supported.has(v.id));
    return known.map((v) => ({
      id: v.id,
      stable: v.type === 'release',
      releasedAt: v.releasedAt === 0 ? undefined : v.releasedAt,
    }));
  }

  /** Construit le plan d'installation. Toute panne de fournisseur est dite, pas devinée. */
  async plan(input: {
    loader: InstallLoader;
    mcVersion: string;
    loaderVersion?: string | undefined;
  }): Promise<InstallPlan> {
    const download = await this.serverDownload(input.mcVersion);
    if (input.loader === 'vanilla') {
      return {
        loader: 'vanilla',
        mcVersion: input.mcVersion,
        loaderVersion: undefined,
        javaMajor: download.javaMajor,
        steps: [
          {
            kind: 'download',
            path: 'server.jar',
            url: download.url,
            sha1: download.sha1,
            size: download.size,
            label: `Minecraft ${input.mcVersion}`,
          },
        ],
      };
    }
    const loaderVersion = input.loaderVersion ?? (await this.fabricLoaderVersion(input.mcVersion));
    if (loaderVersion === undefined) {
      throw new AppError('E_VALIDATION', 'Fabric does not support this Minecraft version', {
        details: { reason: 'NO_LOADER', mcVersion: input.mcVersion },
      });
    }
    const installerVersion = await this.fabricInstallerVersion();
    const jar = fabricServerJarName(input.mcVersion, loaderVersion, installerVersion);
    return {
      loader: 'fabric',
      mcVersion: input.mcVersion,
      loaderVersion,
      javaMajor: download.javaMajor,
      steps: [
        {
          kind: 'download',
          path: jar,
          url: fabricServerJarUrl(input.mcVersion, loaderVersion, installerVersion),
          label: `Fabric ${loaderVersion}`,
        },
        // Le lanceur télécharge le serveur vanilla et les bibliothèques, puis démarre — et
        // s'arrête faute d'EULA, que l'agent n'écrit qu'APRÈS (doc 06 §6ter). `expect` parce
        // qu'un lanceur qui sort 0 sans avoir rien installé n'est pas un succès.
        {
          kind: 'runJar',
          jar,
          args: ['nogui'],
          timeoutSec: INSTALL_RUN_TIMEOUT_DEFAULT_SEC,
          expect: ['libraries'],
          label: `Fabric ${loaderVersion}`,
        },
      ],
    };
  }

  // --- Fournisseurs ----------------------------------------------------------------------------

  private async mojangVersions(): Promise<McVersionEntry[]> {
    const cached = this.fresh(this.mojang);
    if (cached) return cached;
    const json = await this.get(MOJANG_VERSION_MANIFEST_URL, 'mojang.manifest');
    const parsed = this.parse(() => parseMcVersionManifest(json));
    this.mojang = { at: this.deps.now(), value: parsed.versions };
    return parsed.versions;
  }

  /** Détail d'une version : URL du serveur, empreinte, taille, Java attendu. */
  private async serverDownload(mcVersion: string): Promise<McServerDownload> {
    const known = this.details.get(mcVersion);
    if (known) return known;
    const entry = (await this.mojangVersions()).find((v) => v.id === mcVersion);
    if (entry === undefined) {
      throw new AppError('E_NOT_FOUND', 'unknown Minecraft version', {
        details: { reason: 'UNKNOWN_VERSION', mcVersion },
      });
    }
    const json = await this.get(entry.url, 'mojang.version');
    const detail = this.parse(() => parseMcVersionDetail(json));
    this.details.set(mcVersion, detail);
    return detail;
  }

  private async fabricGameVersions(): Promise<string[]> {
    const cached = this.fresh(this.fabricGames);
    if (cached) return cached;
    const json = await this.get(fabricGameUrl(), 'fabric.game');
    const value = this.parse(() => parseFabricGameVersions(json)).map((v) => v.version);
    this.fabricGames = { at: this.deps.now(), value };
    return value;
  }

  private async fabricLoaderVersion(mcVersion: string): Promise<string | undefined> {
    const cached = this.fresh(this.fabricLoaders.get(mcVersion));
    if (cached !== undefined) return cached;
    const json = await this.get(fabricLoaderUrl(mcVersion), 'fabric.loader');
    const value = pickStable(this.parse(() => parseFabricLoaders(json)))?.version;
    this.fabricLoaders.set(mcVersion, { at: this.deps.now(), value });
    return value;
  }

  private async fabricInstallerVersion(): Promise<string> {
    const cached = this.fresh(this.fabricInstaller);
    if (cached !== undefined) return cached;
    const json = await this.get(fabricInstallerUrl(), 'fabric.installer');
    const parsed = this.parse(() => parseFabricInstallers(json));
    const value = pickStable(parsed)?.version;
    if (value === undefined) {
      throw new AppError('E_UNREACHABLE', 'no Fabric installer published', {
        details: { reason: 'CATALOG_FORMAT', source: 'fabric.installer' },
      });
    }
    this.fabricInstaller = { at: this.deps.now(), value };
    return value;
  }

  private async get(url: string, source: string): Promise<unknown> {
    const doFetch = this.deps.fetchImpl ?? globalThis.fetch;
    const res = await doFetch(url, { signal: AbortSignal.timeout(15_000) }).catch(
      (error: unknown) => {
        this.deps.logger.warn({ url, source, error: String(error) }, 'catalog fetch failed');
        throw new AppError('E_UNREACHABLE', 'version catalog is unreachable', {
          retryable: true,
          details: { reason: 'CATALOG_UNREACHABLE', source },
        });
      },
    );
    if (!res.ok) {
      throw new AppError('E_UNREACHABLE', 'version catalog answered an error', {
        retryable: true,
        details: { reason: 'CATALOG_HTTP', source, status: res.status },
      });
    }
    return await res.json();
  }

  /** Une réponse de forme inattendue est une panne du fournisseur, nommée comme telle. */
  private parse<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof CatalogFormatError) {
        // `no_server_download` n'est pas une panne : c'est une version non installable.
        const code = error.reason === 'no_server_download' ? 'E_VALIDATION' : 'E_UNREACHABLE';
        throw new AppError(code, `${error.source}: ${error.reason}`, {
          details: { reason: error.reason.toUpperCase(), source: error.source },
        });
      }
      throw error;
    }
  }
}
