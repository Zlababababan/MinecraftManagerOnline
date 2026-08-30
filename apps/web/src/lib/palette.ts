/**
 * Recherche de la palette de commandes. Logique pure, testable sans monter de composant.
 *
 * Volontairement simple : sous-chaîne insensible à la casse et aux accents, classée par « le
 * libellé commence par la saisie » puis « le libellé la contient ». Pas de correspondance floue —
 * sur un parc de 53 serveurs aux noms proches (ATM10, ATM10Aero…), un algorithme approximatif
 * remonte surtout du bruit, et une palette qui propose le mauvais serveur est pire qu'inutile.
 */
export interface PaletteItem {
  id: string;
  /** Ce qui est cherché et affiché. */
  label: string;
  /** Deuxième ligne : machine, chemin, catégorie… également cherchée. */
  hint?: string;
  group: 'action' | 'server' | 'machine';
}

/** Minuscules sans accents ni diacritiques : « Forêt » se trouve en tapant « foret ». */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '');
}

function score(item: PaletteItem, needle: string): number {
  const label = normalize(item.label);
  const hint = item.hint === undefined ? '' : normalize(item.hint);
  if (label.startsWith(needle)) return 0;
  if (label.includes(needle)) return 1;
  if (hint.startsWith(needle)) return 2;
  if (hint.includes(needle)) return 3;
  return -1;
}

/** Les actions d'abord quand rien n'est saisi : la palette sert surtout à naviguer. */
const GROUP_ORDER: Record<PaletteItem['group'], number> = { action: 0, server: 1, machine: 2 };

export function searchPalette(
  items: readonly PaletteItem[],
  query: string,
  limit = 12,
): PaletteItem[] {
  const needle = normalize(query.trim());
  if (needle === '') {
    return [...items].sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]).slice(0, limit);
  }
  return items
    .map((item) => ({ item, rank: score(item, needle) }))
    .filter((x) => x.rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        GROUP_ORDER[a.item.group] - GROUP_ORDER[b.item.group] ||
        a.item.label.localeCompare(b.item.label, undefined, { numeric: true }),
    )
    .slice(0, limit)
    .map((x) => x.item);
}

/** Déplacement dans la liste, en boucle : la flèche bas sur le dernier revient au premier. */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}
