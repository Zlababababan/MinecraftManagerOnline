/**
 * Modpacks FTB (Feed The Beast) — constructeurs d'URL et lecteurs **purs**, sur le modèle de
 * `catalogs.ts` : aucune requête réseau ici, le panel fait les appels et met en cache.
 *
 * **Partie retirable** : FTB est une intégration optionnelle (réglage `modpacks.ftb.enabled`), et
 * tout ce qui la concerne vit dans des fichiers à part pour qu'on puisse l'enlever en entier —
 * la liste est dans `docs/services-tiers.md`.
 *
 * Mesures (doc 06 §6quinquies, 2026-09-28) : l'ancienne API `api.modpacks.ch` est figée ; seule la
 * v1 `api.feed-the-beast.com` connaît les versions récentes. Une version donne la liste complète
 * de ses fichiers (URL + sha1 + taille), recoupée à l'identique avec une installation faite par
 * l'installeur officiel.
 */
import { CatalogFormatError } from './catalogs.js';

export const FTB_API_BASE = 'https://api.feed-the-beast.com/v1/modpacks/public/modpack';

export const ftbSearchUrl = (term: string, limit: number): string =>
  `${FTB_API_BASE}/search/${String(limit)}?term=${encodeURIComponent(term)}`;
export const ftbPopularUrl = (limit: number): string =>
  `${FTB_API_BASE}/popular/installs/${String(limit)}`;
export const ftbPackUrl = (packId: number): string => `${FTB_API_BASE}/${String(packId)}`;
export const ftbVersionUrl = (packId: number, versionId: number): string =>
  `${FTB_API_BASE}/${String(packId)}/${String(versionId)}`;

/** Chargeurs qu'un pack FTB peut exiger et que le panel sait installer. */
export type FtbLoader = 'forge' | 'neoforge' | 'fabric';
const FTB_LOADERS = new Set<string>(['forge', 'neoforge', 'fabric']);

export interface FtbVersionSummary {
  id: number;
  name: string;
  /** `release`, `beta`, `alpha`… tel que FTB le publie. */
  type: string;
  /** Epoch ms ; 0 si inconnu. */
  releasedAt: number;
  mcVersion: string | undefined;
  loader: FtbLoader | undefined;
  loaderVersion: string | undefined;
  /** Mémoire conseillée par l'auteur du pack (Mio) — FTB écrit parfois « 8092 », tel quel. */
  ramMinMb: number | undefined;
  ramRecommendedMb: number | undefined;
}

export interface FtbPack {
  id: number;
  name: string;
  synopsis: string;
  /** Versions, la plus récente d'abord. */
  versions: FtbVersionSummary[];
}

export interface FtbFile {
  /** Chemin relatif au dossier du serveur, `/` comme séparateur. */
  path: string;
  url: string;
  mirrors: string[];
  sha1: string;
  size: number;
}

export interface FtbVersion extends FtbVersionSummary {
  packId: number;
  /** Fichiers à poser côté serveur (les `clientonly` sont écartés). */
  files: FtbFile[];
  /** Nombre de fichiers `clientonly` écartés (pour le journal). */
  clientOnly: number;
}

interface RawTarget {
  name?: unknown;
  version?: unknown;
  type?: unknown;
}
interface RawVersion {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  released?: unknown;
  updated?: unknown;
  targets?: unknown;
  specs?: unknown;
  files?: unknown;
}
interface RawFile {
  path?: unknown;
  name?: unknown;
  url?: unknown;
  mirrors?: unknown;
  sha1?: unknown;
  size?: unknown;
  clientonly?: unknown;
}

function obj(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CatalogFormatError(source, 'not_an_object');
  }
  return value as Record<string, unknown>;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
function positive(value: unknown): number | undefined {
  const n = int(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/** `search` et `popular` → identifiants de packs FTB (les résultats CurseForge sont ignorés). */
export function parseFtbPackIds(json: unknown): number[] {
  const packs = obj(json, 'ftb.search').packs;
  if (!Array.isArray(packs)) throw new CatalogFormatError('ftb.search', 'no_packs');
  return packs.flatMap((p) => {
    const id = positive(p);
    return id === undefined ? [] : [id];
  });
}

function summary(raw: RawVersion): FtbVersionSummary | undefined {
  const id = positive(raw.id);
  const name = str(raw.name);
  if (id === undefined || name === undefined) return undefined;
  const targets = Array.isArray(raw.targets) ? (raw.targets as RawTarget[]) : [];
  let mcVersion: string | undefined;
  let loader: FtbLoader | undefined;
  let loaderVersion: string | undefined;
  for (const t of targets) {
    const tname = str(t.name);
    if (tname === 'minecraft') mcVersion = str(t.version);
    else if (tname !== undefined && FTB_LOADERS.has(tname)) {
      loader = tname as FtbLoader;
      loaderVersion = str(t.version);
    }
  }
  const seconds = int(raw.released) ?? int(raw.updated) ?? 0;
  const specs = (typeof raw.specs === 'object' && raw.specs !== null ? raw.specs : {}) as {
    minimum?: unknown;
    recommended?: unknown;
  };
  return {
    id,
    name,
    type: str(raw.type) ?? 'release',
    releasedAt: seconds * 1000,
    mcVersion,
    loader,
    loaderVersion,
    ramMinMb: positive(specs.minimum),
    ramRecommendedMb: positive(specs.recommended),
  };
}

/** Détail d'un pack → nom, présentation et versions (la plus récente d'abord). */
export function parseFtbPack(json: unknown): FtbPack {
  const raw = obj(json, 'ftb.pack');
  const id = positive(raw.id);
  const name = str(raw.name);
  if (id === undefined || name === undefined) throw new CatalogFormatError('ftb.pack', 'no_id');
  const versions = (Array.isArray(raw.versions) ? (raw.versions as RawVersion[]) : [])
    .flatMap((v) => {
      const s = summary(v);
      return s === undefined ? [] : [s];
    })
    // FTB publie la plus ancienne d'abord ; l'identifiant croît avec le temps.
    .sort((a, b) => b.releasedAt - a.releasedAt || b.id - a.id);
  return { id, name, synopsis: str(raw.synopsis) ?? '', versions };
}

/**
 * Chemin relatif sûr, ou `undefined`. FTB publie `path: "./mods"` + `name` ; un chemin absolu ou
 * qui remonte (`..`) est une réponse inexploitable, jamais un fichier à poser.
 */
function safePath(dir: string, name: string): string | undefined {
  const joined = `${dir}/${name}`.replace(/\\/g, '/').replace(/\/+/g, '/');
  const parts = joined.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return undefined;
  if (joined.startsWith('/') && !dir.startsWith('./')) return undefined;
  if (/^[A-Za-z]:/.test(parts[0] ?? '')) return undefined;
  return parts.join('/');
}

/** Détail d'une version → cibles, mémoire conseillée et fichiers côté serveur, tous vérifiables. */
export function parseFtbVersion(json: unknown, packId: number): FtbVersion {
  const raw = obj(json, 'ftb.version') as RawVersion;
  const base = summary(raw);
  if (base === undefined) throw new CatalogFormatError('ftb.version', 'no_id');
  if (!Array.isArray(raw.files)) throw new CatalogFormatError('ftb.version', 'no_files');
  const files: FtbFile[] = [];
  const seen = new Set<string>();
  let clientOnly = 0;
  for (const f of raw.files as RawFile[]) {
    if (f.clientonly === true) {
      clientOnly++;
      continue;
    }
    const name = str(f.name);
    const url = str(f.url);
    const sha1 = str(f.sha1)?.toLowerCase();
    const size = int(f.size);
    if (name === undefined || url === undefined || sha1?.length !== 40 || size === undefined) {
      throw new CatalogFormatError(
        'ftb.version',
        'incomplete_file',
        `ftb.version: incomplete_file (${String(name)})`,
      );
    }
    const path = safePath(str(f.path) ?? '.', name);
    if (path === undefined) throw new CatalogFormatError('ftb.version', 'unsafe_path');
    // Deux fichiers au même chemin (casse ignorée, pour Windows) : le second écraserait le premier.
    const key = path.toLowerCase();
    if (seen.has(key)) throw new CatalogFormatError('ftb.version', 'duplicate_path');
    seen.add(key);
    const mirrors = Array.isArray(f.mirrors)
      ? f.mirrors.flatMap((m) => {
          const u = str(m);
          return u === undefined ? [] : [u];
        })
      : [];
    files.push({ path, url, mirrors: mirrors.slice(0, 4), sha1, size });
  }
  return {
    ...base,
    packId,
    files,
    clientOnly,
  };
}
