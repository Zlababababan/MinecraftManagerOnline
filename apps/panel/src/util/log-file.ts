/**
 * Journal du panel en fichier (utilisation réelle, 2026-08-25) : lancé en console, le panel ne
 * laissait aucune trace après la fermeture de la fenêtre. Chaque ligne NDJSON est recopiée dans
 * `<dataDir>/logs/panel-<date>.log`, en plus de la sortie standard.
 *
 * Le fichier est choisi **à l'écriture**, pas au démarrage : un service qui tourne trois semaines
 * écrivait sinon tout dans le journal du jour de son démarrage, la rétention de 14 jours ne
 * s'appliquait jamais et rien ne bornait la taille. Bascule au changement de date, plafond de
 * taille avec suffixe numéroté, purge rejouée à chaque bascule.
 *
 * Toute défaillance côté fichier est ignorée : le journal ne doit jamais empêcher le panel de
 * tourner ni de logger sur la console.
 */
import fs from 'node:fs';
import path from 'node:path';

const RETENTION_DAYS = 14;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export interface PanelLogStream {
  write(chunk: string): void;
  /** Chemin du fichier courant ; `undefined` si l'écriture fichier est indisponible. */
  readonly file: string | undefined;
  close(): void;
}

function maxBytes(): number {
  const raw = Number(process.env.MMO_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

export function createPanelLogStream(
  dataDir: string,
  now: () => number = Date.now,
): PanelLogStream {
  const dir = path.join(dataDir, 'logs');
  let out: fs.WriteStream | undefined;
  let file: string | undefined;
  let day = '';
  let index = 0;
  let bytes = 0;
  let broken = false;

  /**
   * `next` : bascule pour cause de TAILLE, sur la même journée — il faut alors passer au suffixe
   * suivant sans re-sonder, sinon on rouvre le fichier qu'on vient de quitter (il est sous le
   * plafond, c'est la ligne à venir qui le dépasserait).
   */
  const open = (next = false): void => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      purgeOldLogs(dir, now());
      const today = new Date(now()).toISOString().slice(0, 10);
      if (today !== day) index = 0;
      else if (next) index += 1;
      day = today;
      const nameOf = (i: number) =>
        path.join(dir, i === 0 ? `panel-${day}.log` : `panel-${day}-${String(i)}.log`);
      // Au démarrage, reprendre le dernier fichier du jour encore sous le plafond.
      while (!next && sizeOf(nameOf(index)) >= maxBytes()) index += 1;
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
    if (sameDay && bytes + chunkBytes < maxBytes()) return;
    out?.end();
    out = undefined;
    open(sameDay);
  };

  return {
    get file() {
      return file;
    },
    write(chunk: string): void {
      process.stdout.write(chunk);
      if (broken) return;
      const size = Buffer.byteLength(chunk);
      rotateIfNeeded(size);
      out?.write(chunk);
      bytes += size;
    },
    close(): void {
      out?.end();
      out = undefined;
    },
  };
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function purgeOldLogs(dir: string, now: number): void {
  for (const name of fs.readdirSync(dir)) {
    if (!/^panel-\d{4}-\d{2}-\d{2}(-\d+)?\.log$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs > RETENTION_DAYS * 86_400_000) fs.unlinkSync(full);
    } catch {
      // Fichier verrouillé ou déjà supprimé : la purge réessaiera à la prochaine bascule.
    }
  }
}
