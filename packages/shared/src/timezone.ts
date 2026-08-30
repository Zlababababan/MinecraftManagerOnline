/**
 * Fuseaux horaires, sans dépendance : `Intl` sait déjà tout ce dont on a besoin.
 *
 * Pourquoi ce module existe (bug signalé le 30 août 2026) : « une sauvegarde de 4 h qui part à
 * 6 h ». Les expressions cron étaient évaluées dans le fuseau du PROCESSUS qui les exécute —
 * l'agent pour les sauvegardes, le panel pour les actions programmées, le navigateur pour
 * l'affichage. Trois horloges, jamais nommées nulle part, et un serveur Linux est en UTC par
 * défaut : deux heures d'écart l'été, une l'hiver, sans le moindre indice à l'écran.
 *
 * Une planification doit donc porter SON fuseau, explicitement, et tout le monde calculer dedans.
 */

/** Heure murale : ce qu'affiche une horloge posée dans le fuseau, sans notion d'instant. */
export interface WallClock {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  formatters.set(timeZone, made);
  return made;
}

/** Fuseau du processus courant (`Europe/Paris`, `UTC`…). */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Le fuseau est-il connu de l'environnement ? (nom IANA valide) */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Heure murale d'un instant dans un fuseau. */
export function wallClockIn(ts: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(ts));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)?.value;
    return found === undefined ? 0 : Number(found);
  };
  // `hourCycle: 'h23'` peut rendre « 24 » pour minuit dans certains moteurs : 24:00 = 00:00.
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
  };
}

/** Décalage du fuseau à cet instant, en millisecondes (Paris l'été : +7 200 000). */
export function utcOffsetMs(ts: number, timeZone: string): number {
  const w = wallClockIn(ts, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  // `ts` peut porter des secondes ; les ignorer des deux côtés.
  return asUtc - Math.floor(ts / 60_000) * 60_000;
}

/** Décalage lisible (`+02:00`, `-05:00`, `+00:00`). */
export function formatUtcOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? '-' : '+';
  const total = Math.round(Math.abs(offsetMs) / 60_000);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/**
 * Instant correspondant à une heure murale dans un fuseau.
 *
 * `undefined` si cette heure N'EXISTE PAS : au passage à l'heure d'été, 2 h 30 n'a jamais lieu.
 * Une planification quotidienne à 2 h 30 saute donc ce jour-là — plutôt que d'être déplacée en
 * douce à une heure que personne n'a demandée. Au passage à l'heure d'hiver, où l'heure murale
 * a lieu DEUX fois, la première est retenue (la planification se déclenche une seule fois).
 */
export function instantOfWallClock(wall: WallClock, timeZone: string): number | undefined {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // Première approximation avec le décalage en vigueur autour de cette date, puis correction :
  // un seul rattrapage suffit, les sauts de fuseau ne dépassent jamais 24 h.
  let ts = asUtc - utcOffsetMs(asUtc, timeZone);
  ts = asUtc - utcOffsetMs(ts, timeZone);
  const back = wallClockIn(ts, timeZone);
  if (
    back.year !== wall.year ||
    back.month !== wall.month ||
    back.day !== wall.day ||
    back.hour !== wall.hour ||
    back.minute !== wall.minute
  ) {
    return undefined;
  }
  // Recul d'une heure : si l'heure murale a lieu deux fois, garder la PREMIÈRE occurrence.
  const earlier = ts - 3_600_000;
  const earlierWall = wallClockIn(earlier, timeZone);
  return earlierWall.hour === wall.hour && earlierWall.day === wall.day ? earlier : ts;
}

/**
 * Description courte d'un fuseau pour l'interface : `Europe/Paris (+02:00)`. Le décalage est
 * celui EN VIGUEUR à l'instant donné — il change deux fois l'an, et c'est justement le piège.
 */
export function describeTimeZone(timeZone: string, at: number): string {
  return `${timeZone} (${formatUtcOffset(utcOffsetMs(at, timeZone))})`;
}

/** Deux fuseaux affichent-ils la même heure à cet instant ? (`Europe/Paris` vs `Europe/Madrid`) */
export function sameOffset(a: string, b: string, at: number): boolean {
  return utcOffsetMs(at, a) === utcOffsetMs(at, b);
}

/** Jours entiers entre deux instants dans un fuseau (utilitaire d'affichage). */
export function dayIndexIn(ts: number, timeZone: string): number {
  const w = wallClockIn(ts, timeZone);
  return Math.floor(Date.UTC(w.year, w.month - 1, w.day) / DAY_MS);
}
