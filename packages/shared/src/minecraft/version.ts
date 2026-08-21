/** Versions Minecraft : parsing tolérant et comparaison (releases `1.20.1`, pré-releases, snapshots). */

export interface McVersion {
  /** Texte d'origine. */
  id: string;
  /** Composantes numériques `[major, minor, patch]` pour une release/pré-release ; absent pour un snapshot `24w14a`. */
  parts: readonly [number, number, number] | undefined;
  /** `true` pour `1.21.2-pre1`, `1.21-rc1`, snapshots… */
  prerelease: boolean;
}

const RELEASE = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-_ ]?(pre|rc|snapshot)[\w.-]*)?$/i;
const SNAPSHOT = /^\d{2}w\d{2}[a-z]$/i;

export function parseMcVersion(id: string): McVersion | undefined {
  const trimmed = id.trim();
  const m = RELEASE.exec(trimmed);
  if (m) {
    return {
      id: trimmed,
      parts: [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')],
      prerelease: m[4] !== undefined,
    };
  }
  if (SNAPSHOT.test(trimmed)) return { id: trimmed, parts: undefined, prerelease: true };
  return undefined;
}

/** Compare deux versions release ; `undefined` si l'une n'est pas comparable (snapshot, inconnue). */
export function compareMcVersions(a: string, b: string): number | undefined {
  const pa = parseMcVersion(a)?.parts;
  const pb = parseMcVersion(b)?.parts;
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `a >= min && a < max` (bornes sous forme de versions, `max` exclusive et optionnelle). */
export function mcVersionInRange(version: string, min: string, max?: string): boolean | undefined {
  const lo = compareMcVersions(version, min);
  if (lo === undefined) return undefined;
  if (lo < 0) return false;
  if (max === undefined) return true;
  const hi = compareMcVersions(version, max);
  return hi === undefined ? undefined : hi < 0;
}

/** Version MC « canonique » (`1.21` → `1.21`, `1.21.0` → `1.21`), pour comparer des sources hétérogènes. */
export function normalizeMcVersion(id: string): string {
  const v = parseMcVersion(id);
  if (!v?.parts || v.prerelease) return id.trim();
  const [major, minor, patch] = v.parts;
  return patch === 0
    ? `${String(major)}.${String(minor)}`
    : `${String(major)}.${String(minor)}.${String(patch)}`;
}
