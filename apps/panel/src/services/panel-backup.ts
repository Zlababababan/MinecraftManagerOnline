/**
 * Sauvegarde du panel lui-même (doc 04 §8, doc 07 phase 8) : `VACUUM INTO` de `mmo.db` (copie
 * cohérente sans arrêter le service ; `metrics.db` est reconstituable et volumineux, donc exclu)
 * vers `<dataDir>/backups/panel/mmo-<horodatage>.db`, rotation des N dernières. Déclenchée à la
 * demande (API admin) et automatiquement une fois par jour par la maintenance horaire.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';
import type { PanelBackupDto } from '@mmo/protocol/client';

export interface PanelBackupServiceDeps {
  sqlite: Database.Database;
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
        out.push({ file: name, sizeBytes: st.size, createdAt: Math.round(st.mtimeMs) });
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
    return { file: path.basename(file), sizeBytes: st.size, createdAt: Math.round(st.mtimeMs) };
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

function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
