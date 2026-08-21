/**
 * Mapping MC → Java (doc 03 §4) : manifest Mojang (`javaVersion.majorVersion`, caché côté panel),
 * table statique en repli hors-ligne, override par serveur toujours prioritaire.
 * Forge ≤ 1.16.5 : **strictement** Java 8.
 */
import type { Loader } from '@mmo/protocol';

import { compareMcVersions, parseMcVersion } from '../minecraft/version.js';

export interface JavaRequirement {
  majorVersion: number;
  /** `true` = exactement cette version (Forge ≤ 1.16.5 n'accepte que Java 8). */
  strict: boolean;
  source: 'override' | 'manifest' | 'table';
}

/** Table de repli : `[1.12,1.17)→8`, `[1.17,1.20.5)→17`, `[1.20.5,…)→21` ; avant 1.12 → 8 ; snapshot → 21. */
export const JAVA_FALLBACK_TABLE: readonly { min: string; major: number }[] = [
  { min: '1.20.5', major: 21 },
  { min: '1.17', major: 17 },
  { min: '0.0', major: 8 },
];

export function javaMajorFromTable(mcVersion: string): number {
  const parsed = parseMcVersion(mcVersion);
  if (!parsed?.parts) return 21; // snapshot ou inconnu : le plus récent
  for (const row of JAVA_FALLBACK_TABLE) {
    if ((compareMcVersions(mcVersion, row.min) ?? -1) >= 0) return row.major;
  }
  return 8;
}

/** Forge ≤ 1.16.5 ne tourne que sous Java 8 (doc 03 §4, doc 06 §1). */
export function isStrictJava8(loader: Loader | undefined, mcVersion: string): boolean {
  if (loader !== 'forge') return false;
  return (compareMcVersions(mcVersion, '1.17') ?? 0) < 0;
}

/** Résolution synchrone (table seule) — utilisée par la détection côté agent. */
export function javaRequirementFromTable(
  mcVersion: string,
  loader?: Loader,
  override?: number,
): JavaRequirement {
  if (override !== undefined) return { majorVersion: override, strict: false, source: 'override' };
  return {
    majorVersion: javaMajorFromTable(mcVersion),
    strict: isStrictJava8(loader, mcVersion),
    source: 'table',
  };
}

/** Source de vérité distante (manifest Mojang) — injectée par le panel, cachée par lui. */
export interface JavaVersionSource {
  lookup(mcVersion: string): Promise<number | undefined>;
}

/** Résolution complète : override → manifest → table. */
export async function resolveJavaRequirement(
  input: { mcVersion: string; loader?: Loader; override?: number },
  source?: JavaVersionSource,
): Promise<JavaRequirement> {
  if (input.override !== undefined) {
    return { majorVersion: input.override, strict: false, source: 'override' };
  }
  const strict = isStrictJava8(input.loader, input.mcVersion);
  if (source) {
    try {
      const major = await source.lookup(input.mcVersion);
      if (major !== undefined) {
        return { majorVersion: strict ? 8 : major, strict, source: 'manifest' };
      }
    } catch {
      // manifest indisponible : repli silencieux sur la table
    }
  }
  return { majorVersion: javaMajorFromTable(input.mcVersion), strict, source: 'table' };
}

// --- Manifest Mojang ------------------------------------------------------------------------------

export const MOJANG_VERSION_MANIFEST_URL =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

interface ManifestIndex {
  versions: { id: string; url: string }[];
}
interface VersionDetail {
  javaVersion?: { majorVersion?: number };
}

export interface MojangJavaSourceOptions {
  fetch?: typeof fetch;
  manifestUrl?: string;
  /** Durée de validité du manifest en cache (défaut 6 h). */
  manifestTtlMs?: number;
  now?: () => number;
}

/**
 * Source manifest Mojang : une requête pour l'index (cachée), une par version détaillée (cachée
 * indéfiniment — une version publiée ne change plus). Toute erreur réseau → `undefined`.
 */
export function createMojangJavaSource(options: MojangJavaSourceOptions = {}): JavaVersionSource {
  const doFetch = options.fetch ?? globalThis.fetch;
  const manifestUrl = options.manifestUrl ?? MOJANG_VERSION_MANIFEST_URL;
  const ttl = options.manifestTtlMs ?? 6 * 3_600_000;
  const now = options.now ?? (() => Date.now());
  let index: { fetchedAt: number; byId: Map<string, string> } | undefined;
  const majors = new Map<string, number | undefined>();

  async function loadIndex(): Promise<Map<string, string>> {
    if (index && now() - index.fetchedAt < ttl) return index.byId;
    const res = await doFetch(manifestUrl);
    if (!res.ok) throw new Error(`manifest HTTP ${String(res.status)}`);
    const json = (await res.json()) as ManifestIndex;
    const byId = new Map(json.versions.map((v) => [v.id, v.url] as const));
    index = { fetchedAt: now(), byId };
    return byId;
  }

  return {
    async lookup(mcVersion) {
      if (majors.has(mcVersion)) return majors.get(mcVersion);
      const byId = await loadIndex();
      const url = byId.get(mcVersion);
      if (!url) return undefined;
      const res = await doFetch(url);
      if (!res.ok) throw new Error(`version detail HTTP ${String(res.status)}`);
      const detail = (await res.json()) as VersionDetail;
      const major = detail.javaVersion?.majorVersion;
      majors.set(mcVersion, major);
      return major;
    },
  };
}
