/**
 * Maintenance horaire du panel (doc 04 §8.3 et §8.6) : purges par rétention, agrégation des
 * métriques, sauvegarde quotidienne du panel, compaction bornée de `metrics.db` et VACUUM
 * hebdomadaire des deux bases en fenêtre calme.
 *
 * Ce que chaque passage rend et journalise (lot 9, 2026-09-01) : le **nombre de lignes supprimées
 * par table**. Les fonctions de purge rendaient déjà `changes`, valeur jusque-là jetée — c'est la
 * donnée qui manque le jour où une base grossit sans raison. Et quatre tables n'étaient bornées
 * par rien : `command_history` (pourtant prévue doc 04 §8.6), `player_sessions`,
 * `server_migrations` terminées et les lignes `backups` déjà `deleted`.
 *
 * Toutes les rétentions sont des réglages `retention.*` (jours, entiers ≥ 1, défauts dans
 * `SettingsService`) ; l'historique de commandes est en plus plafonné par serveur.
 */
import { statSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { lt } from 'drizzle-orm';

import { wallClockIn } from '@mmo/shared';

import type { AppContext } from '../context.js';
import { freelistCount, pageSize } from '../db/compaction.js';
import { commandHistory } from '../db/schema.js';
import type { SqliteHandle } from '../db/sqlite.js';
import { purgePanelLogs } from '../util/log-file.js';
import { SETTING_KEYS } from './settings.js';

const DAY = 24 * 3_600_000;

/**
 * Tolérance avant de déclarer une politique de sauvegarde en retard. Large à dessein : l'agent
 * évalue le cron en heure locale de SA machine, il peut être éteint quelques heures, et un
 * faux positif sur une sauvegarde est le meilleur moyen de faire ignorer l'alerte.
 */
const BACKUP_OVERDUE_GRACE_MS = 2 * 3_600_000;

/** Les alertes résolues ne servent plus qu'à l'historique. */
const ALERTS_RETENTION_MS = 7 * DAY;

/** Événements d'agent déjà traités : l'agent rejoue au plus quelques minutes, 24 h est large. */
const PROCESSED_EVENTS_RETENTION_MS = DAY;

/**
 * Plafond de l'historique de commandes **par serveur**, en plus de la rétention en jours : une
 * console très bavarde (macros, planifications `command` toutes les minutes) ne doit pas remplir
 * la base entre deux passages. L'API n'en lit jamais plus de 500.
 */
export const COMMAND_HISTORY_MAX_PER_SERVER = 2000;

/** Temps maximal passé chaque heure à rendre les pages libres de `metrics.db` (~32 Mio mesurés). */
export const COMPACTION_BUDGET_MS = 500;

/** Un VACUUM complet réécrit le fichier entier : une fois par semaine suffit. */
export const VACUUM_INTERVAL_MS = 7 * DAY;

/** Fenêtre calme, en heure murale du fuseau des planifications : [3 h, 6 h). */
export const VACUUM_WINDOW = { fromHour: 3, toHour: 6 } as const;

/**
 * Espace libre exigé avant un VACUUM : SQLite construit une copie complète dans le dossier
 * temporaire puis la recopie sur place — jusqu'à deux fois la taille du fichier, plus une marge.
 */
export const VACUUM_DISK_MARGIN_BYTES = 64 * 1024 * 1024;

/** En dessous de ce volume récupérable, réécrire tout le fichier ne vaut pas le blocage. */
const VACUUM_MIN_RECLAIMABLE_BYTES = 1024 * 1024;
const VACUUM_MIN_RECLAIMABLE_RATIO = 0.05;

export interface MaintenanceOptions {
  /** Espace libre (octets) sur le volume qui porte un chemin. Injectable : simuler un disque plein. */
  diskFree?: (dir: string) => number;
  /** Dossier où SQLite construit la copie temporaire du VACUUM (défaut `os.tmpdir()`). */
  tmpDir?: string;
  /** Budget de la compaction incrémentale de `metrics.db`. */
  compactionBudgetMs?: number;
}

export type VacuumSkipReason =
  /** Base `:memory:` (tests) : rien à rendre à un système de fichiers. */
  | 'memory'
  /** Moins d'une semaine depuis le dernier VACUUM. */
  | 'recent'
  /** Hors fenêtre calme. */
  | 'window'
  /** Une task ou une migration est en cours : un blocage de plusieurs secondes tomberait dessus. */
  | 'busy'
  /** Espace disque insuffisant (ou inconnu) — journalisé en avertissement, retenté à l'heure suivante. */
  | 'disk'
  /** Presque rien à récupérer : le fichier n'est pas réécrit pour ça. */
  | 'nothing';

export interface VacuumOutcome {
  file: string;
  status: 'done' | 'skipped';
  reason?: VacuumSkipReason;
  beforeBytes?: number;
  afterBytes?: number;
  durationMs?: number;
}

export interface MaintenanceReport {
  at: number;
  durationMs: number;
  /** Lignes supprimées par table (les fichiers de journal du panel comptent comme une « table »). */
  purged: Record<string, number>;
  metrics: ReturnType<AppContext['metricsService']['maintain']>;
  vacuum: VacuumOutcome[];
}

export function runMaintenance(
  ctx: AppContext,
  options: MaintenanceOptions = {},
): MaintenanceReport {
  const started = performance.now();
  const t = ctx.now();
  const days = (key: string): number => ctx.settings.positiveInt(key) * DAY;
  const purged: Record<string, number> = {};

  purged.sessions = ctx.sessions.purgeExpired();
  purged.pairing_codes = ctx.machines.purgeExpiredPairingCodes();
  purged.processed_events = ctx.processed.purgeOlderThan(t - PROCESSED_EVENTS_RETENTION_MS);
  purged.events = ctx.events.purgeOlderThan(t - days(SETTING_KEYS.eventsRetentionDays));
  purged.audit_log = ctx.audit.purgeOlderThan(t - days(SETTING_KEYS.auditRetentionDays));
  purged.tasks = ctx.tasks.purgeOlderThan(t - days(SETTING_KEYS.tasksRetentionDays));
  purged.command_history = purgeCommandHistory(
    ctx,
    t - days(SETTING_KEYS.commandHistoryRetentionDays),
    COMMAND_HISTORY_MAX_PER_SERVER,
  );
  purged.player_sessions = ctx.servers.purgePlayerSessionsBefore(
    t - days(SETTING_KEYS.playerSessionsRetentionDays),
  );
  // Migrations AVANT sauvegardes : `server_migrations.backup_id` référence `backups.id` sans
  // ON DELETE — supprimer une sauvegarde encore référencée est une violation de clé étrangère.
  purged.server_migrations = ctx.migrations.purgeFinishedBefore(
    t - days(SETTING_KEYS.migrationsRetentionDays),
  );
  purged.backups = ctx.backups.purgeDeletedBefore(
    t - days(SETTING_KEYS.deletedBackupsRetentionDays),
  );
  ctx.sqlite.pragma('wal_checkpoint(PASSIVE)');

  // Politiques de sauvegarde qui ne tournent plus. C'était le trou le plus large du produit :
  // aucune colonne d'état, et la seule notification d'échec naissait d'un `task.failed`, donc
  // d'une sauvegarde qui avait AU MOINS démarré. Signalé une seule fois par épisode
  // (`overdueSince`), levé dès qu'une occurrence est enregistrée — y compris `skipped`.
  for (const policy of ctx.backups.overduePolicies(t, BACKUP_OVERDUE_GRACE_MS)) {
    ctx.backups.markOverdue(policy.id, t);
    const server = ctx.servers.get(policy.serverId);
    ctx.events.publish({
      type: 'backup.overdue',
      severity: 'warning',
      serverId: policy.serverId,
      ...(server?.machineId === undefined ? {} : { machineId: server.machineId }),
      payload: {
        policyId: policy.id,
        cron: policy.cron,
        lastRunAt: policy.lastRunAt,
        lastStatus: policy.lastStatus,
        serverName: server?.name ?? policy.serverId,
      },
      ts: t,
    });
  }
  // Sauvegarde quotidienne du panel lui-même (`VACUUM INTO`, doc 07 phase 8).
  try {
    ctx.panelBackup.backupIfStale();
  } catch (error) {
    ctx.logger.warn({ err: error }, 'panel self-backup failed');
  }
  // Métriques (doc 04 §7) : downsampling brut → 1 min → 1 h, purge, compaction bornée.
  const metrics = ctx.metricsService.maintain(t, {
    compactionBudgetMs: options.compactionBudgetMs ?? COMPACTION_BUDGET_MS,
  });
  if (metrics.compactedMs !== undefined) {
    // Rattrapage unique d'une base d'avant le correctif d'ordre des PRAGMA : `auto_vacuum` valait
    // 0, le VACUUM complet vient de la basculer en INCREMENTAL.
    ctx.logger.info(
      { durationMs: metrics.compactedMs },
      'metrics database compacted (auto_vacuum)',
    );
  }
  if (metrics.compaction.freedPages > 0) {
    ctx.logger.info(
      { file: 'metrics.db', ...metrics.compaction },
      'metrics database: free pages returned to the file system',
    );
  }
  purged.ui_events = ctx.uiEvents.purgeOlderThan(t - days(SETTING_KEYS.uiEventsRetentionDays));
  purged.alerts = ctx.alerts.purgeResolvedBefore(t - ALERTS_RETENTION_MS);
  purged.panel_logs = purgePanelLogs(path.join(ctx.config.dataDir, 'logs'), t);
  ctx.metricsSqlite.pragma('wal_checkpoint(PASSIVE)');

  const vacuum = maybeVacuum(ctx, t, options);

  const durationMs = Math.round(performance.now() - started);
  const removed = Object.fromEntries(Object.entries(purged).filter(([, n]) => n > 0));
  if (Object.keys(removed).length > 0) {
    ctx.logger.info({ purged: removed, durationMs }, 'maintenance: rows purged');
  } else {
    ctx.logger.debug({ durationMs }, 'maintenance: nothing to purge');
  }
  return { at: t, durationMs, purged, metrics, vacuum };
}

/**
 * Historique de commandes : par âge, puis par plafond par serveur (les plus anciennes partent).
 * Les écritures vivent dans les routes (`server.command`, `server.rcon`, macros) — la purge est le
 * seul autre accès à la table, elle reste ici plutôt que dans un service pour deux requêtes.
 */
function purgeCommandHistory(ctx: AppContext, before: number, keepPerServer: number): number {
  const byAge = ctx.db.delete(commandHistory).where(lt(commandHistory.ts, before)).run().changes;
  const byCap = ctx.sqlite
    .prepare(
      `DELETE FROM command_history WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY id DESC) AS rn
           FROM command_history
         ) WHERE rn > ?
       )`,
    )
    .run(keepPerServer).changes;
  return byAge + byCap;
}

function defaultDiskFree(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

/**
 * VACUUM hebdomadaire des deux bases, en fenêtre calme, précédé du contrôle d'espace disque.
 * Un VACUUM réécrit tout le fichier sur la connexion unique du panel : mesuré à 5–12 ms/Mio,
 * soit une dizaine de secondes pour 1 Gio pendant lesquelles le panel ne répond pas. D'où les
 * quatre gardes, dans cet ordre : cadence, fenêtre, activité, disque. Le dernier échec de disque
 * n'avance pas la cadence : la tentative reprend à l'heure suivante de la fenêtre, avec son
 * avertissement.
 */
function maybeVacuum(ctx: AppContext, t: number, options: MaintenanceOptions): VacuumOutcome[] {
  const targets: { file: string; sqlite: SqliteHandle }[] = [
    { file: ctx.files.mmo, sqlite: ctx.sqlite },
    { file: ctx.files.metrics, sqlite: ctx.metricsSqlite },
  ];
  const skipAll = (reason: VacuumSkipReason): VacuumOutcome[] =>
    targets.map(({ file }) => ({ file, status: 'skipped', reason }));

  const last = Number(ctx.settings.get(SETTING_KEYS.vacuumAt) ?? 0);
  if (Number.isFinite(last) && t - last < VACUUM_INTERVAL_MS) return skipAll('recent');
  const hour = wallClockIn(t, ctx.settings.timeZone()).hour;
  if (hour < VACUUM_WINDOW.fromHour || hour >= VACUUM_WINDOW.toHour) return skipAll('window');
  if (
    ctx.tasks.list({ active: true, limit: 1 }).length > 0 ||
    ctx.migrations.listActive().length > 0
  ) {
    ctx.logger.debug('vacuum postponed: a task or a migration is running');
    return skipAll('busy');
  }

  const diskFree = options.diskFree ?? defaultDiskFree;
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const outcomes: VacuumOutcome[] = [];
  for (const { file, sqlite } of targets) {
    if (file === ':memory:') {
      outcomes.push({ file, status: 'skipped', reason: 'memory' });
      continue;
    }
    const beforeBytes = fileBytes(file) + fileBytes(`${file}-wal`);
    let freeData: number;
    let freeTmp: number;
    try {
      freeData = diskFree(path.dirname(file));
      freeTmp = diskFree(tmpDir);
    } catch (error) {
      ctx.logger.warn({ err: error, file }, 'vacuum skipped: free disk space unknown');
      outcomes.push({ file, status: 'skipped', reason: 'disk', beforeBytes });
      continue;
    }
    const needData = 2 * beforeBytes + VACUUM_DISK_MARGIN_BYTES;
    const needTmp = beforeBytes + VACUUM_DISK_MARGIN_BYTES;
    if (freeData < needData || freeTmp < needTmp) {
      ctx.logger.warn(
        {
          file,
          sizeBytes: beforeBytes,
          freeDataBytes: freeData,
          freeTmpBytes: freeTmp,
          needData,
          needTmp,
        },
        'vacuum skipped: not enough free disk space',
      );
      outcomes.push({ file, status: 'skipped', reason: 'disk', beforeBytes });
      continue;
    }
    const reclaimable = freelistCount(sqlite) * pageSize(sqlite);
    const threshold = Math.max(
      VACUUM_MIN_RECLAIMABLE_BYTES,
      Math.round(beforeBytes * VACUUM_MIN_RECLAIMABLE_RATIO),
    );
    if (reclaimable < threshold) {
      ctx.logger.debug({ file, reclaimable, threshold }, 'vacuum skipped: nothing to reclaim');
      outcomes.push({ file, status: 'skipped', reason: 'nothing', beforeBytes });
      continue;
    }
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const started = performance.now();
    sqlite.exec('VACUUM');
    // En WAL, VACUUM écrit la base réécrite dans le journal : le fichier principal ne rétrécit
    // qu'au checkpoint suivant. Sans celui-ci, `afterBytes` mesurerait l'ancienne taille.
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const durationMs = Math.round(performance.now() - started);
    const afterBytes = fileBytes(file);
    ctx.logger.info({ file, beforeBytes, afterBytes, durationMs }, 'database vacuumed');
    outcomes.push({ file, status: 'done', beforeBytes, afterBytes, durationMs });
  }
  if (!outcomes.some((o) => o.reason === 'disk')) {
    ctx.settings.set(SETTING_KEYS.vacuumAt, String(t));
  }
  return outcomes;
}

function fileBytes(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
