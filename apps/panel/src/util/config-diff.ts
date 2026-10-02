/**
 * Ce qui a changé EXACTEMENT dans un fichier de configuration, pour l'audit (demande de Yassin,
 * 02/10 : « il faudrait que tu puisses tout savoir dans les audits »). Avant, l'audit disait
 * seulement « server.properties modifié » : impossible de savoir quelle ligne, ni quelle valeur.
 *
 * - fichiers clé=valeur (`server.properties`, `eula.txt`…) : une entrée par clé, avant → après ;
 * - listes JSON (whitelist, ops, bannis) : éléments ajoutés et retirés ;
 * - tout autre texte : nombre de lignes ajoutées et retirées.
 *
 * Un secret (mot de passe RCON…) n'entre jamais dans l'audit : on note qu'il a changé, pas sa valeur.
 */

export interface KeyChange {
  from: string | null;
  to: string | null;
}

const SECRET_KEY = /pass(word)?|secret|token/i;
const MASK = '•••';
const MAX_VALUE = 200;
const MAX_ENTRIES = 100;

const clip = (value: string): string =>
  value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;

const shown = (key: string, value: string | null): string | null =>
  value === null ? null : SECRET_KEY.test(key) ? MASK : clip(value);

/** `clé=valeur` par ligne ; commentaires (`#`, `!`) et lignes vides ignorés. */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const at = trimmed.search(/[=:]/);
    if (at <= 0) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

const asRecord = (value: unknown): Record<string, string | null> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
};

/** Clés dont la valeur diffère entre deux états complets. */
export function diffKeyValues(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): Record<string, KeyChange> {
  const out: Record<string, KeyChange> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (from === to) continue;
    if (Object.keys(out).length >= MAX_ENTRIES) break;
    out[key] = { from: shown(key, from), to: shown(key, to) };
  }
  return out;
}

/** Un élément de liste, réduit à ce qui le nomme (un joueur = son pseudo). */
const label = (item: unknown): string => {
  if (typeof item === 'object' && item !== null && 'name' in item) {
    const { name } = item;
    if (typeof name === 'string') return name;
  }
  return clip(typeof item === 'string' ? item : JSON.stringify(item));
};

export type ConfigChanges =
  | { keys: Record<string, KeyChange> }
  | { added: string[]; removed: string[] }
  | undefined;

/**
 * `config.set` : `before` est le contenu lu juste avant, `data` ce qu'on envoie — un patch pour un
 * fichier clé=valeur (`null` = clé retirée), la liste complète pour un fichier JSON.
 */
export function configChanges(before: unknown, data: unknown): ConfigChanges {
  if (Array.isArray(data)) {
    const old = new Set((Array.isArray(before) ? before : []).map(label));
    const next = new Set(data.map(label));
    return {
      added: [...next].filter((x) => !old.has(x)).slice(0, MAX_ENTRIES),
      removed: [...old].filter((x) => !next.has(x)).slice(0, MAX_ENTRIES),
    };
  }
  const patch = asRecord(data);
  if (patch === undefined) return undefined;
  const old = asRecord(before) ?? {};
  // Un patch ne touche que ses clés : le reste du fichier est inchangé par construction.
  const scoped = Object.fromEntries(Object.keys(patch).map((k) => [k, old[k] ?? null]));
  return { keys: diffKeyValues(scoped, patch) };
}

const KEY_VALUE_FILE = /(\.properties|(^|\/)eula\.txt)$/i;

/** `fs.write` : ce qu'un enregistrement depuis l'explorateur de fichiers a changé. */
export function textChanges(
  path: string,
  before: string | undefined,
  after: string,
): Record<string, unknown> {
  if (before === undefined) return { created: true };
  if (KEY_VALUE_FILE.test(path)) {
    return { keys: diffKeyValues(parseKeyValues(before), parseKeyValues(after)) };
  }
  const count = (text: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const line of text.split(/\r?\n/)) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  let added = 0;
  let removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { linesAdded: added, linesRemoved: removed };
}
