/**
 * Expressions cron à 5 champs (`min heure jour mois jour-semaine`), évaluées en **heure locale**
 * de la machine qui exécute (panel pour les actions programmées, agent pour les backups). Sans
 * dépendance. Sémantique Vixie : `*`, listes `a,b`, plages `a-b`, pas `a-b/n` et `* /n`, noms de mois
 * (`jan`…) et de jours (`sun`… ; `0` et `7` = dimanche) ; si jour-du-mois **et** jour-de-semaine sont
 * restreints, l'un **ou** l'autre suffit.
 */

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

/** L'instant (à la minute près, heure locale) correspond-il à l'expression ? */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minutes.has(date.getMinutes())) return false;
  if (!spec.hours.has(date.getHours())) return false;
  if (!spec.months.has(date.getMonth() + 1)) return false;
  const domOk = spec.daysOfMonth.has(date.getDate());
  const dowOk = spec.daysOfWeek.has(date.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/**
 * Prochaine occurrence **strictement après** `after` (epoch ms), en heure locale ; `undefined` si
 * aucune dans les 5 ans (ex. `31 feb`). Avance minute par minute avec sauts par jour/heure.
 */
export function cronNext(spec: CronSpec, after: number): number | undefined {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!spec.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = spec.daysOfMonth.has(d.getDate());
    const dowOk = spec.daysOfWeek.has(d.getDay());
    const dayOk =
      spec.domRestricted && spec.dowRestricted
        ? domOk || dowOk
        : spec.domRestricted
          ? domOk
          : spec.dowRestricted
            ? dowOk
            : true;
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return undefined;
}

/** Raccourci : prochaine occurrence d'une expression textuelle (`undefined` si invalide). */
export function nextCronRun(expression: string, after: number): number | undefined {
  try {
    return cronNext(parseCron(expression), after);
  } catch {
    return undefined;
  }
}
