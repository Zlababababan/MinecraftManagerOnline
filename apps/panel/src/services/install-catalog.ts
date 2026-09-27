/**
 * Lot 5 — catalogue des versions installables (vanilla, Fabric, Forge, NeoForge) et construction du **plan** envoyé à l'agent
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
  FORGE_MAVEN_METADATA_URL,
  FORGE_PROMOTIONS_URL,
  NEOFORGE_MAVEN_METADATA_URL,
  fabricGameUrl,
  fabricInstallerUrl,
  fabricLoaderUrl,
  fabricServerJarName,
  fabricServerJarUrl,
  forgeInstallerUrl,
  forgeMavenVersion,
  groupNeoForgeVersions,
  isStrictJava8,
  mavenSha1Url,
  mcVersionFromNeoForge,
  neoforgeInstallerUrl,
  parseFabricGameVersions,
  parseFabricInstallers,
  parseFabricLoaders,
  parseMcVersionDetail,
  parseForgePromotions,
  parseMavenSha1,
  parseMavenVersions,
  parseMcVersionManifest,
  pickStable,
  type FabricVersion,
  type ForgePromotion,
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
  /** Exactement cette version (Forge ≤ 1.16.5 ne démarre que sous Java 8). */
  javaStrict: boolean;
}

/** Dossier où l'installeur Forge/NeoForge est posé, puis retiré (doc 06 §6quater). */
export const INSTALLER_DIR = '.mmo-install';

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
  private forgePromos: Cached<Map<string, ForgePromotion>> | undefined;
  private forgeMaven: Cached<string[]> | undefined;
  private neoforge: Cached<Map<string, FabricVersion[]>> | undefined;

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
    const dto = (v: McVersionEntry, loaderVersion?: string): CatalogVersionDto => ({
      id: v.id,
      stable: v.type === 'release',
      ...(v.releasedAt === 0 ? {} : { releasedAt: v.releasedAt }),
      ...(loaderVersion === undefined ? {} : { loaderVersion }),
    });
    // L'ordre et les dates viennent toujours de Mojang ; chaque loader ne dit que ce qu'il supporte.
    switch (loader) {
      case 'vanilla':
        return mojang.map((v) => dto(v));
      case 'fabric': {
        const supported = new Set(await this.fabricGameVersions());
        return mojang.filter((v) => supported.has(v.id)).map((v) => dto(v));
      }
      case 'forge': {
        const promos = await this.forgePromotions();
        return mojang.flatMap((v) => {
          const build = forgeBuildOf(promos.get(v.id));
          return build === undefined ? [] : [dto(v, build)];
        });
      }
      case 'neoforge': {
        const groups = await this.neoforgeVersions();
        return mojang.flatMap((v) => {
          const build = pickStable(groups.get(v.id) ?? [])?.version;
          return build === undefined ? [] : [dto(v, build)];
        });
      }
    }
  }

  /** Construit le plan d'installation. Toute panne de fournisseur est dite, pas devinée. */
  async plan(input: {
    loader: InstallLoader;
    mcVersion: string;
    loaderVersion?: string | undefined;
  }): Promise<InstallPlan> {
    const download = await this.serverDownload(input.mcVersion);
    if (input.loader === 'forge' || input.loader === 'neoforge') {
      return this.forgeLikePlan(input.loader, input.mcVersion, input.loaderVersion, download);
    }
    if (input.loader === 'vanilla') {
      return {
        loader: 'vanilla',
        mcVersion: input.mcVersion,
        loaderVersion: undefined,
        javaMajor: download.javaMajor,
        javaStrict: false,
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
      javaStrict: false,
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

  /**
   * Forge et NeoForge : l'installeur est posé dans `.mmo-install/`, exécuté avec
   * `--installServer` depuis le dossier du serveur (il installe dans le dossier courant, mesuré doc
   * 06 §6quater), puis retiré avec le journal qu'il laisse. Le serveur n'a besoin ni de l'un ni de
   * l'autre pour tourner.
   */
  private async forgeLikePlan(
    loader: 'forge' | 'neoforge',
    mcVersion: string,
    requested: string | undefined,
    download: McServerDownload,
  ): Promise<InstallPlan> {
    let build: string | undefined;
    let url: string | undefined;
    if (loader === 'forge') {
      build = requested ?? forgeBuildOf((await this.forgePromotions()).get(mcVersion));
      const coordinate =
        build === undefined
          ? undefined
          : forgeMavenVersion(mcVersion, build, await this.forgeMavenVersions());
      url = coordinate === undefined ? undefined : forgeInstallerUrl(coordinate);
    } else {
      const builds = (await this.neoforgeVersions()).get(mcVersion) ?? [];
      build = requested ?? pickStable(builds)?.version;
      url =
        build !== undefined && builds.some((b) => b.version === build)
          ? neoforgeInstallerUrl(build)
          : undefined;
    }
    if (build === undefined || url === undefined) {
      throw new AppError('E_VALIDATION', `${loader} does not support this Minecraft version`, {
        details: { reason: 'NO_LOADER', mcVersion, loader },
      });
    }
    const label = `${loader === 'forge' ? 'Forge' : 'NeoForge'} ${build}`;
    const jar = `${INSTALLER_DIR}/${loader}-installer.jar`;
    const strict = isStrictJava8(loader, mcVersion);
    return {
      loader,
      mcVersion,
      loaderVersion: build,
      javaMajor: strict ? 8 : download.javaMajor,
      javaStrict: strict,
      steps: [
        { kind: 'download', path: jar, url, sha1: await this.sha1Of(url, loader), label },
        {
          kind: 'runJar',
          jar,
          args: ['--installServer'],
          timeoutSec: INSTALL_RUN_TIMEOUT_DEFAULT_SEC,
          // Toutes les générations mesurées écrivent libraries/ : sans lui, rien n'est installé.
          expect: ['libraries'],
          label,
        },
        { kind: 'remove', path: INSTALLER_DIR },
        { kind: 'remove', path: 'installer.jar.log' },
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

  private async forgePromotions(): Promise<Map<string, ForgePromotion>> {
    const cached = this.fresh(this.forgePromos);
    if (cached) return cached;
    const json = await this.get(FORGE_PROMOTIONS_URL, 'forge.promotions');
    const value = this.parse(() => parseForgePromotions(json));
    this.forgePromos = { at: this.deps.now(), value };
    return value;
  }

  private async forgeMavenVersions(): Promise<string[]> {
    const cached = this.fresh(this.forgeMaven);
    if (cached) return cached;
    const xml = await this.getText(FORGE_MAVEN_METADATA_URL, 'forge.maven');
    const value = this.parse(() => parseMavenVersions(xml, 'forge.maven'));
    this.forgeMaven = { at: this.deps.now(), value };
    return value;
  }

  private async neoforgeVersions(): Promise<Map<string, FabricVersion[]>> {
    const cached = this.fresh(this.neoforge);
    if (cached) return cached;
    const xml = await this.getText(NEOFORGE_MAVEN_METADATA_URL, 'neoforge.maven');
    const value = this.parse(() =>
      groupNeoForgeVersions(parseMavenVersions(xml, 'neoforge.maven'), mcVersionFromNeoForge),
    );
    this.neoforge = { at: this.deps.now(), value };
    return value;
  }

  /** Empreinte publiée à côté de l'installeur : il est vérifié comme le serveur vanilla. */
  private async sha1Of(url: string, loader: string): Promise<string> {
    const text = await this.getText(mavenSha1Url(url), loader + '.sha1');
    return this.parse(() => parseMavenSha1(text, loader + '.sha1'));
  }

  private async getText(url: string, source: string): Promise<string> {
    const res = await this.fetchOk(url, source);
    return await res.text();
  }

  private async get(url: string, source: string): Promise<unknown> {
    const res = await this.fetchOk(url, source);
    return await res.json();
  }

  private async fetchOk(url: string, source: string): Promise<Response> {
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
    return res;
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

/** Forge : le build recommandé s'il y en a un, sinon le plus récent. */
function forgeBuildOf(promo: ForgePromotion | undefined): string | undefined {
  return promo?.recommended ?? promo?.latest;
}
