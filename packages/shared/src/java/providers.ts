/**
 * Fournisseurs de JRE (doc 03 §4, matrice vérifiée le 2026-08-21) : **Temurin** (api.adoptium.net)
 * → **Azul Zulu** (Java 8 macOS ARM, Java 17 Windows ARM) → **build x64 sous émulation** (Java 8
 * Windows ARM, introuvable ailleurs). Un 404 de l'API = combo indisponible (cas normal) : on passe
 * au suivant. Fonctions pures (URLs + interprétation des réponses) ; le panel fait les appels réseau
 * et construit la chaîne ordonnée envoyée à l'agent (`java.install.sources`).
 */
import type { JavaSource } from '@mmo/protocol';

export type JavaOs = 'windows' | 'linux' | 'macos';
export type JavaArch = 'x64' | 'arm64';

export interface JavaCandidate {
  vendor: 'temurin' | 'zulu';
  os: JavaOs;
  arch: JavaArch;
  /** Architecture réellement demandée au fournisseur (x64 sous émulation sur ARM). */
  emulated: boolean;
  /** URL de métadonnées à interroger (JSON). */
  metadataUrl: string;
}

/** Chaîne de candidats dans l'ordre de préférence pour une plateforme. */
export function javaCandidates(major: number, os: JavaOs, arch: JavaArch): JavaCandidate[] {
  const out: JavaCandidate[] = [
    {
      vendor: 'temurin',
      os,
      arch,
      emulated: false,
      metadataUrl: temurinMetadataUrl(major, os, arch),
    },
    { vendor: 'zulu', os, arch, emulated: false, metadataUrl: zuluMetadataUrl(major, os, arch) },
  ];
  if (arch === 'arm64') {
    // Émulation x64 (Windows ARM : Prism ; macOS : Rosetta 2) — dernier recours.
    out.push(
      {
        vendor: 'temurin',
        os,
        arch: 'x64',
        emulated: true,
        metadataUrl: temurinMetadataUrl(major, os, 'x64'),
      },
      {
        vendor: 'zulu',
        os,
        arch: 'x64',
        emulated: true,
        metadataUrl: zuluMetadataUrl(major, os, 'x64'),
      },
    );
  }
  return out;
}

export function archiveFor(os: JavaOs): 'zip' | 'tar.gz' {
  return os === 'windows' ? 'zip' : 'tar.gz';
}

// --- Temurin (Adoptium) ---------------------------------------------------------------------------

export const ADOPTIUM_API = 'https://api.adoptium.net/v3';

function temurinOs(os: JavaOs): string {
  return os === 'macos' ? 'mac' : os;
}
function temurinArch(arch: JavaArch): string {
  return arch === 'arm64' ? 'aarch64' : 'x64';
}

/** `GET …/assets/latest/{major}/hotspot?os=&architecture=&image_type=jre&vendor=eclipse`. */
export function temurinMetadataUrl(major: number, os: JavaOs, arch: JavaArch): string {
  const q = new URLSearchParams({
    os: temurinOs(os),
    architecture: temurinArch(arch),
    image_type: 'jre',
    vendor: 'eclipse',
  });
  return `${ADOPTIUM_API}/assets/latest/${String(major)}/hotspot?${q.toString()}`;
}

interface TemurinAsset {
  binary?: {
    os?: string;
    architecture?: string;
    image_type?: string;
    package?: { link?: string; checksum?: string; size?: number; name?: string };
  };
  version?: { semver?: string; openjdk_version?: string };
  release_name?: string;
}

/** Interprète la réponse de l'API Adoptium (tableau d'assets) ; `undefined` si rien d'exploitable. */
export function parseTemurinAssets(
  json: unknown,
  os: JavaOs,
  emulated: boolean,
): JavaSource | undefined {
  if (!Array.isArray(json)) return undefined;
  for (const a of json as TemurinAsset[]) {
    const pkg = a.binary?.package;
    if (a.binary?.image_type !== 'jre' || pkg?.link === undefined) continue;
    const sha = pkg.checksum?.toLowerCase();
    return {
      vendor: 'temurin',
      url: pkg.link,
      archive: archiveFor(os),
      ...(sha !== undefined && sha.length === 64 ? { sha256: sha } : {}),
      ...(typeof pkg.size === 'number' ? { size: pkg.size } : {}),
      emulated,
      relay: false,
      ...(a.version?.openjdk_version === undefined
        ? {}
        : { fullVersion: a.version.openjdk_version }),
    };
  }
  return undefined;
}

// --- Azul Zulu ------------------------------------------------------------------------------------

export const ZULU_API = 'https://api.azul.com/metadata/v1/zulu/packages/';

function zuluOs(os: JavaOs): string {
  return os === 'macos' ? 'macos' : os;
}
function zuluArch(arch: JavaArch): string {
  return arch === 'arm64' ? 'arm' : 'x86';
}

/** `GET …/packages/?java_version=&os=&arch=&hw_bitness=64&archive_type=&java_package_type=jre&latest=true`. */
export function zuluMetadataUrl(major: number, os: JavaOs, arch: JavaArch): string {
  const q = new URLSearchParams({
    java_version: String(major),
    os: zuluOs(os),
    arch: zuluArch(arch),
    hw_bitness: '64',
    archive_type: archiveFor(os),
    java_package_type: 'jre',
    javafx_bundled: 'false',
    release_status: 'ga',
    availability_types: 'CA',
    latest: 'true',
    page_size: '5',
  });
  return `${ZULU_API}?${q.toString()}`;
}

interface ZuluPackage {
  package_uuid?: string;
  name?: string;
  download_url?: string;
  java_version?: number[];
  sha256_hash?: string;
  size?: number;
}

/** Interprète la liste Zulu ; le sha256 n'est fourni que par le détail `…/packages/{uuid}` (`sha256_hash`). */
export function parseZuluPackages(
  json: unknown,
  os: JavaOs,
  emulated: boolean,
): (JavaSource & { packageUuid?: string }) | undefined {
  if (!Array.isArray(json)) return undefined;
  for (const p of json as ZuluPackage[]) {
    if (p.download_url === undefined) continue;
    const sha = p.sha256_hash?.toLowerCase();
    return {
      vendor: 'zulu',
      url: p.download_url,
      archive: archiveFor(os),
      ...(sha !== undefined && sha.length === 64 ? { sha256: sha } : {}),
      ...(typeof p.size === 'number' ? { size: p.size } : {}),
      emulated,
      relay: false,
      ...(p.java_version === undefined ? {} : { fullVersion: p.java_version.join('.') }),
      ...(p.package_uuid === undefined ? {} : { packageUuid: p.package_uuid }),
    };
  }
  return undefined;
}

export function zuluPackageDetailUrl(uuid: string): string {
  return `${ZULU_API}${uuid}`;
}

/** Le détail d'un paquet Zulu porte `sha256_hash`. */
export function parseZuluDetail(json: unknown): string | undefined {
  const sha = (json as { sha256_hash?: unknown } | null)?.sha256_hash;
  return typeof sha === 'string' && sha.length === 64 ? sha.toLowerCase() : undefined;
}

// --- Versions génériques --------------------------------------------------------------------------

/** Compare deux versions `x.y.z[-pre]` (numérique par segment ; une pré-release est inférieure). */
export function compareVersions(a: string, b: string): number {
  const [ma, pa] = split(a);
  const [mb, pb] = split(b);
  for (let i = 0; i < Math.max(ma.length, mb.length); i++) {
    const d = (ma[i] ?? 0) - (mb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}

function split(v: string): [number[], string | undefined] {
  const clean = v.trim().replace(/^v/i, '');
  const dash = clean.indexOf('-');
  const main = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? undefined : clean.slice(dash + 1);
  return [main.split('.').map((p) => Number.parseInt(p, 10) || 0), pre];
}
