/**
 * Sauvegarde du panel lui-même (doc 04 §8, doc 07 phase 8) : `VACUUM INTO` de `mmo.db` (copie
 * cohérente sans arrêter le service ; `metrics.db` est reconstituable et volumineux, donc exclu)
 * vers `<dataDir>/backups/panel/mmo-<horodatage>.db`, rotation des N dernières. Déclenchée à la
 * demande (API admin) et automatiquement une fois par jour par la maintenance horaire.
 *
 * Phase 12 — restauration (`restorePanelBackup`, CLI `mmo-panel restore <fichier>`, panel arrêté) :
 * la copie est vérifiée (`PRAGMA integrity_check`, table `users`), la base courante et ses `-wal`/`-shm`
 * sont mis de côté (`mmo.db.before-restore-<horodatage>`), puis la copie prend la place de `mmo.db`.
 * `metrics.db` n'est pas touché (les agents rejouent leur tampon, l'historique plus ancien reste).
 */
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import type { PanelBackupDto } from '@mmo/protocol/client';

import { openSqliteReadonly, type SqliteHandle } from '../db/sqlite.js';

export interface PanelBackupServiceDeps {
  sqlite: SqliteHandle;
  dataDir: string;
  now: () => number;
  /** Nombre de copies conservées (défaut 7). */
  keep?: number;
}

const PREFIX = 'mmo-';
const SUFFIX = '.db';

export class PanelBackupService {
  constructor(private readonly deps: PanelBackupServiceDeps) {}

  get directory(): string {
    return path.join(this.deps.dataDir, 'backups', 'panel');
  }

  list(): PanelBackupDto[] {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return [];
    }
    const out: PanelBackupDto[] = [];
    for (const name of names) {
      if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
      try {
        const st = statSync(path.join(this.directory, name));
        out.push({
          file: name,
          sizeBytes: st.size,
          createdAt: stampOf(name) ?? Math.round(st.mtimeMs),
        });
      } catch {
        // supprimé entre-temps
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Copie cohérente maintenant ; retourne le fichier créé. */
  backupNow(): PanelBackupDto {
    mkdirSync(this.directory, { recursive: true });
    const stamp = new Date(this.deps.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let file = path.join(this.directory, `${PREFIX}${stamp}${SUFFIX}`);
    let n = 1;
    while (exists(file)) {
      file = path.join(this.directory, `${PREFIX}${stamp}-${String(n)}${SUFFIX}`);
      n++;
    }
    // better-sqlite3 n'autorise pas les paramètres liés sur VACUUM : chemin échappé à la main.
    this.deps.sqlite.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    this.rotate();
    const st = statSync(file);
    const name = path.basename(file);
    return { file: name, sizeBytes: st.size, createdAt: stampOf(name) ?? Math.round(st.mtimeMs) };
  }

  /** Sauvegarde si la dernière date de plus de 24 h (appelée par la maintenance horaire). */
  backupIfStale(): PanelBackupDto | undefined {
    const latest = this.list()[0];
    if (latest && this.deps.now() - latest.createdAt < 24 * 3600_000) return undefined;
    return this.backupNow();
  }

  private rotate(): void {
    const keep = this.deps.keep ?? 7;
    for (const old of this.list().slice(keep)) {
      rmSync(path.join(this.directory, old.file), { force: true });
    }
  }
}

export interface RestoreResult {
  /** Base restaurée (chemin complet). */
  dbFile: string;
  /** Ancienne base mise de côté (absente si le panel n'avait encore aucune base). */
  previous: string | undefined;
}

/**
 * Restaure `backupFile` (chemin complet ou nom dans le dossier des sauvegardes) comme `mmo.db` de
 * `dataDir`. À exécuter **panel arrêté** : refuse si un `-wal` non vide existe (panel en cours ou
 * arrêt brutal — démarrer puis arrêter proprement le panel avant).
 */
export function restorePanelBackup(
  dataDir: string,
  backupFile: string,
  now: () => number = Date.now,
): RestoreResult {
  const source = path.isAbsolute(backupFile)
    ? backupFile
    : exists(path.resolve(backupFile))
      ? path.resolve(backupFile)
      : path.join(dataDir, 'backups', 'panel', backupFile);
  if (!exists(source)) throw new Error(`backup not found: ${source}`);
  const dbFile = path.join(dataDir, 'mmo.db');
  const wal = `${dbFile}-wal`;
  if (exists(wal) && statSync(wal).size > 0) {
    throw new Error('mmo.db-wal is not empty: stop the panel cleanly before restoring');
  }
  // Vérification de la copie avant de toucher à quoi que ce soit. L'absence du fichier est déjà
  // traitée plus haut : `node:sqlite` n'a pas d'équivalent de `fileMustExist`.
  const check = openSqliteReadonly(source);
  try {
    const integrity = check.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') throw new Error(`backup integrity check failed: ${integrity}`);
    const hasUsers = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get();
    if (hasUsers === undefined) throw new Error('backup is not a panel database (no users table)');
  } finally {
    check.close();
  }
  let previous: string | undefined;
  if (exists(dbFile)) {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    previous = `${dbFile}.before-restore-${stamp}`;
    renameSync(dbFile, previous);
  }
  rmSync(wal, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
  copyFileSync(source, dbFile);
  return { dbFile, previous };
}

/** Horodatage porté par le nom (`mmo-2026-08-23T00-12-34[-n].db`) — fiable même si le fichier a été copié. */
function stampOf(name: string): number | undefined {
  const m = /^mmo-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return undefined;
  const ts = Date.parse(`${m[1] ?? ''}T${m[2] ?? ''}:${m[3] ?? ''}:${m[4] ?? ''}Z`);
  return Number.isNaN(ts) ? undefined : ts;
}

function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
