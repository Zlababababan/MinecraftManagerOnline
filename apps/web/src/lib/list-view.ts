/**
 * Préférences d'affichage d'une liste : mode (cartes ou tableau), tri et sens du tri.
 *
 * Elles sont MÉMORISÉES par appareil (localStorage), pas par compte : « je veux les cartes sur
 * mon téléphone et le tableau sur le PC » est un besoin d'appareil, pas d'identité. Elles ne
 * voyagent donc pas vers le panel, et leur perte n'empêche jamais d'afficher la liste — une
 * fenêtre privée, un stockage bloqué ou une valeur écrite à la main retombent sur le défaut.
 *
 * Le FILTRE, lui, reste dans l'URL (voir `server-filter.ts`) : il se met en favori et se partage,
 * là où « cartes ou tableau » ne regarde que celui qui regarde.
 */
import { useState } from 'react';

export const LIST_MODES = ['cards', 'table'] as const;
export type ListMode = (typeof LIST_MODES)[number];

export interface ListPrefs {
  mode: ListMode;
  sort: string;
  desc: boolean;
}

/** Le tri est propre à chaque liste : la page fournit son propre validateur. */
export type SortGuard = (value: unknown) => boolean;

const STORAGE_PREFIX = 'mmo-list-';

export function isListMode(value: unknown): value is ListMode {
  return typeof value === 'string' && (LIST_MODES as readonly string[]).includes(value);
}

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

/** Ce qu'on peut trouver en stockage : tout est inconnu tant qu'on ne l'a pas vérifié. */
interface StoredPrefs {
  mode?: unknown;
  sort?: unknown;
  desc?: unknown;
}

/**
 * Lecture tolérante champ par champ : une préférence illisible n'en emporte pas d'autre, et
 * un tri retiré du code (renommé, supprimé) retombe sur le défaut au lieu de trier sur rien.
 */
export function readListPrefs(key: string, fallback: ListPrefs, isSort: SortGuard): ListPrefs {
  let raw: string | null;
  try {
    raw = globalThis.localStorage.getItem(storageKey(key));
  } catch {
    // Stockage refusé (fenêtre privée, cookies tiers bloqués) : la liste s'affiche quand même.
    return fallback;
  }
  if (raw === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback;
  const stored = parsed as StoredPrefs;
  return {
    mode: isListMode(stored.mode) ? stored.mode : fallback.mode,
    sort: typeof stored.sort === 'string' && isSort(stored.sort) ? stored.sort : fallback.sort,
    desc: typeof stored.desc === 'boolean' ? stored.desc : fallback.desc,
  };
}

export function writeListPrefs(key: string, prefs: ListPrefs): void {
  try {
    globalThis.localStorage.setItem(storageKey(key), JSON.stringify(prefs));
  } catch {
    // Une préférence d'affichage non mémorisée ne mérite ni erreur ni notification.
  }
}

/**
 * État de vue d'une liste. L'écriture se fait à la MODIFICATION (un clic), jamais dans une
 * fonction de mise à jour de `setState` — celle-ci peut courir deux fois en mode strict.
 */
export function useListPrefs(
  key: string,
  fallback: ListPrefs,
  isSort: SortGuard,
): readonly [ListPrefs, (patch: Partial<ListPrefs>) => void] {
  const [prefs, setPrefs] = useState<ListPrefs>(() => readListPrefs(key, fallback, isSort));
  const update = (patch: Partial<ListPrefs>): void => {
    const next: ListPrefs = { ...prefs, ...patch };
    writeListPrefs(key, next);
    setPrefs(next);
  };
  return [prefs, update] as const;
}
