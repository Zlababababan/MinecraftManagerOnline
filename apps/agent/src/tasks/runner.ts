/**
 * Exécution des tasks (jalon B) : journal write-ahead, progression (`task.progress`, ≤ 2/s sauf
 * changement de phase), annulation coopérative (`AbortSignal`), issue `task.completed` /
 * `task.failed` (événements critiques : journalisés par la connexion et rejoués jusqu'à `event.ack`).
 * Idempotence par `taskId` : une requête rejouée (même `taskId`) ne relance pas la task.
 */
import { rm } from 'node:fs/promises';

import { ProtocolError, isProtocolError, type EventPayload, type TaskInfo } from '@mmo/protocol';

import { errorMessage, type Logger } from '../log.js';
import { TaskJournal, type TaskRecord } from './journal.js';

export interface TaskContext {
  readonly taskId: string;
  readonly signal: AbortSignal;
  /** Annulation demandée (`task.cancel`) ; l'exécuteur doit s'arrêter au plus vite. */
  readonly isCancelled: boolean;
  throwIfCancelled(): void;
  progress(phase: string, pct?: number, detail?: string, etaSec?: number): void;
  /** Déclare un artefact partiel (supprimé si la task échoue ou est interrompue). */
  artifact(file: string): void;
  /** L'artefact est finalisé (ne plus le supprimer). */
  keep(file: string): void;
  /** Écrit le journal immédiatement (avant une étape irréversible). */
  checkpoint(): Promise<void>;
}

export interface TaskDefinition {
  taskId: string;
  kind: string;
  serverId?: string | undefined;
  payload?: unknown;
}

export type TaskExecutor = (ctx: TaskContext) => Promise<Record<string, unknown>>;

export type TaskEventEmitter = <T extends 'task.progress' | 'task.completed' | 'task.failed'>(
  type: T,
  payload: EventPayload<T> | ((eventId: string) => EventPayload<T>),
) => void;

export interface TaskRunnerOptions {
  journal: TaskJournal;
  logger: Logger;
  emit: TaskEventEmitter;
  now?: () => number;
  /** Intervalle minimal entre deux `task.progress` d'une même phase (défaut 500 ms). */
  progressIntervalMs?: number;
}

interface Active {
  record: TaskRecord;
  controller: AbortController;
  promise: Promise<void>;
  lastProgressAt: number;
}

export class TaskRunner {
  private readonly active = new Map<string, Active>();
  private readonly now: () => number;

  constructor(private readonly options: TaskRunnerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get journal(): TaskJournal {
    return this.options.journal;
  }

  get activeCount(): number {
    return this.active.size;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /** Une task de ce genre tourne-t-elle déjà pour ce serveur ? (`E_BUSY` côté appelant) */
  activeFor(serverId: string, kinds?: string[]): TaskRecord | undefined {
    for (const a of this.active.values()) {
      if (a.record.serverId !== serverId) continue;
      if (kinds === undefined || kinds.includes(a.record.kind)) return a.record;
    }
    return undefined;
  }

  /**
   * Démarre la task (ou ne fait rien si `taskId` est déjà connu : rejeu). Retourne une fois le
   * journal écrit ; l'exécution continue en arrière-plan.
   */
  async start(def: TaskDefinition, executor: TaskExecutor): Promise<TaskRecord> {
    const existing = this.options.journal.get(def.taskId);
    if (existing) return existing;
    const t = this.now();
    const record: TaskRecord = {
      taskId: def.taskId,
      kind: def.kind,
      ...(def.serverId === undefined ? {} : { serverId: def.serverId }),
      status: 'running',
      startedAt: t,
      updatedAt: t,
      payload: def.payload,
      artifacts: [],
      acked: false,
    };
    await this.options.journal.put(record);
    const controller = new AbortController();
    const active: Active = { record, controller, promise: Promise.resolve(), lastProgressAt: 0 };
    this.active.set(def.taskId, active);
    active.promise = this.execute(active, executor);
    return record;
  }

  cancel(taskId: string): { cancelled: boolean; status: TaskRecord['status'] | undefined } {
    const active = this.active.get(taskId);
    if (active) {
      active.controller.abort();
      return { cancelled: true, status: 'running' };
    }
    return { cancelled: false, status: this.options.journal.get(taskId)?.status };
  }

  list(): TaskInfo[] {
    return this.options.journal.all().map((r) => this.options.journal.toInfo(r));
  }

  async ack(taskId: string): Promise<void> {
    const r = this.options.journal.get(taskId);
    if (!r || this.active.has(taskId)) return;
    this.options.journal.patch(taskId, (rec) => {
      rec.acked = true;
    });
    this.options.journal.purge();
    await this.options.journal.flush();
  }

  /** Attend la fin d'une task (tests, arrêt de l'agent). */
  async wait(taskId: string): Promise<void> {
    await this.active.get(taskId)?.promise;
  }

  /**
   * Au boot : toute task laissée `running` par une exécution précédente est interrompue
   * (nettoyage des artefacts, `task.failed E_INTERRUPTED` rejouable).
   */
  async recover(): Promise<number> {
    const stale = this.options.journal.running();
    for (const r of stale) {
      await this.cleanupArtifacts(r);
      const t = this.now();
      r.status = 'failed';
      r.finishedAt = t;
      r.updatedAt = t;
      r.error = new ProtocolError('E_INTERRUPTED', 'agent restarted while the task was running', {
        retryable: true,
      }).toPayload();
      r.artifacts = [];
      await this.options.journal.put(r);
      this.emitFailed(r);
    }
    return stale.length;
  }

  /** Annule toutes les tasks actives (arrêt de l'agent) et attend leur fin. */
  async dispose(): Promise<void> {
    for (const a of this.active.values()) a.controller.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
    await this.options.journal.flush();
  }

  // --- Internes -------------------------------------------------------------------------------

  private async execute(active: Active, executor: TaskExecutor): Promise<void> {
    const { record, controller } = active;
    const { journal } = this.options;
    const ctx: TaskContext = {
      taskId: record.taskId,
      signal: controller.signal,
      get isCancelled() {
        return controller.signal.aborted;
      },
      throwIfCancelled: () => {
        if (controller.signal.aborted) {
          throw new ProtocolError('E_CANCELLED', 'task cancelled', { retryable: false });
        }
      },
      progress: (phase, pct, detail, etaSec) => {
        this.onProgress(active, phase, pct, detail, etaSec);
      },
      artifact: (file) => {
        journal.patch(record.taskId, (r) => {
          if (!r.artifacts.includes(file)) r.artifacts.push(file);
        });
      },
      keep: (file) => {
        journal.patch(record.taskId, (r) => {
          r.artifacts = r.artifacts.filter((a) => a !== file);
        });
      },
      checkpoint: () => journal.flush(),
    };
    try {
      const result = await executor(ctx);
      const t = this.now();
      await journal.put({
        ...record,
        status: 'done',
        pct: 100,
        finishedAt: t,
        updatedAt: t,
        result,
        artifacts: [],
      });
      this.active.delete(record.taskId);
      const done = journal.get(record.taskId);
      if (done) this.emitCompleted(done);
    } catch (error) {
      const cancelled =
        controller.signal.aborted || (isProtocolError(error) && error.code === 'E_CANCELLED');
      const perr = isProtocolError(error)
        ? error
        : new ProtocolError('E_INTERNAL', errorMessage(error), { cause: error });
      const current = journal.get(record.taskId) ?? record;
      await this.cleanupArtifacts(current);
      const t = this.now();
      await journal.put({
        ...current,
        status: cancelled ? 'cancelled' : 'failed',
        finishedAt: t,
        updatedAt: t,
        error: (cancelled && perr.code !== 'E_CANCELLED'
          ? new ProtocolError('E_CANCELLED', 'task cancelled', { cause: error })
          : perr
        ).toPayload(),
        cancelled,
        artifacts: [],
      });
      this.active.delete(record.taskId);
      const failed = journal.get(record.taskId);
      if (failed) this.emitFailed(failed);
      this.options.logger[cancelled ? 'info' : 'warn']('task ended', {
        taskId: record.taskId,
        kind: record.kind,
        status: cancelled ? 'cancelled' : 'failed',
        error: perr.code,
        message: perr.message,
      });
    }
  }

  private onProgress(
    active: Active,
    phase: string,
    pct: number | undefined,
    detail: string | undefined,
    etaSec: number | undefined,
  ): void {
    const { record } = active;
    const phaseChanged = record.phase !== phase;
    this.options.journal.patch(record.taskId, (r) => {
      r.phase = phase;
      if (pct !== undefined) r.pct = Math.max(0, Math.min(100, pct));
      if (detail !== undefined) r.detail = detail;
    });
    const t = this.now();
    const interval = this.options.progressIntervalMs ?? 500;
    if (!phaseChanged && t - active.lastProgressAt < interval) return;
    active.lastProgressAt = t;
    this.options.emit('task.progress', {
      taskId: record.taskId,
      kind: record.kind,
      ...(record.serverId === undefined ? {} : { serverId: record.serverId }),
      ts: t,
      phase,
      ...(record.pct === undefined ? {} : { pct: record.pct }),
      ...(detail === undefined ? {} : { detail }),
      ...(etaSec === undefined ? {} : { etaSec }),
    });
  }

  private emitCompleted(r: TaskRecord): void {
    this.options.emit('task.completed', (eventId) => ({
      eventId,
      taskId: r.taskId,
      kind: r.kind,
      ...(r.serverId === undefined ? {} : { serverId: r.serverId }),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? r.updatedAt,
      result: r.result ?? {},
    }));
  }

  private emitFailed(r: TaskRecord): void {
    this.options.emit('task.failed', (eventId) => ({
      eventId,
      taskId: r.taskId,
      kind: r.kind,
      ...(r.serverId === undefined ? {} : { serverId: r.serverId }),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? r.updatedAt,
      error: r.error ?? { code: 'E_INTERNAL', message: 'unknown error', retryable: false },
      cancelled: r.cancelled ?? false,
    }));
  }

  private async cleanupArtifacts(r: TaskRecord): Promise<void> {
    for (const file of r.artifacts) {
      await rm(file, { force: true, recursive: true }).catch((error: unknown) => {
        this.options.logger.warn('artifact cleanup failed', { file, error: errorMessage(error) });
      });
    }
  }
}

export { TaskJournal };
