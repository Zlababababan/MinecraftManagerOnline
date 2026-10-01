/**
 * Intégration FTB (lot 5, doc 06 §6quinquies) — **optionnelle et retirable**.
 *
 * - Optionnelle : le réglage `modpacks.ftb.enabled` (Réglages → Services tiers) coupe tout. Coupée,
 *   aucune route ne répond (404 `FEATURE_DISABLED`) et le panel ne contacte plus l'API FTB.
 * - Retirable : ce fichier, sa route et ses homologues ailleurs sont listés dans
 *   `docs/services-tiers.md`, avec les deux lignes de branchement à enlever.
 *
 * À vérifier avant de livrer (note affichée aux administrateurs) : les conditions d'utilisation de
 * l'API FTB par un outil tiers n'ont pas été trouvées — voir `THIRD_PARTY_SERVICES` (`ftb`).
 *
 * Cache : liste et détail d'un pack 1 h ; la liste de fichiers d'une version publiée ne change
 * plus, mais pèse ~5 Mio de JSON : seules les quelques dernières demandées sont gardées.
 */
import {
  CatalogFormatError,
  ftbPackUrl,
  ftbPopularUrl,
  ftbSearchUrl,
  ftbVersionUrl,
  parseFtbPack,
  parseFtbPackIds,
  parseFtbVersion,
  type FtbPack,
  type FtbVersion,
} from '@mmo/shared';
import { FETCH_MANY_CONCURRENCY_DEFAULT, MAX_FETCH_MANY_FILES } from '@mmo/protocol';
import {
  FTB_SEARCH_LIMIT,
  type FtbPackDto,
  type FtbPackListDto,
  type ModpackRef,
} from '@mmo/protocol/client';

import { AppError } from '../../errors.js';
import { PoliteFetchError, busyOrHttp, type PoliteFetcher } from '../../util/polite-fetch.js';
import type { ModpackProvider, ModpackResolution } from './types.js';

export interface FtbServiceDeps {
  /**
   * Seul point de sortie (User-Agent, 3 requêtes à la fois par hôte, requêtes identiques
   * partagées, 429 respecté, cache négatif) : une recherche qui veut vingt fiches ne part jamais
   * en rafale.
   */
  fetcher: PoliteFetcher;
  now: () => number;
  logger: { warn: (obj: object, msg: string) => void };
  /** Lu à chaque appel : couper le réglage prend effet sans redémarrer. */
  enabled: () => boolean;
  ttlMs?: number | undefined;
}

interface Cached<T> {
  at: number;
  value: T;
}

const DEFAULT_TTL_MS = 3_600_000;
const VERSION_CACHE_SIZE = 4;

export class FtbService implements ModpackProvider {
  private readonly lists = new Map<string, Cached<number[]>>();
  private readonly packs = new Map<number, Cached<FtbPack>>();
  private readonly versions = new Map<string, FtbVersion>();
  /** Packs introuvables ou illisibles : pas redemandés à chaque recherche (durée du cache). */
  private readonly unreadable = new Map<number, Cached<true>>();

  constructor(private readonly deps: FtbServiceDeps) {}

  /** Coupée, l'intégration n'existe pas : même réponse qu'une route inconnue, raison en plus. */
  assertEnabled(): void {
    if (!this.deps.enabled()) {
      throw new AppError('E_NOT_FOUND', 'the FTB integration is disabled', {
        details: { reason: 'FEATURE_DISABLED', feature: 'ftb' },
      });
    }
  }

  /** Recherche par nom, ou les plus installés quand `term` est vide. */
  async list(term: string): Promise<FtbPackListDto> {
    this.assertEnabled();
    const q = term.trim();
    const key = q.toLowerCase();
    let ids = this.fresh(this.lists.get(key));
    if (ids === undefined) {
      const url = q === '' ? ftbPopularUrl(FTB_SEARCH_LIMIT) : ftbSearchUrl(q, FTB_SEARCH_LIMIT);
      const json = await this.get(url);
      ids = this.parse(() => parseFtbPackIds(json));
      this.lists.set(key, { at: this.deps.now(), value: ids });
    }
    const packs = await Promise.all(
      ids.map((id) =>
        (this.fresh(this.unreadable.get(id)) ? Promise.resolve(undefined) : this.packOf(id)).catch(
          (error: unknown) => {
            // Un pack illisible ne doit pas priver la liste des autres, ni être redemandé à chaque
            // recherche ; une panne passagère (réessayable), elle, ne le condamne pas.
            if (!(error instanceof AppError && error.retryable)) {
              this.unreadable.set(id, { at: this.deps.now(), value: true });
            }
            this.deps.logger.warn({ packId: id, error: String(error) }, 'ftb pack skipped');
            return undefined;
          },
        ),
      ),
    );
    return {
      packs: packs.flatMap((p) =>
        p === undefined ? [] : [{ id: p.id, name: p.name, synopsis: p.synopsis }],
      ),
    };
  }

  /** Un pack et ses versions, la plus récente d'abord. */
  async pack(packId: number): Promise<FtbPackDto> {
    this.assertEnabled();
    const p = await this.packOf(packId);
    return {
      id: p.id,
      name: p.name,
      synopsis: p.synopsis,
      versions: p.versions.map((v) => ({
        id: v.id,
        name: v.name,
        type: v.type,
        ...(v.releasedAt === 0 ? {} : { releasedAt: v.releasedAt }),
        mcVersion: v.mcVersion ?? null,
        loader: v.loader ?? null,
        loaderVersion: v.loaderVersion ?? null,
        ramRecommendedMb: v.ramRecommendedMb ?? null,
        installable: v.mcVersion !== undefined && v.loader !== undefined,
      })),
    };
  }

  async resolve(ref: ModpackRef): Promise<ModpackResolution> {
    this.assertEnabled();
    const pack = await this.packOf(ref.packId);
    const version = await this.versionOf(ref.packId, ref.versionId);
    if (version.mcVersion === undefined || version.loader === undefined) {
      throw new AppError('E_VALIDATION', 'this FTB version has no loader the panel can install', {
        details: { reason: 'NO_LOADER', packId: ref.packId, versionId: ref.versionId },
      });
    }
    if (version.files.length > MAX_FETCH_MANY_FILES) {
      throw new AppError('E_VALIDATION', 'this modpack has too many files', {
        details: { reason: 'TOO_MANY_FILES', files: version.files.length },
      });
    }
    const label = `${pack.name} ${version.name}`;
    return {
      label,
      loader: version.loader,
      mcVersion: version.mcVersion,
      loaderVersion: version.loaderVersion,
      files: {
        kind: 'fetchMany',
        label,
        concurrency: FETCH_MANY_CONCURRENCY_DEFAULT,
        files: version.files.map((f) => ({
          path: f.path,
          url: f.url,
          ...(f.mirrors.length === 0 ? {} : { mirrors: f.mirrors }),
          sha1: f.sha1,
          size: f.size,
        })),
      },
    };
  }

  private fresh<T>(entry: Cached<T> | undefined): T | undefined {
    const ttl = this.deps.ttlMs ?? DEFAULT_TTL_MS;
    return entry !== undefined && this.deps.now() - entry.at < ttl ? entry.value : undefined;
  }

  private async packOf(packId: number): Promise<FtbPack> {
    const cached = this.fresh(this.packs.get(packId));
    if (cached) return cached;
    const json = await this.get(ftbPackUrl(packId));
    const value = this.parse(() => parseFtbPack(json));
    this.packs.set(packId, { at: this.deps.now(), value });
    return value;
  }

  private async versionOf(packId: number, versionId: number): Promise<FtbVersion> {
    const key = `${String(packId)}/${String(versionId)}`;
    const cached = this.versions.get(key);
    if (cached) return cached;
    const json = await this.get(ftbVersionUrl(packId, versionId));
    const value = this.parse(() => parseFtbVersion(json, packId));
    this.versions.set(key, value);
    // Borné : une liste de fichiers pèse plusieurs Mio.
    while (this.versions.size > VERSION_CACHE_SIZE) {
      const oldest = this.versions.keys().next().value;
      if (oldest === undefined) break;
      this.versions.delete(oldest);
    }
    return value;
  }

  private async get(url: string): Promise<unknown> {
    const res = await this.deps.fetcher.get(url, { timeoutMs: 20_000 }).catch((error: unknown) => {
      if (!(error instanceof PoliteFetchError)) throw error;
      throw new AppError('E_UNREACHABLE', 'the FTB catalog is unreachable', {
        retryable: true,
        details: {
          reason: 'CATALOG_UNREACHABLE',
          source: 'ftb',
          ...(error.retryInMs === undefined ? {} : { retryInMs: error.retryInMs }),
        },
      });
    });
    if (res.status === 404) {
      throw new AppError('E_NOT_FOUND', 'unknown FTB modpack or version', {
        details: { reason: 'UNKNOWN_MODPACK' },
      });
    }
    if (!res.ok) {
      throw new AppError('E_UNREACHABLE', 'the FTB catalog answered an error', {
        retryable: true,
        details: { reason: busyOrHttp(res.status), source: 'ftb', status: res.status },
      });
    }
    try {
      return JSON.parse(res.text) as unknown;
    } catch {
      throw new AppError('E_UNREACHABLE', 'ftb: not_json', {
        details: { reason: 'CATALOG_FORMAT', source: 'ftb', format: 'not_json' },
      });
    }
  }

  private parse<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof CatalogFormatError) {
        throw new AppError('E_UNREACHABLE', `${error.source}: ${error.reason}`, {
          details: { reason: 'CATALOG_FORMAT', source: error.source, format: error.reason },
        });
      }
      throw error;
    }
  }
}
