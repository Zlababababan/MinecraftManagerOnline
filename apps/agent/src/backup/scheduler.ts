/**
 * Plannings de backups **locaux** (doc 05 §5–§6) : poussés par `agent.configure.backupSchedules`,
 * persistés, évalués par l'agent toutes les 30 s en heure locale — un backup nocturne ne dépend pas
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
      return cronNext(spec, base);
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
          continue;
        }
        const last = this.options.store.get().backupScheduleRuns[schedule.id];
        // Une occurrence est due si elle est tombée dans la dernière minute et n'a pas déjà tourné.
        const due = cronNext(spec, t - 60_000);
        if (due === undefined || due > t) continue;
        if (last !== undefined && last >= due) continue;
        if (!this.options.store.getServer(schedule.serverId)) continue;
        if (
          schedule.onlyIfRunning &&
          !(this.options.manager.get(schedule.serverId)?.isRunning ?? false)
        ) {
          await this.markRun(schedule.id, due);
          continue;
        }
        if (this.options.tasks.activeFor(schedule.serverId, ['backup.create', 'backup.restore'])) {
          this.options.logger.info('scheduled backup skipped: another task is running', {
            id: schedule.id,
            serverId: schedule.serverId,
          });
          await this.markRun(schedule.id, due);
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
        await this.options.tasks.start(
          { taskId, kind: 'backup.create', serverId: schedule.serverId, payload: req },
          (ctx) => this.options.backups.create(req, ctx),
        );
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
