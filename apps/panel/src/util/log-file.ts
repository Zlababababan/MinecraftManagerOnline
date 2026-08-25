/**
 * Journal du panel en fichier (utilisation réelle, 2026-08-25) : lancé en console, le panel ne
 * laissait aucune trace après la fermeture de la fenêtre. En plus de la sortie standard, chaque
 * ligne NDJSON est recopiée dans `<dataDir>/logs/panel-<date>.log` (fichier choisi au démarrage,
 * ajout en fin de fichier) ; les fichiers de plus de `RETENTION_DAYS` jours sont purgés au
 * démarrage. Toute défaillance côté fichier est ignorée : le journal ne doit jamais empêcher le
 * panel de tourner ni de logger sur la console.
 */
import fs from 'node:fs';
import path from 'node:path';

const RETENTION_DAYS = 14;

export interface PanelLogStream {
  write(chunk: string): void;
  /** Chemin du fichier ouvert ; `undefined` si l'écriture fichier est indisponible. */
  file: string | undefined;
}

export function createPanelLogStream(dataDir: string, now = Date.now()): PanelLogStream {
  let out: fs.WriteStream | undefined;
  let file: string | undefined;
  try {
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    purgeOldLogs(dir, now);
    file = path.join(dir, `panel-${new Date(now).toISOString().slice(0, 10)}.log`);
    out = fs.createWriteStream(file, { flags: 'a' });
    out.on('error', () => {
      out = undefined;
    });
  } catch {
    out = undefined;
    file = undefined;
  }
  return {
    file,
    write(chunk: string): void {
      process.stdout.write(chunk);
      out?.write(chunk);
    },
  };
}

function purgeOldLogs(dir: string, now: number): void {
  for (const name of fs.readdirSync(dir)) {
    if (!/^panel-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs > RETENTION_DAYS * 86_400_000) fs.unlinkSync(full);
    } catch {
      // Fichier verrouillé ou déjà supprimé : la purge réessaiera au prochain démarrage.
    }
  }
}
