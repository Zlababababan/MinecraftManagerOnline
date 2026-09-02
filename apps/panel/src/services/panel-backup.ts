/**
 * Sauvegarde du panel lui-même (doc 04 §8, doc 07 phase 8) : `VACUUM INTO` de `mmo.db` (copie
 * cohérente sans arrêter le service ; `metrics.db` est reconstituable et volumineux, donc exclu),
 * rotation des N dernières. Déclenchée à la demande (API admin) et automatiquement une fois par
 * jour par la maintenance horaire.
 *
 * Lot 4 (2026-09-02) — l'archive `mmo-panel-<horodatage>.tar.gz` remplace la copie `.db` nue :
 * `mmo.db` (VACUUM INTO) + le dossier `tls/` (certificat, clé, compte ACME, état de la couche
 * d'accès — sans eux, restaurer ailleurs ne rend pas un panel qui marche en mode direct) +
 * `manifest.json` (version du panel, date, fichiers, empreinte de la base). Les copies `.db`
 * d'avant restent listées, restaurables et comptées dans la rotation. **Téléchargeable** par un
 * administrateur (`GET /api/admin/backups/:file/download`) — elle contient les secrets du panel.
 * **L'échec de la sauvegarde automatique n'est plus un `warn` muet** : `backupIfStale` rend une
 * issue que la maintenance transforme en événement `panel.backupFailed`, une fois par épisode ;
 * l'état (`lastError`, `lastSuccessAt`) est exposé par `GET /api/admin/backups` et `/api/health`.
 *
 * Phase 12 — restauration (`restorePanelBackup`, CLI `mmo-panel restore <fichier>`, panel arrêté) :
 * la copie est vérifiée (`PRAGMA integrity_check`, table `users`), la base courante et ses `-wal`/`-shm`
 * sont mis de côté (`mmo.db.before-restore-<horodatage>`), puis la copie prend la place de `mmo.db` ;
 * un `tls/` présent dans l'archive remplace le dossier courant (mis de côté de la même façon).
 * `metrics.db` n'est pas touché (les agents rejouent leur tampon, l'historique plus ancien reste).
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import type { PanelBackupDto } from '@mmo/protocol/client';
import { extractTar, tarEntries, walkTree } from '@mmo/shared/node';

import { openSqliteReadonly, type SqliteHandle } from '../db/sqlite.js';

export interface PanelBackupServiceDeps {
  sqlite: SqliteHandle;
  dataDir: string;
  now: () => number;
  /** Nombre de copies conservées (défaut 7). */
  keep?: number;
  /** Écrit dans `manifest.json` (défaut : inconnu). */
  panelVersion?: string;
}

/** Ce que la maintenance apprend d'un passage de `backupIfStale`. */
export type ScheduledBackupOutcome =
  | { status: 'skipped' }
  | { status: 'done'; backup: PanelBackupDto; recovered: boolean }
  /** `newFailure` : première défaillance depuis le dernier succès — c'est elle qui vaut un événement. */
  | { status: 'failed'; error: string; newFailure: boolean };

export interface PanelBackupStatus {
  /** Copie la plus récente sur le disque (lue dans son nom), NULL si aucune. */
  lastSuccessAt: number | null;
  /** Dernière tentative automatique en échec depuis le dernier succès (mémoire du processus). */
  lastError: string | null;
  lastAttemptAt: number | null;
}

const LEGACY_PREFIX = 'mmo-';
const LEGACY_SUFFIX = '.db';
const ARCHIVE_PREFIX = 'mmo-panel-';
const ARCHIVE_SUFFIX = '.tar.gz';
/** Noms acceptés au téléchargement et à la restauration : rien d'autre qu'une copie connue. */
const NAME_PATTERN =
  /^mmo(?:-panel)?-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?\.(?:db|tar\.gz)$/;

export class PanelBackupService {
  private lastError: string | null = null;
  private lastAttemptAt: number | null = null;
  /** Sauvegarde en cours d'écriture : jamais deux à la fois (passes horaires, bouton). */
  private inflight: Promise<PanelBackupDto> | undefined;

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
      const format = formatOf(name);
      if (format === undefined) continue;
      try {
        const st = statSync(path.join(this.directory, name));
        out.push({
          file: name,
          format,
          sizeBytes: st.size,
          createdAt: stampOf(name) ?? Math.round(st.mtimeMs),
        });
      } catch {
        // supprimé entre-temps
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  status(): PanelBackupStatus {
    return {
      lastSuccessAt: this.list()[0]?.createdAt ?? null,
      lastError: this.lastError,
      lastAttemptAt: this.lastAttemptAt,
    };
  }

  /**
   * Chemin d'une copie **connue** (nom nu, présent dans le dossier), `undefined` sinon — c'est la
   * seule voie du téléchargement : un nom forgé (`../mmo.db`, un fichier quelconque du dossier)
   * n'existe pas pour lui.
   */
  resolveFile(name: string): string | undefined {
    if (!NAME_PATTERN.test(name)) return undefined;
    const file = path.join(this.directory, name);
    return existsSync(file) ? file : undefined;
  }

  /**
   * Copie cohérente maintenant ; retourne le fichier créé. Lève en cas d'échec (route → 500).
   * Une seule sauvegarde en vol : un second appel pendant l'écriture reçoit la même promesse.
   */
  backupNow(): Promise<PanelBackupDto> {
    return this.start();
  }

  /**
   * Sauvegarde si la dernière date de plus de 24 h (appelée par la maintenance horaire). Ne lève
   * jamais : l'issue dit ce qui s'est passé, et si c'est la PREMIÈRE défaillance depuis le dernier
   * succès — une sauvegarde silencieusement cassée pendant des mois est le pire scénario, et un
   * `warn` par heure dans un journal que personne ne lit ne l'empêche pas.
   */
  async backupIfStale(): Promise<ScheduledBackupOutcome> {
    if (this.inflight !== undefined) return { status: 'skipped' };
    const latest = this.list()[0];
    if (latest && this.deps.now() - latest.createdAt < 24 * 3600_000) return { status: 'skipped' };
    this.lastAttemptAt = this.deps.now();
    const hadError = this.lastError !== null;
    try {
      const backup = await this.start();
      this.lastError = null;
      return { status: 'done', backup, recovered: hadError };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      return { status: 'failed', error: message, newFailure: !hadError };
    }
  }

  /** Attend la sauvegarde en cours, s'il y en a une (tests, arrêt propre). */
  async idle(): Promise<void> {
    await this.inflight?.catch(() => undefined);
  }

  private start(): Promise<PanelBackupDto> {
    this.inflight ??= this.write().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async write(): Promise<PanelBackupDto> {
    mkdirSync(this.directory, { recursive: true });
    const stamp = new Date(this.deps.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let base = path.join(this.directory, `${ARCHIVE_PREFIX}${stamp}`);
    let n = 1;
    while (existsSync(`${base}${ARCHIVE_SUFFIX}`)) {
      base = path.join(this.directory, `${ARCHIVE_PREFIX}${stamp}-${String(n)}`);
      n++;
    }
    const file = `${base}${ARCHIVE_SUFFIX}`;
    const staging = `${base}.staging`;
    const part = `${file}.part`;
    try {
      mkdirSync(staging, { recursive: true });
      const dbCopy = path.join(staging, 'mmo.db');
      // Pas de paramètre lié possible sur VACUUM : chemin échappé à la main.
      this.deps.sqlite.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
      const tlsDir = path.join(this.deps.dataDir, 'tls');
      if (existsSync(tlsDir)) cpSync(tlsDir, path.join(staging, 'tls'), { recursive: true });
      const dbBytes = readFileSync(dbCopy);
      const tree = await walkTree(staging, () => false);
      const files = tree.entries.filter((e) => e.kind === 'file').map((e) => e.rel);
      writeFileSync(
        path.join(staging, 'manifest.json'),
        JSON.stringify(
          {
            panelVersion: this.deps.panelVersion ?? 'unknown',
            createdAt: this.deps.now(),
            files: [...files, 'manifest.json'],
            mmoDb: {
              bytes: dbBytes.byteLength,
              sha256: createHash('sha256').update(dbBytes).digest('hex'),
            },
          },
          null,
          2,
        ) + '\n',
      );
      const full = await walkTree(staging, () => false);
      await pipeline(
        Readable.from(tarEntries(full.entries)),
        createGzip(),
        createWriteStream(part),
      );
      renameSync(part, file);
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(part, { force: true });
    }
    this.rotate();
    const st = statSync(file);
    const name = path.basename(file);
    return {
      file: name,
      format: 'archive',
      sizeBytes: st.size,
      createdAt: stampOf(name) ?? Math.round(st.mtimeMs),
    };
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
  /** Le dossier `tls/` de l'archive a pris la place du courant (archives lot 4 seulement). */
  tls: boolean;
  /** Ancien dossier `tls/` mis de côté. */
  previousTls: string | undefined;
}

/**
 * Restaure `backupFile` (chemin complet ou nom dans le dossier des sauvegardes) comme `mmo.db` de
 * `dataDir` — copie `.db` nue ou archive `.tar.gz` (base + `tls/`). À exécuter **panel arrêté** :
 * refuse si un `-wal` non vide existe (panel en cours ou arrêt brutal — démarrer puis arrêter
 * proprement le panel avant).
 */
export async function restorePanelBackup(
  dataDir: string,
  backupFile: string,
  now: () => number = Date.now,
): Promise<RestoreResult> {
  const source = path.isAbsolute(backupFile)
    ? backupFile
    : existsSync(path.resolve(backupFile))
      ? path.resolve(backupFile)
      : path.join(dataDir, 'backups', 'panel', backupFile);
  if (!existsSync(source)) throw new Error(`backup not found: ${source}`);
  const dbFile = path.join(dataDir, 'mmo.db');
  const wal = `${dbFile}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new Error('mmo.db-wal is not empty: stop the panel cleanly before restoring');
  }
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const isArchive = source.endsWith(ARCHIVE_SUFFIX);
  const extracted = isArchive ? path.join(dataDir, `restore-${stamp}.tmp`) : undefined;
  try {
    let dbSource = source;
    let tlsSource: string | undefined;
    if (extracted !== undefined) {
      rmSync(extracted, { recursive: true, force: true });
      mkdirSync(extracted, { recursive: true });
      await extractTar(readGunzip(source), extracted);
      dbSource = path.join(extracted, 'mmo.db');
      if (!existsSync(dbSource)) throw new Error('archive does not contain mmo.db');
      const tls = path.join(extracted, 'tls');
      if (existsSync(tls)) tlsSource = tls;
    }
    // Vérification de la copie avant de toucher à quoi que ce soit. L'absence du fichier est déjà
    // traitée plus haut : `node:sqlite` n'a pas d'équivalent de `fileMustExist`.
    verifyPanelDatabase(dbSource);
    let previous: string | undefined;
    if (existsSync(dbFile)) {
      previous = `${dbFile}.before-restore-${stamp}`;
      renameSync(dbFile, previous);
    }
    rmSync(wal, { force: true });
    rmSync(`${dbFile}-shm`, { force: true });
    copyFileSync(dbSource, dbFile);
    let previousTls: string | undefined;
    if (tlsSource !== undefined) {
      const tlsDir = path.join(dataDir, 'tls');
      if (existsSync(tlsDir)) {
        previousTls = `${tlsDir}.before-restore-${stamp}`;
        renameSync(tlsDir, previousTls);
      }
      cpSync(tlsSource, tlsDir, { recursive: true });
    }
    return { dbFile, previous, tls: tlsSource !== undefined, previousTls };
  } finally {
    if (extracted !== undefined) rmSync(extracted, { recursive: true, force: true });
  }
}

function verifyPanelDatabase(file: string): void {
  const check = openSqliteReadonly(file);
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
}

async function* readGunzip(file: string): AsyncGenerator<Uint8Array> {
  const { createReadStream } = await import('node:fs');
  const stream = createReadStream(file).pipe(createGunzip());
  for await (const chunk of stream) yield chunk as Uint8Array;
}

function formatOf(name: string): PanelBackupDto['format'] | undefined {
  if (name.startsWith(ARCHIVE_PREFIX) && name.endsWith(ARCHIVE_SUFFIX)) return 'archive';
  if (name.startsWith(LEGACY_PREFIX) && name.endsWith(LEGACY_SUFFIX)) return 'db';
  return undefined;
}

/** Horodatage porté par le nom (`mmo-panel-2026-08-23T00-12-34[-n].tar.gz`, `mmo-<ISO>.db`) — fiable même si le fichier a été copié. */
function stampOf(name: string): number | undefined {
  const m = /^mmo(?:-panel)?-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return undefined;
  const ts = Date.parse(`${m[1] ?? ''}T${m[2] ?? ''}:${m[3] ?? ''}:${m[4] ?? ''}Z`);
  return Number.isNaN(ts) ? undefined : ts;
}
