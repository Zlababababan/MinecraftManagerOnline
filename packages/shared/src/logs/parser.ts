/**
 * Parsing des lignes de log Minecraft (doc 06 §3) — deux formats + repli :
 *   - Vanilla / Fabric / Forge 1.12 : `[HH:mm:ss] [Thread/LEVEL]: message`
 *     (Forge 1.12 insère un logger : `[HH:mm:ss] [Thread/LEVEL] [Logger]: message`)
 *   - Forge / NeoForge modernes : `[ddMMMyyyy HH:mm:ss.SSS] [Thread/LEVEL] [logger/MARKER]: message`
 *     ⚠ le mois suit la locale JVM (`14sept.2023`, `07janv.2023` sur un Windows FR).
 * Toute ligne qui ne matche aucun pattern (stacktrace, message multi-lignes) est rattachée à
 * l'entrée précédente, même niveau.
 */
import type { LogLevel } from '@mmo/protocol';

export interface ParsedLogLine {
  raw: string;
  /** Horodatage brut entre crochets (`20:44:27` ou `06Mar2026 20:45:07.936`). */
  timestamp: string;
  /** Heure `HH:mm:ss` extraite (les deux formats en ont une). */
  time: string;
  /** Date `{ year, month, day }` si le format la porte et que le mois est reconnu (en/fr). */
  date: { year: number; month: number; day: number } | undefined;
  thread: string;
  level: LogLevel;
  logger: string | undefined;
  message: string;
  format: 'classic' | 'modern';
}

export interface LogEntry extends ParsedLogLine {
  /** Lignes de continuation (stacktrace…), sans la ligne d'en-tête. */
  continuation: string[];
}

/** Ligne classifiée en flux : entrée nouvelle ou continuation de la précédente. */
export type ClassifiedLine =
  | { kind: 'entry'; level: LogLevel; parsed: ParsedLogLine }
  | { kind: 'continuation'; level: LogLevel; text: string };

const LEVELS: readonly LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

// [timestamp] [thread/LEVEL] (optional [logger]) ':'? message
const HEADER =
  /^\[([^\]]+)\] \[(.+?)\/(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE)\](?: \[([^\]]*)\])?:? ?(.*)$/;
const CLASSIC_TS = /^(\d{2}:\d{2}:\d{2})$/;
const MODERN_TS = /^(\d{1,2})([^\d\s]+?)\.?(\d{4}) (\d{2}:\d{2}:\d{2})(?:\.\d{3})?$/u;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  janv: 1,
  févr: 2,
  fevr: 2,
  mars: 3,
  avr: 4,
  mai: 5,
  juin: 6,
  juil: 7,
  août: 8,
  aout: 8,
  déc: 12,
};

function normalizeLevel(raw: string): LogLevel {
  if (raw === 'WARNING') return 'WARN';
  if (raw === 'SEVERE') return 'ERROR';
  return (LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : 'INFO';
}

/** Parse une ligne d'en-tête ; `undefined` si la ligne n'en est pas une (continuation). */
export function parseLogLine(line: string): ParsedLogLine | undefined {
  const m = HEADER.exec(line);
  if (!m) return undefined;
  const timestamp = m[1] ?? '';
  const thread = m[2] ?? '';
  const level = normalizeLevel(m[3] ?? 'INFO');
  const logger = m[4];
  const message = m[5] ?? '';

  const classic = CLASSIC_TS.exec(timestamp);
  if (classic) {
    return {
      raw: line,
      timestamp,
      time: classic[1] ?? '',
      date: undefined,
      thread,
      level,
      logger: logger === undefined || logger === '' ? undefined : logger,
      message,
      format: 'classic',
    };
  }
  const modern = MODERN_TS.exec(timestamp);
  if (modern) {
    const monthKey = (modern[2] ?? '').toLowerCase();
    const month = MONTHS[monthKey];
    return {
      raw: line,
      timestamp,
      time: modern[4] ?? '',
      date:
        month === undefined
          ? undefined
          : { year: Number(modern[3]), month, day: Number(modern[1]) },
      thread,
      level,
      logger: logger === undefined || logger === '' ? undefined : logger,
      message,
      format: 'modern',
    };
  }
  // Timestamp d'une forme inattendue : on garde l'entrée (niveau et message sont fiables).
  return {
    raw: line,
    timestamp,
    time: /\d{2}:\d{2}:\d{2}/.exec(timestamp)?.[0] ?? '',
    date: undefined,
    thread,
    level,
    logger: logger === undefined || logger === '' ? undefined : logger,
    message,
    format: 'classic',
  };
}

/** Classificateur à état pour un flux ligne à ligne (console temps réel). */
export class LogLineClassifier {
  private lastLevel: LogLevel = 'INFO';

  classify(line: string): ClassifiedLine {
    const parsed = parseLogLine(line);
    if (parsed) {
      this.lastLevel = parsed.level;
      return { kind: 'entry', level: parsed.level, parsed };
    }
    return { kind: 'continuation', level: this.lastLevel, text: line };
  }

  reset(): void {
    this.lastLevel = 'INFO';
  }
}

/** Parse un texte complet en entrées (stacktraces rattachées). Les lignes orphelines initiales forment une entrée INFO. */
export function parseLogText(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let current: LogEntry | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = parseLogLine(rawLine);
    if (parsed) {
      current = { ...parsed, continuation: [] };
      entries.push(current);
    } else if (rawLine !== '' || current) {
      if (!current) {
        current = {
          raw: rawLine,
          timestamp: '',
          time: '',
          date: undefined,
          thread: '',
          level: 'INFO',
          logger: undefined,
          message: rawLine,
          format: 'classic',
          continuation: [],
        };
        entries.push(current);
      } else {
        current.continuation.push(rawLine);
      }
    }
  }
  // Ligne vide finale (fichier terminé par \n) : ne pas la compter comme continuation.
  const last = entries.at(-1);
  if (last?.continuation.at(-1) === '') last.continuation.pop();
  return entries;
}

/** Supprime les séquences d'échappement ANSI (certains packs forcent la couleur). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
}
