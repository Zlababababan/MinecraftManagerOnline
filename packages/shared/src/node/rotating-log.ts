/**
 * Fichier journal tournant, sans dépendance : `<dir>/<prefix>-<date>.log`, choisi **à l'écriture**
 * (jamais au démarrage), bascule au changement de jour et au-delà d'un plafond de taille (suffixe
 * numéroté), purge des fichiers plus vieux que la rétention à chaque bascule et sur demande.
 *
 * Partagé par le panel (`util/log-file.ts`) et l'agent (`log-file.ts`, lot 9) : même besoin, même
 * piège — un service qui tourne trois semaines écrivait tout dans le journal du jour de son
 * démarrage, la rétention ne s'appliquait jamais et rien ne bornait la taille.
 *
 * Toute défaillance côté fichier est absorbée : un journal ne doit jamais empêcher le processus
 * de tourner ni d'écrire sur sa sortie standard.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LOG_RETENTION_DAYS = 14;
export const DEFAULT_LOG_MAX_BYTES = 32 * 1024 * 1024;

export interface RotatingLogOptions {
  dir: string;
  /** Préfixe des fichiers : `panel` → `panel-2026-09-02.log`, puis `panel-2026-09-02-1.log`. */
  prefix: string;
  retentionDays?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface RotatingLog {
  write(chunk: string): void;
  /** Chemin du fichier courant ; `undefined` si l'écriture fichier est indisponible. */
  readonly file: string | undefined;
  close(): void;
}

export interface LogTail {
  /** Nom du fichier lu (le plus récent), absent s'il n'y en a aucun. */
  file?: string;
  lines: string[];
  /** Vrai si des lignes plus anciennes existent au-delà de la fenêtre (lignes ou octets). */
  truncated: boolean;
}

const DAY_MS = 86_400_000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function filePattern(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}-(\\d{4}-\\d{2}-\\d{2})(?:-(\\d+))?\\.log$`);
}

/** Tri chronologique : date puis suffixe numérique (`-10` après `-9`, pas avant). */
function compareLogNames(pattern: RegExp): (a: string, b: string) => number {
  const key = (name: string): [string, number] => {
    const m = pattern.exec(name);
    return [m?.[1] ?? '', Number(m?.[2] ?? 0)];
  };
  return (a, b) => {
    const [da, ia] = key(a);
    const [db, ib] = key(b);
    return da === db ? ia - ib : da < db ? -1 : 1;
  };
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function createRotatingLog(options: RotatingLogOptions): RotatingLog {
  const { dir, prefix } = options;
  const now = options.now ?? Date.now;
  const retentionDays = options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  let out: fs.WriteStream | undefined;
  let file: string | undefined;
  let day = '';
  let index = 0;
  let bytes = 0;
  let broken = false;
  /**
   * Fermé = définitif. Sans ce drapeau, une écriture après `close()` tombant sur un changement de
   * date rouvrait un fichier neuf : un agent arrêté aurait continué d'écrire dans son journal.
   */
  let closed = false;

  /**
   * `next` : bascule pour cause de TAILLE, sur la même journée — il faut alors passer au suffixe
   * suivant sans re-sonder, sinon on rouvre le fichier qu'on vient de quitter (il est sous le
   * plafond, c'est la ligne à venir qui le dépasserait).
   */
  const open = (next = false): void => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      purgeRotatedLogs(dir, prefix, retentionDays, now());
      const today = new Date(now()).toISOString().slice(0, 10);
      if (today !== day) index = 0;
      else if (next) index += 1;
      day = today;
      const nameOf = (i: number) =>
        path.join(dir, i === 0 ? `${prefix}-${day}.log` : `${prefix}-${day}-${String(i)}.log`);
      // Au démarrage, reprendre le dernier fichier du jour encore sous le plafond.
      while (!next && sizeOf(nameOf(index)) >= maxBytes) index += 1;
      const candidate = nameOf(index);
      file = candidate;
      bytes = sizeOf(candidate);
      out = fs.createWriteStream(candidate, { flags: 'a' });
      out.on('error', () => {
        out = undefined;
        broken = true;
      });
    } catch {
      out = undefined;
      file = undefined;
      broken = true;
    }
  };

  open();

  /** Bascule si la date a changé ou si le plafond est atteint. Jamais de `statSync` par ligne. */
  const rotateIfNeeded = (chunkBytes: number): void => {
    if (broken) return;
    const today = new Date(now()).toISOString().slice(0, 10);
    const sameDay = today === day;
    if (sameDay && bytes + chunkBytes < maxBytes) return;
    out?.end();
    out = undefined;
    open(sameDay);
  };

  return {
    get file() {
      return file;
    },
    write(chunk: string): void {
      if (broken || closed) return;
      const size = Buffer.byteLength(chunk);
      rotateIfNeeded(size);
      out?.write(chunk);
      bytes += size;
    },
    close(): void {
      closed = true;
      out?.end();
      out = undefined;
    },
  };
}

/**
 * Supprime les journaux plus vieux que la rétention ; rend leur nombre. Appelée à chaque bascule
 * de fichier et par les maintenances périodiques — un processus silencieux n'écrit pas, donc ne
 * bascule pas, et sans ce second appel des journaux orphelins survivaient à la rétention.
 */
export function purgeRotatedLogs(
  dir: string,
  prefix: string,
  retentionDays: number,
  now: number,
): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const pattern = filePattern(prefix);
  let removed = 0;
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs > retentionDays * DAY_MS) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {
      // Fichier verrouillé ou déjà supprimé : la purge réessaiera au prochain passage.
    }
  }
  return removed;
}

/**
 * Les `lines` dernières lignes du journal le plus récent, sans jamais lire plus de `maxBytes`
 * octets : un journal de 32 Mio ne doit pas passer entier par la mémoire ni par le réseau pour
 * en montrer deux cents lignes. Une première ligne coupée par la fenêtre d'octets est écartée.
 */
export function tailRotatedLog(
  dir: string,
  prefix: string,
  options: { lines: number; maxBytes: number },
): LogTail {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { lines: [], truncated: false };
  }
  const pattern = filePattern(prefix);
  const latest = names
    .filter((n) => pattern.test(n))
    .sort(compareLogNames(pattern))
    .at(-1);
  if (latest === undefined) return { lines: [], truncated: false };
  const full = path.join(dir, latest);
  let text: string;
  let start: number;
  try {
    const size = fs.statSync(full).size;
    start = Math.max(0, size - options.maxBytes);
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { file: latest, lines: [], truncated: false };
  }
  const all = text.split('\n');
  if (start > 0) all.shift();
  if (all.at(-1) === '') all.pop();
  const lines = all.slice(-options.lines);
  return { file: latest, lines, truncated: start > 0 || all.length > lines.length };
}
