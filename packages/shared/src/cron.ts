/**
 * Expressions cron à 5 champs (`min heure jour mois jour-semaine`), évaluées dans un **fuseau
 * explicite** — celui de la planification, pas celui du processus qui exécute. À défaut, le fuseau
 * du processus, ce qui était l'ancien comportement : c'est précisément lui qui faisait partir à 6 h
 * une sauvegarde réglée sur 4 h, l'agent étant en UTC et l'utilisateur à Paris (voir
 * `timezone.ts`). Sans dépendance. Sémantique Vixie : `*`, listes `a,b`, plages `a-b`, pas `a-b/n` et `* /n`, noms de mois
 * (`jan`…) et de jours (`sun`… ; `0` et `7` = dimanche) ; si jour-du-mois **et** jour-de-semaine sont
 * restreints, l'un **ou** l'autre suffit.
 */

import { instantOfWallClock, localTimeZone, wallClockIn, type WallClock } from './timezone.js';

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** `true` si le champ jour-du-mois n'est pas `*` (règle OU avec jour-de-semaine). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldDef {
  min: number;
  max: number;
  names?: string[];
  /** Décalage des noms (mois : `jan` = 1). */
  nameBase?: number;
}

const FIELDS: FieldDef[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { min: 0, max: 7, names: DAYS, nameBase: 0 },
];

export class CronError extends Error {
  constructor(
    message: string,
    readonly field: number | undefined,
  ) {
    super(message);
    this.name = 'CronError';
  }
}

function parseValue(token: string, def: FieldDef, field: number): number {
  const lower = token.toLowerCase();
  if (def.names) {
    const idx = def.names.indexOf(lower);
    if (idx !== -1) return idx + (def.nameBase ?? 0);
  }
  if (!/^\d+$/.test(token)) throw new CronError(`invalid value "${token}"`, field);
  const n = Number(token);
  if (n < def.min || n > def.max) {
    throw new CronError(
      `value ${String(n)} out of range ${String(def.min)}-${String(def.max)}`,
      field,
    );
  }
  return n;
}

function parseField(
  text: string,
  def: FieldDef,
  field: number,
): { values: Set<number>; star: boolean } {
  const values = new Set<number>();
  let star = false;
  for (const part of text.split(',')) {
    if (part === '') throw new CronError('empty list item', field);
    const [rangeText, stepText, extra] = part.split('/');
    if (extra !== undefined || rangeText === undefined) throw new CronError('invalid step', field);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new CronError(`invalid step "${stepText}"`, field);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (rangeText === '*' || rangeText === '?') {
      lo = def.min;
      hi = def.max;
      if (stepText === undefined) star = true;
    } else if (rangeText.includes('-')) {
      const [a, b, more] = rangeText.split('-');
      if (more !== undefined || a === undefined || b === undefined) {
        throw new CronError(`invalid range "${rangeText}"`, field);
      }
      lo = parseValue(a, def, field);
      hi = parseValue(b, def, field);
      if (hi < lo) throw new CronError(`inverted range "${rangeText}"`, field);
    } else {
      lo = parseValue(rangeText, def, field);
      hi = stepText === undefined ? lo : def.max;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, star };
}

/** Analyse une expression ; lève `CronError` si elle est invalide. */
export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(`5 fields expected, got ${String(fields.length)}`, undefined);
  }
  const [minutes, hours, dom, months, dow] = FIELDS.map((def, i) =>
    parseField(fields[i] ?? '', def, i),
  );
  if (!minutes || !hours || !dom || !months || !dow) throw new CronError('internal', undefined);
  // 7 = dimanche
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: months.values,
    daysOfWeek: dow.values,
    domRestricted: !dom.star,
    dowRestricted: !dow.star,
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/** L'expression correspond-elle à cette heure murale ? */
function wallMatches(spec: CronSpec, wall: WallClock, weekday: number): boolean {
  if (!spec.minutes.has(wall.minute)) return false;
  if (!spec.hours.has(wall.hour)) return false;
  if (!spec.months.has(wall.month)) return false;
  const domOk = spec.daysOfMonth.has(wall.day);
  const dowOk = spec.daysOfWeek.has(weekday);
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/** Jour de la semaine (0 = dimanche) d'une date murale, indépendamment de tout fuseau. */
function dayOfWeek(wall: WallClock): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/**
 * L'instant (à la minute près) correspond-il à l'expression ? Dans `timeZone` s'il est fourni,
 * sinon dans le fuseau du processus.
 */
export function cronMatches(spec: CronSpec, date: Date, timeZone?: string): boolean {
  const wall =
    timeZone === undefined
      ? {
          year: date.getFullYear(),
          month: date.getMonth() + 1,
          day: date.getDate(),
          hour: date.getHours(),
          minute: date.getMinutes(),
        }
      : wallClockIn(date.getTime(), timeZone);
  return wallMatches(spec, wall, dayOfWeek(wall));
}

/**
 * Prochaine occurrence **strictement après** `after` (epoch ms) ; `undefined` si aucune dans les
 * 5 ans (ex. `31 feb`). Sans `timeZone`, le fuseau du processus — l'ancien comportement.
 *
 * La marche se fait en HEURE MURALE (un `Date` en pseudo-UTC sert de calendrier), puis l'heure
 * trouvée est convertie en instant réel. C'est ce qui rend le résultat identique quel que soit le
 * processus qui calcule, et ce qui permet de sauter proprement l'heure qui n'existe pas au
 * passage à l'heure d'été.
 */
export function cronNext(spec: CronSpec, after: number, timeZone?: string): number | undefined {
  const zone = timeZone ?? localTimeZone();
  const start = wallClockIn(after, zone);
  const cursor = new Date(
    Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute),
  );
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = cursor.getTime() + 5 * 366 * 86_400_000;
  while (cursor.getTime() <= limit) {
    if (!spec.months.has(cursor.getUTCMonth() + 1)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const domOk = spec.daysOfMonth.has(cursor.getUTCDate());
    const dowOk = spec.daysOfWeek.has(cursor.getUTCDay());
    const dayOk =
      spec.domRestricted && spec.dowRestricted
        ? domOk || dowOk
        : spec.domRestricted
          ? domOk
          : spec.dowRestricted
            ? dowOk
            : true;
    if (!dayOk) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minutes.has(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    const instant = instantOfWallClock(
      {
        year: cursor.getUTCFullYear(),
        month: cursor.getUTCMonth() + 1,
        day: cursor.getUTCDate(),
        hour: cursor.getUTCHours(),
        minute: cursor.getUTCMinutes(),
      },
      zone,
    );
    // Heure inexistante (passage à l'heure d'été) : la planification saute cette occurrence.
    if (instant === undefined || instant <= after) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return instant;
  }
  return undefined;
}

/** Raccourci : prochaine occurrence d'une expression textuelle (`undefined` si invalide). */
export function nextCronRun(
  expression: string,
  after: number,
  timeZone?: string,
): number | undefined {
  try {
    return cronNext(parseCron(expression), after, timeZone);
  } catch {
    return undefined;
  }
}

// --- Listes d'expressions (Planificateur v2) --------------------------------------------------
// Une planification peut combiner plusieurs échéances (« tous les jours à 8h00, 12h30 et
// 20h00 ») : plusieurs expressions à 5 champs dans une même chaîne, une par ligne.

/** Nombre maximal d'expressions dans une liste. */
export const CRON_LIST_MAX = 10;

/** Découpe une liste d'expressions (une par ligne) ; lignes vides ignorées. */
export function splitCronList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Liste valide : 1 à `CRON_LIST_MAX` expressions, toutes analysables. */
export function isValidCronList(text: string): boolean {
  const list = splitCronList(text);
  return list.length >= 1 && list.length <= CRON_LIST_MAX && list.every((e) => isValidCron(e));
}

/**
 * Prochaine occurrence parmi toutes les expressions de la liste (le minimum) ; `undefined` si
 * aucune expression n'a d'occurrence (liste vide, invalide, ou ex. `31 feb`).
 */
export function nextCronRunList(
  text: string,
  after: number,
  timeZone?: string,
): number | undefined {
  let best: number | undefined;
  for (const expression of splitCronList(text)) {
    const next = nextCronRun(expression, after, timeZone);
    if (next !== undefined && (best === undefined || next < best)) best = next;
  }
  return best;
}
