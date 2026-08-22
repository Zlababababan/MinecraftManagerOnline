/**
 * Planificateur du panel (doc 04 §5 `scheduled_tasks`) : start/stop/restart programmés, commandes
 * et annonces — **exécutés par le panel** (l'agent n'exécute seul que les backups). Évaluation toutes
 * les 30 s en heure locale du panel ; `next_run_at` recalculé après chaque exécution ; les
 * avertissements (`warnMinutes`) avant un stop/restart sont des `say` envoyés à l'approche de
 * l'échéance. Une occurrence manquée (panel éteint) n'est pas rattrapée. Chaque exécution laisse un
 * événement `schedule.run` (et une entrée d'audit), visible dans le journal.
 */
import type { ScheduledTaskDto, ScheduledTaskInput, SchedulePayload } from '@mmo/protocol/client';
import { nextCronRun } from '@mmo/shared';
import { ProtocolError, ulid } from '@mmo/protocol';
import { asc, eq } from 'drizzle-orm';

import type { AgentRegistry } from '../agents/registry.js';
import type { MmoDatabase } from '../db/client.js';
import { scheduledTasks, type ScheduledTaskRow } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { parseJson, toJson } from '../util/json.js';
import type { AuditService } from './audit.js';
import type { PartialInput } from './backups.js';
import type { EventBus } from './events.js';
import type { ServersService } from './servers.js';

export interface SchedulerServiceDeps {
  db: MmoDatabase;
  now: () => number;
  registry: AgentRegistry;
  servers: ServersService;
  events: EventBus;
  audit: AuditService;
  logger: { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void };
  /** Période d'évaluation (défaut 30 s ; 0 = pas de timer, `tick()` manuel). */
  tickMs?: number;
}

const DEFAULT_WARN_MESSAGE = 'Server {action} in {minutes} min';

export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly warned = new Set<string>();
  private ticking = false;

  constructor(private readonly deps: SchedulerServiceDeps) {}

  start(): void {
    const every = this.deps.tickMs ?? 30_000;
    if (every <= 0 || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  // --- CRUD -----------------------------------------------------------------------------------

  list(serverId?: string): ScheduledTaskRow[] {
    return this.deps.db
      .select()
      .from(scheduledTasks)
      .where(serverId === undefined ? undefined : eq(scheduledTasks.serverId, serverId))
      .orderBy(asc(scheduledTasks.createdAt))
      .all();
  }

  get(id: string): ScheduledTaskRow | undefined {
    return this.deps.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get();
  }

  require(id: string): ScheduledTaskRow {
    const row = this.get(id);
    if (!row) throw notFound('scheduled task', id);
    return row;
  }

  toDto(row: ScheduledTaskRow): ScheduledTaskDto {
    return {
      id: row.id,
      serverId: row.serverId,
      action: row.action === 'backup' ? 'command' : row.action,
      cron: row.cron,
      payload: parseJson<SchedulePayload | null>(row.payload, null),
      enabled: row.enabled === 1,
      lastRunAt: row.lastRunAt,
      lastStatus: row.lastStatus,
      nextRunAt: row.nextRunAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }

  create(serverId: string, input: ScheduledTaskInput, createdBy?: string): ScheduledTaskRow {
    this.validate(input.action, input.cron, input.payload ?? null);
    const id = ulid(this.deps.now());
    const enabled = input.enabled !== false;
    this.deps.db
      .insert(scheduledTasks)
      .values({
        id,
        serverId,
        action: input.action,
        cron: input.cron,
        payload:
          input.payload === undefined || input.payload === null ? null : toJson(input.payload),
        enabled: enabled ? 1 : 0,
        nextRunAt: enabled ? (nextCronRun(input.cron, this.deps.now()) ?? null) : null,
        createdBy: createdBy ?? null,
        createdAt: this.deps.now(),
      })
      .run();
    return this.require(id);
  }

  update(id: string, input: PartialInput<ScheduledTaskInput>): ScheduledTaskRow {
    const row = this.require(id);
    const action = input.action ?? (row.action === 'backup' ? 'command' : row.action);
    const cron = input.cron ?? row.cron;
    const payload =
      input.payload === undefined
        ? parseJson<SchedulePayload | null>(row.payload, null)
        : input.payload;
    this.validate(action, cron, payload);
    const enabled = input.enabled ?? row.enabled === 1;
    this.deps.db
      .update(scheduledTasks)
      .set({
        action,
        cron,
        payload: payload === null ? null : toJson(payload),
        enabled: enabled ? 1 : 0,
        nextRunAt: enabled ? (nextCronRun(cron, this.deps.now()) ?? null) : null,
      })
      .where(eq(scheduledTasks.id, id))
      .run();
    return this.require(id);
  }

  delete(id: string): void {
    this.require(id);
    this.deps.db.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).run();
  }

  private validate(action: string, cron: string, payload: SchedulePayload | null): void {
    if (nextCronRun(cron, 0) === undefined) {
      throw new AppError('E_VALIDATION', 'invalid cron expression', {
        details: { field: 'cron', value: cron },
      });
    }
    if (action === 'command' && (payload?.command === undefined || payload.command.trim() === '')) {
      throw new AppError('E_VALIDATION', 'command required', { details: { field: 'command' } });
    }
    if (
      action === 'announce' &&
      (payload?.message === undefined || payload.message.trim() === '')
    ) {
      throw new AppError('E_VALIDATION', 'message required', { details: { field: 'message' } });
    }
  }

  // --- Exécution ------------------------------------------------------------------------------

  /** Évalue les échéances (et les avertissements) ; retourne les IDs exécutés. */
  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const ran: string[] = [];
    try {
      const t = this.deps.now();
      for (const row of this.list()) {
        if (row.enabled !== 1) continue;
        let next = row.nextRunAt;
        if (next === null) {
          // Ligne ancienne sans échéance : on la calcule maintenant.
          next = nextCronRun(row.cron, t) ?? null;
          this.deps.db
            .update(scheduledTasks)
            .set({ nextRunAt: next })
            .where(eq(scheduledTasks.id, row.id))
            .run();
          continue;
        }
        await this.sendWarnings(row, next, t);
        if (next > t) continue;
        ran.push(row.id);
        const status = await this.run(row, next);
        const following = nextCronRun(row.cron, t) ?? null;
        this.deps.db
          .update(scheduledTasks)
          .set({ lastRunAt: t, lastStatus: status, nextRunAt: following })
          .where(eq(scheduledTasks.id, row.id))
          .run();
        for (const key of this.warned) if (key.startsWith(`${row.id}:`)) this.warned.delete(key);
      }
    } finally {
      this.ticking = false;
    }
    return ran;
  }

  private async sendWarnings(row: ScheduledTaskRow, next: number, t: number): Promise<void> {
    if (row.action !== 'stop' && row.action !== 'restart') return;
    const payload = parseJson<SchedulePayload | null>(row.payload, null);
    const minutes = payload?.warnMinutes ?? [];
    if (minutes.length === 0 || row.serverId === null) return;
    for (const m of minutes) {
      const key = `${row.id}:${String(next)}:${String(m)}`;
      const at = next - m * 60_000;
      // Fenêtre d'une période d'évaluation : pas d'avertissement en retard de plusieurs minutes.
      if (t < at || t - at > 90_000 || this.warned.has(key)) continue;
      this.warned.add(key);
      const message = (payload?.message ?? DEFAULT_WARN_MESSAGE)
        .replace('{minutes}', String(m))
        .replace('{action}', row.action);
      await this.command(row.serverId, `say ${message}`).catch((error: unknown) => {
        this.deps.logger.warn({ id: row.id, err: error }, 'scheduled warning failed');
      });
    }
  }

  private async command(serverId: string, command: string): Promise<void> {
    const server = this.deps.servers.require(serverId);
    const session = this.deps.registry.require(server.machineId);
    await session.peer.request('server.command', { serverId, command });
  }

  /** Exécute l'action ; retourne `ok` ou un code d'erreur (journalisé, jamais levé). */
  async run(row: ScheduledTaskRow, dueAt: number): Promise<string> {
    const payload = parseJson<SchedulePayload | null>(row.payload, null);
    const serverId = row.serverId;
    let status = 'ok';
    let message: string | undefined;
    try {
      if (serverId === null) throw new AppError('E_NOT_FOUND', 'scheduled task without server');
      const server = this.deps.servers.require(serverId);
      const session = this.deps.registry.require(server.machineId);
      const peer = session.peer;
      switch (row.action) {
        case 'start':
          await peer.request('server.start', { serverId });
          break;
        case 'stop':
          await peer.request('server.stop', {
            serverId,
            ...(payload?.timeoutSec === undefined ? {} : { timeoutSec: payload.timeoutSec }),
            forceAfterTimeout: true,
          });
          break;
        case 'restart':
          await peer.request(
            'server.restart',
            {
              serverId,
              ...(payload?.timeoutSec === undefined ? {} : { timeoutSec: payload.timeoutSec }),
            },
            { deadlineMs: 300_000 },
          );
          break;
        case 'command':
          await peer.request('server.command', { serverId, command: payload?.command ?? '' });
          break;
        case 'announce':
          await peer.request('server.command', {
            serverId,
            command: `say ${payload?.message ?? ''}`,
          });
          break;
        case 'backup':
          status = 'unsupported';
          break;
      }
    } catch (error) {
      status =
        error instanceof AppError || error instanceof ProtocolError ? error.code : 'E_INTERNAL';
      message = error instanceof Error ? error.message : String(error);
    }
    this.deps.events.publish({
      type: 'schedule.run',
      severity: status === 'ok' ? 'info' : 'warning',
      ...(serverId === null ? {} : { serverId }),
      payload: { scheduleId: row.id, action: row.action, status, message: message ?? null, dueAt },
    });
    this.deps.audit.record({
      action: `schedule.${row.action}`,
      targetType: 'server',
      targetId: serverId ?? undefined,
      details: { scheduleId: row.id, status, dueAt },
    });
    if (status !== 'ok') {
      this.deps.logger.warn(
        { id: row.id, action: row.action, status, message },
        'scheduled action failed',
      );
    }
    return status;
  }
}
