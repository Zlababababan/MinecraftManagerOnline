/**
 * Catalogues de versions installables (lot 5, première moitié : vanilla et Fabric — les deux
 * familles qui n'exigent aucun installeur tiers). Sur le modèle exact des fournisseurs de JRE
 * (`java/providers.ts`) : **constructeurs d'URL et parseurs purs, aucune requête réseau**. Le panel
 * fait les appels, met en cache et construit le plan envoyé à l'agent (`server.install.steps`).
 *
 * Deux sources, et rien d'autre :
 *
 * - **Vanilla** : le manifest Mojang, déjà téléchargé et caché par le panel pour le mapping
 *   MC → Java (`java/index.ts`). Le détail d'une version porte `downloads.server` avec son sha1 et
 *   sa taille : une seule étape de téléchargement, vérifiable.
 * - **Fabric** : `meta.fabricmc.net`. Le jar servi par `…/server/jar` n'est PAS un installeur mais
 *   un **lanceur** : il télécharge lui-même le serveur vanilla et les bibliothèques, puis démarre
 *   le serveur (mesuré, doc 06 §6ter). D'où l'invariant de l'exécuteur : l'exécuter AVANT d'écrire
 *   `eula.txt`, faute de quoi il ne s'arrêterait pas.
 *
 * Toute réponse de forme inattendue lève une `CatalogFormatError` nommée (source + raison) : c'est
 * une panne du fournisseur, pas un bug d'appelant, et l'UI doit pouvoir le dire.
 */

/** Réponse d'un fournisseur inexploitable ; `reason` remonte en `details.reason` côté panel. */
export class CatalogFormatError extends Error {
  constructor(
    readonly source: string,
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? `${source}: ${reason}`);
    this.name = 'CatalogFormatError';
  }
}

function asArray(json: unknown, source: string): unknown[] {
  if (!Array.isArray(json)) throw new CatalogFormatError(source, 'not_an_array');
  return json;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// --- Vanilla (manifest Mojang) --------------------------------------------------------------------

export type McVersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha';

export interface McVersionEntry {
  id: string;
  type: McVersionType;
  /** URL du détail de version (porte `downloads.server`). */
  url: string;
  /** Date de publication (epoch ms) ; 0 si absente ou illisible. */
  releasedAt: number;
}

interface RawManifest {
  latest?: { release?: unknown; snapshot?: unknown };
  versions?: unknown;
}
interface RawVersion {
  id?: unknown;
  type?: unknown;
  url?: unknown;
  releaseTime?: unknown;
}

const VERSION_TYPES = new Set<string>(['release', 'snapshot', 'old_beta', 'old_alpha']);

/**
 * Manifest Mojang (`version_manifest_v2.json`) → liste ordonnée telle que Mojang la publie (la plus
 * récente d'abord). Les entrées illisibles sont écartées ; un manifest sans aucune version est une
 * erreur (le fournisseur a changé de forme).
 */
export function parseMcVersionManifest(json: unknown): {
  latestRelease: string | undefined;
  latestSnapshot: string | undefined;
  versions: McVersionEntry[];
} {
  const raw = json as RawManifest | null;
  const list = asArray(raw?.versions, 'mojang.manifest');
  const versions: McVersionEntry[] = [];
  for (const item of list as RawVersion[]) {
    const id = str(item.id);
    const url = str(item.url);
    const type = str(item.type);
    if (id === undefined || url === undefined || type === undefined) continue;
    if (!VERSION_TYPES.has(type)) continue;
    const time = str(item.releaseTime);
    const releasedAt = time === undefined ? 0 : Date.parse(time);
    versions.push({
      id,
      type: type as McVersionType,
      url,
      releasedAt: Number.isNaN(releasedAt) ? 0 : releasedAt,
    });
  }
  if (versions.length === 0) throw new CatalogFormatError('mojang.manifest', 'no_versions');
  return {
    latestRelease: str(raw?.latest?.release),
    latestSnapshot: str(raw?.latest?.snapshot),
    versions,
  };
}

export interface McServerDownload {
  url: string;
  sha1: string;
  size: number;
  /** `javaVersion.majorVersion` du détail — la source de vérité du mapping MC → Java. */
  javaMajor: number | undefined;
}

/**
 * Détail d'une version → téléchargement du serveur. Les versions antérieures à 1.2.5 n'ont pas de
 * `downloads.server` : ce n'est pas une panne du fournisseur mais une version non installable, et
 * la raison le dit (`no_server_download`).
 */
export function parseMcVersionDetail(json: unknown): McServerDownload {
  const detail = json as
    | {
        downloads?: { server?: { url?: unknown; sha1?: unknown; size?: unknown } };
        javaVersion?: { majorVersion?: unknown };
      }
    | null
    | undefined;
  const server = detail?.downloads?.server;
  const url = str(server?.url);
  if (url === undefined) throw new CatalogFormatError('mojang.version', 'no_server_download');
  const sha1 = str(server?.sha1)?.toLowerCase();
  if (sha1 === undefined || !/^[0-9a-f]{40}$/.test(sha1)) {
    throw new CatalogFormatError('mojang.version', 'bad_sha1');
  }
  const size = server?.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    throw new CatalogFormatError('mojang.version', 'bad_size');
  }
  const major = detail?.javaVersion?.majorVersion;
  return {
    url,
    sha1,
    size,
    javaMajor: typeof major === 'number' && major > 0 ? major : undefined,
  };
}

// --- Fabric (meta.fabricmc.net) -------------------------------------------------------------------

export const FABRIC_META = 'https://meta.fabricmc.net/v2';

/** Versions de jeu supportées par Fabric. */
export function fabricGameUrl(): string {
  return `${FABRIC_META}/versions/game`;
}
/** Versions de loader compatibles avec une version de jeu (la plus récente d'abord). */
export function fabricLoaderUrl(mcVersion: string): string {
  return `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`;
}
/** Versions de l'installeur (dont dérive le lanceur serveur). */
export function fabricInstallerUrl(): string {
  return `${FABRIC_META}/versions/installer`;
}
/** Lanceur serveur prêt à l'emploi pour un triplet (jeu, loader, installeur). */
export function fabricServerJarUrl(
  mcVersion: string,
  loaderVersion: string,
  installerVersion: string,
): string {
  return `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(
    loaderVersion,
  )}/${encodeURIComponent(installerVersion)}/server/jar`;
}

/**
 * Nom de fichier du lanceur. Ce n'est pas cosmétique : la détection (doc 06 §2) lit le triplet
 * dans ce nom (`FABRIC_MC_LAUNCHER`) et en tire loader, version de jeu et version de loader avec
 * une confiance haute — un autre nom perdrait cette information.
 */
export function fabricServerJarName(
  mcVersion: string,
  loaderVersion: string,
  installerVersion: string,
): string {
  return `fabric-server-mc.${mcVersion}-loader.${loaderVersion}-launcher.${installerVersion}.jar`;
}

export interface FabricVersion {
  version: string;
  stable: boolean;
}

/** `GET /v2/versions/game` — `[{ version, stable }]`. */
export function parseFabricGameVersions(json: unknown): FabricVersion[] {
  return parseFabricList(json, 'fabric.game');
}

/** `GET /v2/versions/installer` — même forme, plus une `url` dont on n'a pas besoin. */
export function parseFabricInstallers(json: unknown): FabricVersion[] {
  return parseFabricList(json, 'fabric.installer');
}

function parseFabricList(json: unknown, source: string): FabricVersion[] {
  const out: FabricVersion[] = [];
  for (const item of asArray(json, source) as { version?: unknown; stable?: unknown }[]) {
    const version = str(item.version);
    if (version === undefined) continue;
    out.push({ version, stable: item.stable === true });
  }
  if (out.length === 0) throw new CatalogFormatError(source, 'no_versions');
  return out;
}

export interface FabricLoaderVersion extends FabricVersion {
  /** `launcherMeta.min_java_version` : Java minimal exigé par ce loader (information). */
  minJavaVersion: number | undefined;
}

/**
 * `GET /v2/versions/loader/<mc>` — `[{ loader: { version, stable }, launcherMeta: {…} }]`. La
 * réponse est **vide** (et non une erreur) pour une version de jeu que Fabric ne supporte pas :
 * l'appelant traduit ce vide en « pas de loader pour cette version ».
 */
export function parseFabricLoaders(json: unknown): FabricLoaderVersion[] {
  const out: FabricLoaderVersion[] = [];
  for (const item of asArray(json, 'fabric.loader') as {
    loader?: { version?: unknown; stable?: unknown };
    launcherMeta?: { min_java_version?: unknown };
  }[]) {
    const version = str(item.loader?.version);
    if (version === undefined) continue;
    const min = item.launcherMeta?.min_java_version;
    out.push({
      version,
      stable: item.loader?.stable === true,
      minJavaVersion: typeof min === 'number' && min > 0 ? min : undefined,
    });
  }
  return out;
}

/**
 * Choix par défaut dans une liste de versions : la première **stable**, à défaut la première tout
 * court (les API Fabric publient la plus récente en tête). `undefined` sur une liste vide.
 */
export function pickStable<T extends { stable: boolean }>(versions: readonly T[]): T | undefined {
  return versions.find((v) => v.stable) ?? versions[0];
}
