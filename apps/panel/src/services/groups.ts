/**
 * Groupes de démarrage (lot 7) : CRUD des groupes + actions ordonnées. `start` parcourt les
 * membres par rang croissant et ATTEND l'état `running` (publié par l'agent) avant de passer au
 * suivant — les serveurs cibles d'un proxy Velocity démarrent avant lui ; `stop` parcourt en ordre
 * inverse et attend `stopped` ; `restart` enchaîne les deux. La série s'arrête au premier échec :
 * un démarrage refusé ou expiré est signalé (`server.startFailed`), les serveurs déjà traités
 * restent dans leur nouvel état. L'appartenance à un groupe se règle serveur par serveur
 * (`PATCH /api/servers/:id`, champs `groupId`/`groupPosition`).
 */
import { ulid, ProtocolError } from '@mmo/protocol';
import type { GroupAction, ServerGroupDto } from '@mmo/protocol/client';
import { asc, eq } from 'drizzle-orm';

import type { AgentRegistry } from '../agents/registry.js';
import type { MmoDatabase } from '../db/client.js';
import { serverGroups, type ServerGroupRow, type ServerRow } from '../db/schema.js';
import { AppError, conflict, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import type { EventBus } from './events.js';
import type { ServersService } from './servers.js';

export interface GroupsDeps {
  db: MmoDatabase;
  now: () => number;
  servers: ServersService;
  registry: AgentRegistry;
  events: EventBus;
  audit: AuditService;
  logger: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
  /** Attente d'état après un ordre (démarrage long des gros modpacks ; l'agent force un stop à 120 s). */
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollMs?: number;
}

export class ServerGroupsService {
  /** Une seule action à la fois par groupe. */
  private readonly activeRuns = new Set<string>();

  constructor(private readonly deps: GroupsDeps) {}

  // --- Lecture --------------------------------------------------------------------------------

  list(): ServerGroupRow[] {
    return this.deps.db.select().from(serverGroups).orderBy(asc(serverGroups.name)).all();
  }

  get(id: string): ServerGroupRow | undefined {
    return this.deps.db.select().from(serverGroups).where(eq(serverGroups.id, id)).get();
  }

  require(id: string): ServerGroupRow {
    const row = this.get(id);
    if (!row) throw notFound('group', id);
    return row;
  }

  toDto(row: ServerGroupRow): ServerGroupDto {
    return { id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  isRunning(id: string): boolean {
    return this.activeRuns.has(id);
  }

  // --- CRUD -----------------------------------------------------------------------------------

  create(name: string, userId: string | undefined): ServerGroupRow {
    if (this.list().some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('a group with this name already exists');
    }
    const t = this.deps.now();
    const row: ServerGroupRow = { id: ulid(t), name, createdAt: t, updatedAt: t };
    this.deps.db.insert(serverGroups).values(row).run();
    this.deps.audit.record({
      action: 'group.created',
      targetType: 'group',
      targetId: row.id,
      targetLabel: name,
      userId,
    });
    return row;
  }

  rename(id: string, name: string, userId: string | undefined): ServerGroupRow {
    const row = this.require(id);
    if (this.list().some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('a group with this name already exists');
    }
    this.deps.db
      .update(serverGroups)
      .set({ name, updatedAt: this.deps.now() })
      .where(eq(serverGroups.id, id))
      .run();
    this.deps.audit.record({
      action: 'group.renamed',
      targetType: 'group',
      targetId: id,
      targetLabel: name,
      userId,
      details: { previous: row.name },
    });
    return this.require(id);
  }

  /** Les membres sont détachés (FK ON DELETE SET NULL), jamais supprimés. */
  delete(id: string, userId: string | undefined): void {
    const row = this.require(id);
    if (this.activeRuns.has(id)) throw new AppError('E_BUSY', 'a group action is running');
    this.deps.db.delete(serverGroups).where(eq(serverGroups.id, id)).run();
    this.deps.audit.record({
      action: 'group.deleted',
      targetType: 'group',
      targetId: id,
      targetLabel: row.name,
      userId,
    });
  }

  // --- Actions ordonnées ----------------------------------------------------------------------

  /** Lance l'action en arrière-plan ; l'appelant reçoit un 202 et suit les états serveurs. */
  run(id: string, action: GroupAction, userId: string | undefined): void {
    const group = this.require(id);
    const members = this.deps.servers.listByGroup(id);
    if (members.length === 0) throw conflict('the group has no member');
    if (this.activeRuns.has(id)) {
      throw new AppError('E_BUSY', 'a group action is already running for this group');
    }
    // Toutes les machines concernées doivent être joignables AVANT de toucher au premier serveur.
    for (const row of members) this.deps.registry.require(row.machineId);
    this.activeRuns.add(id);
    void this.execute(group, members, action, userId)
      .catch((error: unknown) => {
        this.deps.logger.warn(
          { groupId: id, action, err: error },
          'group action aborted on first failure',
        );
      })
      .finally(() => {
        this.activeRuns.delete(id);
      });
  }

  private async execute(
    group: ServerGroupRow,
    members: ServerRow[],
    action: GroupAction,
    userId: string | undefined,
  ): Promise<void> {
    if (action === 'stop' || action === 'restart') {
      for (const row of [...members].reverse()) await this.stopOne(row, userId);
    }
    if (action === 'start' || action === 'restart') {
      for (const row of members) await this.startOne(group, row, userId);
    }
  }

  private async startOne(
    group: ServerGroupRow,
    member: ServerRow,
    userId: string | undefined,
  ): Promise<void> {
    const row = this.deps.servers.require(member.id);
    if (row.runState === 'running') return;
    if (row.provisioning !== 'ready') {
      const error = conflict(`server is ${row.provisioning}`, { provisioning: row.provisioning });
      this.publishStartFailed(group, row, error, userId);
      throw error;
    }
    const session = this.deps.registry.require(row.machineId);
    this.deps.servers.setDesiredState(row.id, 'running');
    try {
      await session.pushConfig();
      await session.peer.request(
        'server.start',
        { serverId: row.id },
        userId === undefined ? {} : { userId },
      );
    } catch (error) {
      // Même geste que la route de démarrage : desiredState ne doit pas mentir.
      this.deps.servers.setDesiredState(row.id, 'stopped');
      await session.pushConfig().catch(() => undefined);
      this.publishStartFailed(group, row, error, userId);
      throw error;
    }
    const outcome = await this.waitFor(row.id, 'running', this.deps.startTimeoutMs ?? 180_000);
    if (outcome !== 'ok') {
      const error = new AppError(
        outcome === 'crashed' ? 'E_CONFLICT' : 'E_TIMEOUT',
        outcome === 'crashed'
          ? 'server crashed while the group was starting'
          : 'server did not reach the running state in time',
        { details: { serverId: row.id } },
      );
      // Timeout : l'intention de démarrage reste posée (le serveur peut encore aboutir) ;
      // seul l'enchaînement du groupe s'arrête, et l'échec est signalé.
      this.publishStartFailed(group, row, error, userId);
      throw error;
    }
  }

  private async stopOne(member: ServerRow, userId: string | undefined): Promise<void> {
    const row = this.deps.servers.require(member.id);
    const session = this.deps.registry.require(row.machineId);
    if (row.runState === 'stopped') {
      if (row.desiredState !== 'stopped') {
        this.deps.servers.setDesiredState(row.id, 'stopped');
        await session.pushConfig().catch(() => undefined);
      }
      return;
    }
    this.deps.servers.setDesiredState(row.id, 'stopped');
    await session.pushConfig();
    await session.peer.request(
      'server.stop',
      { serverId: row.id },
      userId === undefined ? { deadlineMs: 180_000 } : { userId, deadlineMs: 180_000 },
    );
    const outcome = await this.waitFor(row.id, 'stopped', this.deps.stopTimeoutMs ?? 150_000);
    if (outcome === 'timeout') {
      throw new AppError('E_TIMEOUT', 'server did not stop in time', {
        details: { serverId: row.id },
      });
    }
  }

  /**
   * Attend l'état voulu en relisant la base (mise à jour par les événements de l'agent).
   * `crashed` interrompt une attente de `running` ; il VAUT `stopped` pour une attente d'arrêt.
   */
  private async waitFor(
    serverId: string,
    state: 'running' | 'stopped',
    timeoutMs: number,
  ): Promise<'ok' | 'crashed' | 'timeout'> {
    const poll = this.deps.pollMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = this.deps.servers.get(serverId);
      if (row === undefined) return 'crashed';
      if (row.runState === state) return 'ok';
      if (row.runState === 'crashed') return state === 'stopped' ? 'ok' : 'crashed';
      if (Date.now() > deadline) return 'timeout';
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }

  private publishStartFailed(
    group: ServerGroupRow,
    row: ServerRow,
    error: unknown,
    userId: string | undefined,
  ): void {
    this.deps.events.publish({
      type: 'server.startFailed',
      severity: 'error',
      machineId: row.machineId,
      serverId: row.id,
      userId,
      payload: {
        code:
          error instanceof ProtocolError || error instanceof AppError ? error.code : 'E_INTERNAL',
        message: error instanceof Error ? error.message : String(error),
        group: group.name,
      },
    });
  }
}
