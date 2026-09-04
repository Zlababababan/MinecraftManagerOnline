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
import path from 'node:path';

import { formatConsoleLine } from './log-console.js';
import {
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_RETENTION_DAYS,
  createRotatingLog,
  purgeRotatedLogs,
} from '@mmo/shared/node';

const PREFIX = 'panel';

export interface PanelLogStream {
  write(chunk: string): void;
  /** Chemin du fichier courant ; `undefined` si l'écriture fichier est indisponible. */
  readonly file: string | undefined;
  close(): void;
}

/**
 * Rendu lisible sur la console : seulement devant un VRAI terminal. Redirigé vers un fichier,
 * piloté par systemd ou Docker, le panel continue d'émettre du NDJSON — c'est ce que ces outils
 * parsent. `NO_COLOR` et `MMO_LOG_FORMAT=json` (sortie brute) sont respectés.
 */
function consoleRendering(): { pretty: boolean; color: boolean } {
  const forced = process.env.MMO_LOG_FORMAT;
  if (forced === 'json') return { pretty: false, color: false };
  const tty = process.stdout.isTTY;
  const pretty = forced === 'pretty' || tty;
  const color = pretty && tty && process.env.NO_COLOR === undefined;
  return { pretty, color };
}

function maxBytes(): number {
  const raw = Number(process.env.MMO_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOG_MAX_BYTES;
}

/**
 * La mécanique de rotation vit dans `@mmo/shared/node` (`createRotatingLog`, lot 9) : l'agent a
 * gagné le même journal fichier, avec les mêmes règles. Ici ne reste que ce qui est propre au
 * panel — la recopie sur la sortie standard et le plafond surchargeable par variable d'environnement.
 */
export function createPanelLogStream(
  dataDir: string,
  now: () => number = Date.now,
): PanelLogStream {
  const log = createRotatingLog({
    dir: path.join(dataDir, 'logs'),
    prefix: PREFIX,
    retentionDays: DEFAULT_LOG_RETENTION_DAYS,
    maxBytes: maxBytes(),
    now,
  });
  const { pretty, color } = consoleRendering();
  return {
    get file() {
      return log.file;
    },
    write(chunk: string): void {
      // Le FICHIER garde le NDJSON : il est relu par `mmo-panel report`, masqué, joint à un
      // signalement. Seule la console est mise en forme, et seulement pour un humain.
      log.write(chunk);
      if (!pretty) {
        process.stdout.write(chunk);
        return;
      }
      for (const line of chunk.split('\n')) {
        if (line === '') continue;
        const rendered = formatConsoleLine(line, { color });
        // Une ligne qui n'est pas du JSON de log (trace, avertissement de Node) passe telle
        // quelle : la perdre serait pire que l'afficher brute.
        process.stdout.write(`${rendered ?? line}\n`);
      }
    },
    close(): void {
      log.close();
    },
  };
}

/**
 * Supprime les journaux de plus de 14 jours ; rend leur nombre. Appelée à chaque bascule de
 * fichier et par la maintenance horaire (un panel silencieux n'écrit pas, donc ne bascule pas :
 * sans ce second appel, des journaux orphelins survivaient à la rétention).
 */
export function purgePanelLogs(dir: string, now: number): number {
  return purgeRotatedLogs(dir, PREFIX, DEFAULT_LOG_RETENTION_DAYS, now);
}
