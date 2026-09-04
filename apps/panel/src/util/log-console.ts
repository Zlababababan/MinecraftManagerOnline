/**
 * Rendu lisible du journal sur la CONSOLE (remonté à l'usage, 2026-09-04 : « les logs du panel ne
 * sont pas très lisibles »). Le panel logge en NDJSON pino — parfait pour un outil, illisible pour
 * quelqu'un qui regarde une fenêtre :
 *
 *   {"level":30,"time":1788553749588,"pid":18028,"hostname":"DESKTOP-TD36MUO","msg":"panel ready"}
 *   22:49:09  INFO  panel ready  users=1 dataDir=E:\mmo-panel\data
 *
 * Deux règles, et elles décident de tout :
 *
 * 1. **Le fichier garde le NDJSON.** Il est lu par `mmo-panel report`, masqué, joint à un
 *    signalement : c'est une donnée, pas un affichage. Seule la console change.
 * 2. **Seul un vrai terminal reçoit le texte.** Redirigé vers un fichier, piloté par systemd ou
 *    Docker, le panel continue d'émettre du NDJSON — sinon on casserait ce que ces outils parsent.
 *
 * L'agent rend déjà ses lignes lisibles (`formatEntry`) ; le panel était resté en arrière, et cette
 * fonction lui donne le même genre de ligne : l'heure, le niveau, le message, puis le reste.
 */

/** Champs de plomberie de pino : ils n'apprennent rien à qui lit une fenêtre. */
const NOISE = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'v']);

const LEVELS: Readonly<Record<number, string>> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/** ANSI par niveau ; vide quand la couleur n'est pas voulue (`NO_COLOR`, sortie redirigée). */
const COLORS: Readonly<Record<string, string>> = {
  TRACE: '\u001b[90m',
  DEBUG: '\u001b[90m',
  INFO: '\u001b[36m',
  WARN: '\u001b[33m',
  ERROR: '\u001b[31m',
  FATAL: '\u001b[35m',
};
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

export interface ConsoleFormatOptions {
  /** Couleurs ANSI (défaut : non — l'appelant sait s'il écrit dans un terminal). */
  color?: boolean;
  /** Horloge du rendu, pour les tests. */
  timeZone?: string;
}

/**
 * Une ligne NDJSON pino → une ligne lisible. Rend `undefined` si l'entrée n'est pas du JSON
 * d'objet : la ligne est alors recopiée telle quelle (une trace, un avertissement de Node, tout ce
 * qui n'est pas passé par le logger — la perdre serait pire que la laisser brute).
 */
export function formatConsoleLine(
  line: string,
  options: ConsoleFormatOptions = {},
): string | undefined {
  const trimmed = line.trimEnd();
  if (trimmed === '' || !trimmed.startsWith('{')) return undefined;
  let entry: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    entry = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const msg = entry.msg;
  if (typeof msg !== 'string') return undefined;

  const color = options.color === true;
  const levelNum = typeof entry.level === 'number' ? entry.level : 30;
  const level = LEVELS[levelNum] ?? String(levelNum);
  const time = formatTime(entry.time, options.timeZone);
  const rest = describeRest(entry);

  const paint = (text: string, ansi: string): string => (color ? `${ansi}${text}${RESET}` : text);
  const head = `${paint(time, DIM)} ${paint(level.padEnd(5), COLORS[level] ?? '')}`;
  return rest === '' ? `${head} ${msg}` : `${head} ${msg} ${paint(rest, DIM)}`;
}

/** `HH:MM:SS` — la date entière est dans le nom du fichier de journal, la répéter n'aide personne. */
function formatTime(value: unknown, timeZone: string | undefined): string {
  const ms = typeof value === 'number' ? value : Date.now();
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('en-GB', {
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

/**
 * Le reste de l'entrée en `clé=valeur`, dans l'ordre où pino l'a écrit. Une erreur est réduite à
 * son message : une stack sur une ligne de console noie ce qu'on cherchait à lire.
 */
function describeRest(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (NOISE.has(key)) continue;
    parts.push(`${key}=${describeValue(key, value)}`);
  }
  return parts.join(' ');
}

function describeValue(key: string, value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (key === 'err' || key === 'error') {
    const err = value as { message?: unknown; type?: unknown };
    if (typeof err.message === 'string') return JSON.stringify(err.message);
  }
  // Objets et tableaux : leur JSON. La valeur vient d'un `JSON.parse`, donc elle est sérialisable —
  // le filet reste au cas où le logger recevrait autre chose un jour.
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
