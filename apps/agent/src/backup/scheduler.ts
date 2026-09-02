/**
 * Plannings de backups **locaux** (doc 05 §5–§6) : poussés par `agent.configure.backupSchedules`,
 * persistés, évalués par l'agent toutes les 30 s dans le fuseau de la politique (celui du panel,
 * poussé avec elle ; l'heure locale de la machine à défaut) — un backup nocturne ne dépend pas
 * du panel. Une occurrence manquée (agent éteint) n'est pas rattrapée ; une occurrence n'est jamais
 * exécutée deux fois (`backupScheduleRuns`). Les résultats partent en `task.completed` (critique,
 * rejoué à la reconnexion).
 */
import { cronNext, parseCron } from '@mmo/shared';
import { ulid, type BackupSchedule } from '@mmo/protocol';

import { errorMessage, type Logger } from '../log.js';
import type { ServerManager } from '../minecraft/server-manager.js';
import type { StateStore } from '../state/store.js';
import type { TaskRunner } from '../tasks/runner.js';
import type { BackupCreateRequest, BackupService } from './backup-service.js';

export interface BackupSchedulerOptions {
  store: StateStore;
  manager: ServerManager;
  backups: BackupService;
  tasks: TaskRunner;
  logger: Logger;
  now?: () => number;
  /** Période d'évaluation (défaut 30 s). */
  tickMs?: number;
  /**
   * Occurrence volontairement non exécutée. Sans ce signal, les trois sorties silencieuses du
   * planificateur laissent le panel croire que la politique est morte : côté utilisateur, un
   * serveur arrêté sous `onlyIfRunning` et une politique réellement cassée étaient identiques.
   */
  onSkipped?: (skip: {
    serverId: string;
    policyId: string;
    ts: number;
    reason: 'server_stopped' | 'task_running' | 'invalid_cron' | 'start_failed';
    detail?: string;
  }) => void;
}

export class BackupScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private ticking = false;

  constructor(private readonly options: BackupSchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer !== undefined) return;
    const every = this.options.tickMs ?? 30_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Prochaine occurrence d'un planning (depuis sa dernière exécution, sinon maintenant). */
  nextRun(schedule: BackupSchedule): number | undefined {
    try {
      const spec = parseCron(schedule.cron);
      const last = this.options.store.get().backupScheduleRuns[schedule.id];
      const base = last === undefined ? this.now() - 60_000 : Math.max(last, this.now() - 60_000);
      return cronNext(spec, base, schedule.timezone);
    } catch {
      return undefined;
    }
  }

  /** Évalue tous les plannings ; lance les backups dus. Retourne les IDs de tasks démarrées. */
  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: string[] = [];
    try {
      const t = this.now();
      for (const schedule of this.options.store.get().backupSchedules) {
        if (!schedule.enabled) continue;
        let spec;
        try {
          spec = parseCron(schedule.cron);
        } catch (error) {
          this.options.logger.warn('invalid backup schedule ignored', {
            id: schedule.id,
            cron: schedule.cron,
            error: errorMessage(error),
          });
          this.skip(schedule, t, 'invalid_cron', errorMessage(error));
          continue;
        }
        const last = this.options.store.get().backupScheduleRuns[schedule.id];
        // Une occurrence est due si elle est tombée dans la dernière minute et n'a pas déjà tourné.
        const due = cronNext(spec, t - 60_000, schedule.timezone);
        if (due === undefined || due > t) continue;
        if (last !== undefined && last >= due) continue;
        if (!this.options.store.getServer(schedule.serverId)) continue;
        if (
          schedule.onlyIfRunning &&
          !(this.options.manager.get(schedule.serverId)?.isRunning ?? false)
        ) {
          await this.markRun(schedule.id, due);
          this.skip(schedule, t, 'server_stopped');
          continue;
        }
        if (
          this.options.tasks.activeFor(schedule.serverId, [
            'backup.create',
            'backup.restore',
            'backup.restorePaths',
          ])
        ) {
          this.options.logger.info('scheduled backup skipped: another task is running', {
            id: schedule.id,
            serverId: schedule.serverId,
          });
          await this.markRun(schedule.id, due);
          this.skip(schedule, t, 'task_running');
          continue;
        }
        await this.markRun(schedule.id, due);
        const taskId = ulid(t);
        const req: BackupCreateRequest = {
          serverId: schedule.serverId,
          kind: 'scheduled',
          policyId: schedule.id,
          ...(schedule.keep === undefined ? {} : { keep: schedule.keep }),
          ...(schedule.keepDays === undefined ? {} : { keepDays: schedule.keepDays }),
          ...(schedule.destination === undefined ? {} : { destination: schedule.destination }),
        };
        // `markRun` a déjà consommé l'occurrence : si `start` jette, elle serait perdue sans
        // sauvegarde NI trace, et la politique paraîtrait simplement muette ce jour-là.
        try {
          await this.options.tasks.start(
            { taskId, kind: 'backup.create', serverId: schedule.serverId, payload: req },
            (ctx) => this.options.backups.create(req, ctx),
          );
        } catch (error) {
          this.options.logger.warn('scheduled backup could not start', {
            id: schedule.id,
            serverId: schedule.serverId,
            error: errorMessage(error),
          });
          this.skip(schedule, t, 'start_failed', errorMessage(error));
          continue;
        }
        this.options.logger.info('scheduled backup started', {
          id: schedule.id,
          serverId: schedule.serverId,
          taskId,
        });
        started.push(taskId);
      }
    } finally {
      this.ticking = false;
    }
    return started;
  }

  /**
   * Prévient le panel qu'une occurrence n'a pas été exécutée, et pourquoi. **Jamais fatal** : une
   * notification qui échoue ne doit pas interrompre le tick, sinon les plannings suivants ne
   * seraient pas évalués du tout — un signalement casserait plus que ce qu'il rapporte.
   */
  private skip(
    schedule: BackupSchedule,
    ts: number,
    reason: 'server_stopped' | 'task_running' | 'invalid_cron' | 'start_failed',
    detail?: string,
  ): void {
    try {
      this.options.onSkipped?.({
        serverId: schedule.serverId,
        policyId: schedule.id,
        ts,
        reason,
        ...(detail === undefined ? {} : { detail: detail.slice(0, 500) }),
      });
    } catch (error) {
      this.options.logger.warn('could not report a skipped backup occurrence', {
        id: schedule.id,
        error: errorMessage(error),
      });
    }
  }

  private async markRun(scheduleId: string, at: number): Promise<void> {
    await this.options.store.update((s) => {
      s.backupScheduleRuns[scheduleId] = at;
    });
  }

  /** Oublie l'historique des plannings disparus. */
  async prune(): Promise<void> {
    const ids = new Set(this.options.store.get().backupSchedules.map((s) => s.id));
    await this.options.store.update((s) => {
      for (const id of Object.keys(s.backupScheduleRuns)) {
        if (!ids.has(id)) {
          const { [id]: _gone, ...rest } = s.backupScheduleRuns;
          s.backupScheduleRuns = rest;
        }
      }
    });
  }
}
