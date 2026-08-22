/**
 * Tasks côté panel (doc 04 §5 `tasks`, doc 05 §6 jalon B) : une ligne par opération longue lancée
 * auprès d'un agent (ou découverte chez lui : backups planifiés exécutés panel éteint). Progression
 * en mémoire diffusée aux navigateurs (`task.update`), issue persistée depuis `task.completed` /
 * `task.failed`, réconciliation via `task.list` à chaque `sync.state` (le panel survit à son propre
 * redémarrage), `stalled` quand l'agent tombe en cours de route.
 */
import type { ProtocolErrorPayload, TaskInfo } from '@mmo/protocol';
import type { ApiError, TaskDto } from '@mmo/protocol/client';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import { tasks, type TaskRow } from '../db/schema.js';
import { notFound } from '../errors.js';
import { parseJson, toJson } from '../util/json.js';

export interface TasksServiceDeps {
  db: MmoDatabase;
  now: () => number;
  /** Diffusion aux navigateurs. */
  broadcast: (task: TaskDto) => void;
}

export interface CreateTaskInput {
  id: string;
  kind: string;
  machineId: string;
  serverId?: string | undefined;
  request?: unknown;
  refId?: string | undefined;
  createdBy?: string | undefined;
}

interface TaskPayload {
  request?: unknown;
  result?: Record<string, unknown>;
}

interface LiveProgress {
  phase: string | undefined;
  detail: string | undefined;
}

export interface TasksQuery {
  status?: TaskDto['status'] | undefined;
  active?: boolean | undefined;
  serverId?: string | undefined;
  machineId?: string | undefined;
  limit?: number | undefined;
}

const ACTIVE: TaskDto['status'][] = ['pending', 'running', 'stalled'];

export class TasksService {
  private readonly live = new Map<string, LiveProgress>();

  constructor(private readonly deps: TasksServiceDeps) {}

  // --- Lecture --------------------------------------------------------------------------------

  get(id: string): TaskRow | undefined {
    return this.deps.db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  require(id: string): TaskRow {
    const row = this.get(id);
    if (!row) throw notFound('task', id);
    return row;
  }

  list(query: TasksQuery = {}): TaskRow[] {
    const conditions = [];
    if (query.status !== undefined) conditions.push(eq(tasks.status, query.status));
    if (query.active) conditions.push(inArray(tasks.status, ACTIVE));
    if (query.serverId !== undefined) conditions.push(eq(tasks.serverId, query.serverId));
    if (query.machineId !== undefined) conditions.push(eq(tasks.machineId, query.machineId));
    return this.deps.db
      .select()
      .from(tasks)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(tasks.createdAt))
      .limit(query.limit ?? 100)
      .all();
  }

  /** Tasks non terminées d'une machine (réconciliation). */
  activeFor(machineId: string): TaskRow[] {
    return this.deps.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.machineId, machineId), inArray(tasks.status, ACTIVE)))
      .all();
  }

  toDto(row: TaskRow): TaskDto {
    const payload = parseJson<TaskPayload>(row.payload, {});
    const live = this.live.get(row.id);
    return {
      id: row.id,
      kind: row.kind,
      machineId: row.machineId,
      serverId: row.serverId,
      status: row.status,
      progress: row.progress,
      phase: live?.phase ?? null,
      detail: live?.detail ?? null,
      refId: row.refId,
      result: payload.result ?? null,
      error: parseJson<ApiError | null>(row.error, null),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    };
  }

  // --- Cycle de vie ---------------------------------------------------------------------------

  /** Enregistre la task **avant** d'envoyer l'ordre à l'agent (le panel peut redémarrer entre-temps). */
  create(input: CreateTaskInput): TaskRow {
    const row = {
      id: input.id,
      kind: input.kind,
      machineId: input.machineId,
      serverId: input.serverId ?? null,
      status: 'pending' as const,
      progress: 0,
      payload: toJson({ request: input.request } satisfies TaskPayload),
      refId: input.refId ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: this.deps.now(),
      finishedAt: null,
      error: null,
    };
    this.deps.db.insert(tasks).values(row).run();
    this.emit(row.id);
    return this.require(row.id);
  }

  markRunning(id: string): void {
    this.deps.db
      .update(tasks)
      .set({ status: 'running' })
      .where(and(eq(tasks.id, id), inArray(tasks.status, ['pending', 'stalled'])))
      .run();
    this.emit(id);
  }

  progress(
    id: string,
    p: { pct?: number | undefined; phase: string; detail?: string | undefined },
  ): void {
    const row = this.get(id);
    if (!row || !ACTIVE.includes(row.status)) return;
    this.live.set(id, { phase: p.phase, detail: p.detail });
    this.deps.db
      .update(tasks)
      .set({
        status: 'running',
        ...(p.pct === undefined ? {} : { progress: Math.max(0, Math.min(100, p.pct)) }),
      })
      .where(eq(tasks.id, id))
      .run();
    this.emit(id);
  }

  /** Issue favorable ; idempotent (un rejeu ne réécrit pas une task déjà terminée). */
  complete(id: string, result: Record<string, unknown>, finishedAt?: number): TaskRow | undefined {
    const row = this.get(id);
    if (!row || !ACTIVE.includes(row.status)) return row;
    const payload = parseJson<TaskPayload>(row.payload, {});
    this.deps.db
      .update(tasks)
      .set({
        status: 'done',
        progress: 100,
        payload: toJson({ ...payload, result } satisfies TaskPayload),
        finishedAt: finishedAt ?? this.deps.now(),
        error: null,
      })
      .where(eq(tasks.id, id))
      .run();
    this.live.delete(id);
    this.emit(id);
    return this.get(id);
  }

  fail(
    id: string,
    error: ProtocolErrorPayload | ApiError,
    options: { cancelled?: boolean | undefined; finishedAt?: number | undefined } = {},
  ): TaskRow | undefined {
    const row = this.get(id);
    if (!row || !ACTIVE.includes(row.status)) return row;
    this.deps.db
      .update(tasks)
      .set({
        status: options.cancelled ? 'cancelled' : 'failed',
        finishedAt: options.finishedAt ?? this.deps.now(),
        error: toJson(error),
      })
      .where(eq(tasks.id, id))
      .run();
    this.live.delete(id);
    this.emit(id);
    return this.get(id);
  }

  /** Agent hors ligne : ses tasks en cours deviennent `stalled` (reprises ou clôturées à la reconnexion). */
  markStalled(machineId: string): TaskRow[] {
    const rows = this.activeFor(machineId);
    for (const row of rows) {
      if (row.status === 'stalled') continue;
      this.deps.db.update(tasks).set({ status: 'stalled' }).where(eq(tasks.id, row.id)).run();
      this.emit(row.id);
    }
    return rows;
  }

  /**
   * Réconciliation avec le journal de l'agent (`task.list`) :
   * - task connue des deux côtés : l'état de l'agent fait foi (terminée ⇒ clôturée ici) ;
   * - task active ici mais inconnue de l'agent : échouée `E_INTERRUPTED` (réessayable) ;
   * - task connue de l'agent seulement (planning exécuté panel éteint) : créée ici.
   * Retourne les tasks créées ou clôturées par cette passe (pour les services métier).
   */
  reconcile(
    machineId: string,
    agentTasks: TaskInfo[],
    resolveServer: (serverId: string | undefined) => string | undefined,
  ): { discovered: TaskRow[]; finished: TaskRow[] } {
    const discovered: TaskRow[] = [];
    const finished: TaskRow[] = [];
    const byId = new Map(agentTasks.map((t) => [t.taskId, t]));
    for (const row of this.activeFor(machineId)) {
      const remote = byId.get(row.id);
      if (!remote) {
        const failed = this.fail(row.id, {
          code: 'E_INTERRUPTED',
          message: 'task unknown to the agent after reconnection',
          retryable: true,
        });
        if (failed) finished.push(failed);
        continue;
      }
      this.applyRemote(row, remote, finished);
    }
    for (const remote of agentTasks) {
      if (this.get(remote.taskId)) continue;
      const serverId = resolveServer(remote.serverId);
      const created = this.create({
        id: remote.taskId,
        kind: remote.kind,
        machineId,
        serverId,
      });
      this.deps.db
        .update(tasks)
        .set({ createdAt: remote.startedAt })
        .where(eq(tasks.id, remote.taskId))
        .run();
      const row = this.require(created.id);
      if (remote.status === 'running' || remote.status === 'pending') {
        this.markRunning(row.id);
        discovered.push(this.require(row.id));
      } else {
        this.applyRemote(row, remote, finished);
        discovered.push(this.require(row.id));
      }
    }
    return { discovered, finished };
  }

  private applyRemote(row: TaskRow, remote: TaskInfo, finished: TaskRow[]): void {
    switch (remote.status) {
      case 'done': {
        const done = this.complete(row.id, remote.result ?? {}, remote.finishedAt);
        if (done) finished.push(done);
        return;
      }
      case 'failed':
      case 'cancelled': {
        const failed = this.fail(
          row.id,
          remote.error ?? { code: 'E_INTERNAL', message: 'unknown error', retryable: false },
          { cancelled: remote.status === 'cancelled', finishedAt: remote.finishedAt },
        );
        if (failed) finished.push(failed);
        return;
      }
      case 'running':
      case 'pending':
        this.markRunning(row.id);
        if (remote.phase !== undefined || remote.pct !== undefined) {
          this.progress(row.id, { phase: remote.phase ?? 'running', pct: remote.pct });
        }
        return;
    }
  }

  purgeOlderThan(ts: number): number {
    const old = this.deps.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.status, ['done', 'failed', 'cancelled']))
      .all()
      .filter((r) => (this.get(r.id)?.finishedAt ?? 0) < ts);
    if (old.length === 0) return 0;
    this.deps.db
      .delete(tasks)
      .where(
        inArray(
          tasks.id,
          old.map((r) => r.id),
        ),
      )
      .run();
    return old.length;
  }

  private emit(id: string): void {
    const row = this.get(id);
    if (row) this.deps.broadcast(this.toDto(row));
  }
}
