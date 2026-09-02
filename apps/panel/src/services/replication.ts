/**
 * Lot 4 — réplication hors-site (doc 02 §7, doc 04 §5, doc 05 §6). Chaque archive réussie d'un
 * serveur (manuelle ou planifiée — jamais `pre_migration`/`pre_restore`, transitoires) est copiée
 * sur une AUTRE machine du parc par la chaîne de migration : `transfer.serve` sur la source
 * (listener direct + jeton), relais panel en repli, `backup.receive` sur la destination (reprise
 * `Range`, sha256, manifeste réécrit, rotation `keep` locale). L'original garde sa rétention, la
 * copie la sienne. Un original disparu (rotation, disque perdu) se **rapatrie** par le même message
 * dans l'autre sens : la destination sert, la machine du serveur reçoit, la fiche redevient
 * `success`. Rattrapage à la reconnexion de la destination (la dernière archive sans copie part),
 * réconciliation par `backup.list` (copies rotées ou disparues → `deleted`, copies retrouvées →
 * réinsérées). Le panel n'ordonne jamais deux copies de la même archive vers la même machine.
 */
import path from 'node:path';

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { backupReceiveResultSchema, ulid, type BackupManifest } from '@mmo/protocol';
import type { BackupReplicaDto, ReplicationDto, ReplicationInput } from '@mmo/protocol/client';

import type { AgentRegistry } from '../agents/registry.js';
import type { MmoDatabase } from '../db/client.js';
import {
  backupReplicas,
  backupReplication,
  type BackupReplicaRow,
  type BackupReplicationRow,
  type BackupRow,
  type TaskRow,
} from '../db/schema.js';
import { AppError } from '../errors.js';
import type { BackupsService } from './backups.js';
import type { MachinesService } from './machines.js';
import { relayUrl, type RelayTokens } from './relay.js';
import type { ServersService } from './servers.js';
import type { TasksService } from './tasks.js';
import { parseJson } from '../util/json.js';

export interface ReplicationDeps {
  db: MmoDatabase;
  now: () => number;
  registry: AgentRegistry;
  servers: ServersService;
  machines: MachinesService;
  tasks: TasksService;
  backups: BackupsService;
  relay: RelayTokens;
  logger: FastifyBaseLogger;
  /** TTL du listener direct et du jeton relais (défaut 1 h, comme les migrations). */
  ttlMs?: number | undefined;
}

interface TransferSource {
  url: string;
  kind: 'direct' | 'relay';
  headers?: Record<string, string>;
}

/** Ce que la task `backup.receive` du panel garde de sa requête (`tasks.payload.request`). */
interface ReceiveRequest {
  backupId?: string;
  fromMachineId?: string;
  replicaId?: string;
  pullBack?: boolean;
}

function fileNameOf(manifest: BackupManifest): string {
  return manifest.archivePath.split(/[\\/]/).pop() ?? `${manifest.backupId}.tar.gz`;
}

export class ReplicationService {
  constructor(private readonly deps: ReplicationDeps) {}

  // --- Réglage ------------------------------------------------------------------------------------

  config(serverId: string): BackupReplicationRow | undefined {
    return this.deps.db
      .select()
      .from(backupReplication)
      .where(eq(backupReplication.serverId, serverId))
      .get();
  }

  configDto(row: BackupReplicationRow): ReplicationDto {
    return {
      serverId: row.serverId,
      machineId: row.machineId,
      keepLast: row.keepLast,
      enabled: row.enabled === 1,
      updatedAt: row.updatedAt,
    };
  }

  /** `machineId: null` retire le réglage ; la destination doit exister et différer de la machine du serveur. */
  setConfig(serverId: string, input: ReplicationInput): ReplicationDto | null {
    const server = this.deps.servers.require(serverId);
    if (input.machineId === null) {
      this.deps.db.delete(backupReplication).where(eq(backupReplication.serverId, serverId)).run();
      return null;
    }
    if (this.deps.machines.get(input.machineId) === undefined) {
      throw new AppError('E_NOT_FOUND', `machine ${input.machineId} not found`);
    }
    if (input.machineId === server.machineId) {
      throw new AppError('E_VALIDATION', 'the off-site copy must live on another machine', {
        details: { key: 'machineId', reason: 'SAME_MACHINE' },
      });
    }
    const existing = this.config(serverId);
    const values = {
      machineId: input.machineId,
      keepLast: input.keepLast ?? existing?.keepLast ?? 7,
      enabled: (input.enabled ?? (existing === undefined ? true : existing.enabled === 1)) ? 1 : 0,
      updatedAt: this.deps.now(),
    };
    if (existing) {
      this.deps.db
        .update(backupReplication)
        .set(values)
        .where(eq(backupReplication.serverId, serverId))
        .run();
    } else {
      this.deps.db
        .insert(backupReplication)
        .values({ serverId, ...values })
        .run();
    }
    const row = this.config(serverId);
    return row === undefined ? null : this.configDto(row);
  }

  // --- Copies -------------------------------------------------------------------------------------

  replicas(serverId: string, includeDeleted = false): BackupReplicaRow[] {
    return this.deps.db
      .select()
      .from(backupReplicas)
      .where(
        includeDeleted
          ? eq(backupReplicas.serverId, serverId)
          : and(
              eq(backupReplicas.serverId, serverId),
              inArray(backupReplicas.status, ['running', 'success', 'failed']),
            ),
      )
      .orderBy(desc(backupReplicas.startedAt))
      .all();
  }

  get(id: string): BackupReplicaRow | undefined {
    return this.deps.db.select().from(backupReplicas).where(eq(backupReplicas.id, id)).get();
  }

  require(id: string): BackupReplicaRow {
    const row = this.get(id);
    if (!row) throw new AppError('E_NOT_FOUND', `replica ${id} not found`);
    return row;
  }

  toDto(row: BackupReplicaRow): BackupReplicaDto {
    return {
      id: row.id,
      backupId: row.backupId,
      serverId: row.serverId,
      machineId: row.machineId,
      status: row.status as BackupReplicaDto['status'],
      archivePath: row.archivePath,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      taskId: row.taskId,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: row.error,
    };
  }

  /** Une copie saine (ou en cours) de cette archive existe-t-elle déjà sur cette machine ? */
  private covered(backupId: string, machineId: string): boolean {
    return (
      this.deps.db
        .select({ id: backupReplicas.id })
        .from(backupReplicas)
        .where(
          and(
            eq(backupReplicas.backupId, backupId),
            eq(backupReplicas.machineId, machineId),
            inArray(backupReplicas.status, ['running', 'success']),
          ),
        )
        .all().length > 0
    );
  }

  /** Après `applyManifest` d'une archive locale réussie : copie automatique si le serveur est réglé. */
  onBackupApplied(backup: BackupRow): void {
    if (backup.kind !== 'manual' && backup.kind !== 'scheduled') return;
    const cfg = this.config(backup.serverId);
    if (cfg === undefined || cfg.enabled === 0 || cfg.machineId === backup.machineId) return;
    if (this.covered(backup.id, cfg.machineId)) return;
    this.replicate(backup, cfg.machineId, { keep: cfg.keepLast }).catch((error: unknown) => {
      this.deps.logger.warn(
        { backupId: backup.id, toMachineId: cfg.machineId, err: error },
        'off-site copy could not be ordered',
      );
    });
  }

  /**
   * Ordonne la copie ; résout quand la destination a ACCEPTÉ la task (l'issue arrive par
   * `onTaskFinished`). Les deux agents doivent être connectés : la source sert, la destination reçoit.
   */
  async replicate(
    backup: BackupRow,
    toMachineId: string,
    options: { keep?: number | undefined; userId?: string | undefined } = {},
  ): Promise<BackupReplicaRow> {
    if (backup.status !== 'success') {
      throw new AppError('E_CONFLICT', 'only a successful backup can be copied');
    }
    if (toMachineId === backup.machineId) {
      throw new AppError('E_VALIDATION', 'the off-site copy must live on another machine', {
        details: { key: 'machineId', reason: 'SAME_MACHINE' },
      });
    }
    if (this.covered(backup.id, toMachineId)) {
      throw new AppError('E_CONFLICT', 'a copy of this backup already exists on that machine');
    }
    const target = this.deps.registry.get(toMachineId);
    if (target === undefined) throw new AppError('E_AGENT_OFFLINE', 'destination agent offline');
    if (this.deps.registry.get(backup.machineId) === undefined) {
      throw new AppError('E_AGENT_OFFLINE', 'source agent offline');
    }
    const manifest = this.deps.backups.manifestOf(backup);
    const now = this.deps.now();
    const id = ulid(now);
    const taskId = ulid(now);
    this.deps.db
      .insert(backupReplicas)
      .values({
        id,
        backupId: backup.id,
        serverId: backup.serverId,
        machineId: toMachineId,
        status: 'running',
        taskId,
        startedAt: now,
      })
      .run();
    const request: ReceiveRequest = {
      backupId: backup.id,
      fromMachineId: backup.machineId,
      replicaId: id,
    };
    this.deps.tasks.create({
      id: taskId,
      kind: 'backup.receive',
      machineId: toMachineId,
      serverId: backup.serverId,
      refId: id,
      createdBy: options.userId,
      request,
    });
    try {
      const sources = await this.buildSources(taskId, backup.machineId, backup.serverId, manifest);
      await target.peer.request(
        'backup.receive',
        {
          taskId,
          serverId: backup.serverId,
          backupId: backup.id,
          manifest,
          sources,
          ...(options.keep === undefined ? {} : { keep: options.keep }),
        },
        options.userId === undefined ? {} : { userId: options.userId },
      );
      this.deps.tasks.markRunning(taskId);
    } catch (error) {
      const err = AppError.from(error);
      this.deps.tasks.fail(taskId, err.toJSON());
      this.finish(id, { status: 'failed', error: err.message });
      this.deps.relay.revokeMigration(taskId);
      throw err;
    }
    return this.require(id);
  }

  /**
   * Rapatriement : la machine du serveur reçoit la copie depuis la destination (même message,
   * sens inverse) ; à l'arrivée, `onTaskFinished` remet la fiche de sauvegarde en `success`.
   */
  async pullBack(backupId: string, replicaId: string, userId?: string): Promise<TaskRow> {
    const backup = this.deps.backups.require(backupId);
    const replica = this.require(replicaId);
    if (replica.backupId !== backupId || replica.status !== 'success') {
      throw new AppError('E_CONFLICT', 'no healthy copy to pull from');
    }
    const server = this.deps.servers.require(backup.serverId);
    if (replica.machineId === server.machineId) {
      throw new AppError('E_VALIDATION', 'the copy already lives on the server machine', {
        details: { key: 'machineId', reason: 'SAME_MACHINE' },
      });
    }
    const target = this.deps.registry.get(server.machineId);
    if (target === undefined) throw new AppError('E_AGENT_OFFLINE', 'server agent offline');
    if (this.deps.registry.get(replica.machineId) === undefined) {
      throw new AppError('E_AGENT_OFFLINE', 'copy holder agent offline');
    }
    const manifest = {
      ...this.deps.backups.manifestOf(backup),
      archivePath: replica.archivePath ?? backup.archivePath ?? '',
      ...(replica.sizeBytes === null ? {} : { sizeBytes: replica.sizeBytes }),
      ...(replica.sha256 === null ? {} : { sha256: replica.sha256 }),
    };
    const taskId = ulid(this.deps.now());
    const request: ReceiveRequest = {
      backupId,
      fromMachineId: replica.machineId,
      pullBack: true,
    };
    this.deps.tasks.create({
      id: taskId,
      kind: 'backup.receive',
      machineId: server.machineId,
      serverId: backup.serverId,
      refId: backupId,
      createdBy: userId,
      request,
    });
    try {
      const sources = await this.buildSources(taskId, replica.machineId, backup.serverId, manifest);
      const destination = this.deps.backups.defaultDestination();
      await target.peer.request(
        'backup.receive',
        {
          taskId,
          serverId: backup.serverId,
          backupId,
          manifest,
          sources,
          ...(destination === undefined ? {} : { destination }),
        },
        userId === undefined ? {} : { userId },
      );
      this.deps.tasks.markRunning(taskId);
    } catch (error) {
      const err = AppError.from(error);
      this.deps.tasks.fail(taskId, err.toJSON());
      this.deps.relay.revokeMigration(taskId);
      throw err;
    }
    return this.deps.tasks.require(taskId);
  }

  /** Supprime la copie sur sa machine (agent connecté requis), puis la fiche passe `deleted`. */
  async remove(replicaId: string): Promise<BackupReplicaRow> {
    const replica = this.require(replicaId);
    if (replica.status === 'success' || replica.status === 'running') {
      const holder = this.deps.registry.get(replica.machineId);
      if (holder === undefined) throw new AppError('E_AGENT_OFFLINE', 'copy holder agent offline');
      await holder.peer.request('backup.delete', {
        serverId: replica.serverId,
        backupId: replica.backupId,
        ...(replica.archivePath === null ? {} : { archivePath: replica.archivePath }),
      });
    }
    this.finish(replicaId, { status: 'deleted' });
    return this.require(replicaId);
  }

  /** Suppression de l'original par l'utilisateur : ses copies joignables partent avec ; les autres restent. */
  async removeAllOf(backupId: string): Promise<{ removed: string[]; kept: string[] }> {
    const removed: string[] = [];
    const kept: string[] = [];
    const rows = this.deps.db
      .select()
      .from(backupReplicas)
      .where(
        and(
          eq(backupReplicas.backupId, backupId),
          inArray(backupReplicas.status, ['running', 'success']),
        ),
      )
      .all();
    for (const row of rows) {
      try {
        await this.remove(row.id);
        removed.push(row.machineId);
      } catch (error) {
        this.deps.logger.info(
          { replicaId: row.id, machineId: row.machineId, err: error },
          'off-site copy kept (holder unreachable)',
        );
        kept.push(row.machineId);
      }
    }
    return { removed, kept };
  }

  // --- Issue des tasks --------------------------------------------------------------------------------

  /** Issue d'une task `backup.receive` (session) : copie réussie/échouée, copies rotées, rapatriement. */
  onTaskFinished(row: TaskRow, machineId: string): void {
    this.deps.relay.revokeMigration(row.id);
    const dto = this.deps.tasks.toDto(row);
    const request: ReceiveRequest =
      parseJson<{ request?: ReceiveRequest }>(row.payload, {}).request ?? {};
    if (request.pullBack === true) {
      if (row.status !== 'done') return;
      const parsed = backupReceiveResultSchema.safeParse(dto.result ?? {});
      const backup = parsed.success ? this.deps.backups.get(parsed.data.backupId) : undefined;
      if (!parsed.success || backup === undefined) return;
      const manifest = {
        ...this.deps.backups.manifestOf(backup),
        archivePath: parsed.data.archivePath,
        sizeBytes: parsed.data.sizeBytes,
        sha256: parsed.data.sha256,
      };
      this.deps.backups.applyManifest(manifest, machineId, { taskId: row.id });
      this.deps.logger.info({ backupId: backup.id, machineId }, 'backup pulled back from its copy');
      return;
    }
    if (request.replicaId === undefined) return;
    const replica = this.get(request.replicaId);
    if (replica === undefined) return;
    if (row.status !== 'done') {
      this.finish(replica.id, { status: 'failed', error: dto.error?.message ?? row.status });
      return;
    }
    const parsed = backupReceiveResultSchema.safeParse(dto.result ?? {});
    if (!parsed.success) {
      this.finish(replica.id, { status: 'failed', error: 'unreadable backup.receive result' });
      return;
    }
    this.finish(replica.id, {
      status: 'success',
      archivePath: parsed.data.archivePath,
      sizeBytes: parsed.data.sizeBytes,
      sha256: parsed.data.sha256,
    });
    // Rotation à la destination : les copies plus anciennes de ce serveur y sont parties.
    if (parsed.data.rotated.length > 0) {
      this.deps.db
        .update(backupReplicas)
        .set({ status: 'deleted', finishedAt: this.deps.now() })
        .where(
          and(
            eq(backupReplicas.machineId, replica.machineId),
            eq(backupReplicas.serverId, replica.serverId),
            eq(backupReplicas.status, 'success'),
            inArray(backupReplicas.backupId, parsed.data.rotated),
          ),
        )
        .run();
    }
  }

  // --- Reconnexion d'une machine ---------------------------------------------------------------------

  /**
   * Copies présentes sur cette machine (`backup.list` par serveur concerné) : celles que le panel
   * croyait saines et qui ont disparu passent `deleted` ; celles qu'il ne connaissait pas (base
   * perdue, panel restauré) sont réinsérées quand la fiche de sauvegarde existe.
   */
  async reconcile(machineId: string): Promise<void> {
    const session = this.deps.registry.get(machineId);
    if (session === undefined) return;
    const serverIds = new Set<string>();
    for (const cfg of this.configsTargeting(machineId)) serverIds.add(cfg.serverId);
    for (const row of this.deps.db
      .select({ serverId: backupReplicas.serverId })
      .from(backupReplicas)
      .where(and(eq(backupReplicas.machineId, machineId), eq(backupReplicas.status, 'success')))
      .all()) {
      serverIds.add(row.serverId);
    }
    for (const serverId of serverIds) {
      let listed: unknown[];
      try {
        listed = (await session.peer.request('backup.list', { serverId })).backups;
      } catch (error) {
        this.deps.logger.debug({ machineId, serverId, err: error }, 'replica list unavailable');
        continue;
      }
      const present = new Map<string, { archivePath: string; sizeBytes: number; sha256: string }>();
      for (const raw of listed) {
        const m = raw as {
          backupId?: unknown;
          archivePath?: unknown;
          sizeBytes?: unknown;
          sha256?: unknown;
        };
        if (
          typeof m.backupId === 'string' &&
          typeof m.archivePath === 'string' &&
          typeof m.sizeBytes === 'number' &&
          typeof m.sha256 === 'string'
        ) {
          present.set(m.backupId, {
            archivePath: m.archivePath,
            sizeBytes: m.sizeBytes,
            sha256: m.sha256,
          });
        }
      }
      for (const r of this.replicas(serverId, true)) {
        if (r.machineId === machineId && r.status === 'success' && !present.has(r.backupId)) {
          this.finish(r.id, { status: 'deleted' });
        }
      }
      // Une fiche `failed` ou `deleted` ne compte pas : la copie retrouvée sur le disque prime.
      const alive = this.replicas(serverId, true).filter(
        (r) => r.machineId === machineId && (r.status === 'running' || r.status === 'success'),
      );
      for (const [backupId, m] of present) {
        if (alive.some((r) => r.backupId === backupId)) continue;
        const backup = this.deps.backups.get(backupId);
        // Une archive de CE serveur sur CETTE machine qui n'est pas l'original : c'est une copie.
        if (backup === undefined || backup.machineId === machineId) continue;
        this.deps.db
          .insert(backupReplicas)
          .values({
            id: ulid(this.deps.now()),
            backupId,
            serverId,
            machineId,
            status: 'success',
            archivePath: m.archivePath,
            sizeBytes: m.sizeBytes,
            sha256: m.sha256,
            startedAt: this.deps.now(),
            finishedAt: this.deps.now(),
          })
          .run();
      }
    }
  }

  /**
   * Rattrapage : pour chaque serveur réglé sur cette machine, la dernière archive saine sans copie
   * part maintenant (un Raspberry Pi éteint la nuit reçoit la sauvegarde nocturne le matin). Les
   * copies restées `running` sans task vivante (ordre perdu avec un redémarrage) sont closes avant.
   */
  async catchUp(machineId: string): Promise<void> {
    this.closeLost(machineId);
    for (const cfg of this.configsTargeting(machineId)) {
      if (cfg.enabled === 0) continue;
      await this.catchUpServer(cfg.serverId);
    }
  }

  /** Dernière archive saine d'un serveur sans copie sur sa destination : ordonnée si les deux agents sont là. */
  async catchUpServer(serverId: string): Promise<void> {
    const cfg = this.config(serverId);
    if (cfg === undefined || cfg.enabled === 0) return;
    const latest = this.deps.backups
      .list(serverId)
      .find(
        (b) =>
          b.status === 'success' &&
          (b.kind === 'manual' || b.kind === 'scheduled') &&
          b.machineId !== cfg.machineId,
      );
    if (latest === undefined || this.covered(latest.id, cfg.machineId)) return;
    if (this.deps.registry.get(latest.machineId) === undefined) return;
    if (this.deps.registry.get(cfg.machineId) === undefined) return;
    try {
      await this.replicate(latest, cfg.machineId, { keep: cfg.keepLast });
    } catch (error) {
      this.deps.logger.warn(
        { serverId, backupId: latest.id, toMachineId: cfg.machineId, err: error },
        'off-site catch-up could not be ordered',
      );
    }
  }

  private closeLost(machineId: string): void {
    for (const r of this.deps.db
      .select()
      .from(backupReplicas)
      .where(and(eq(backupReplicas.machineId, machineId), eq(backupReplicas.status, 'running')))
      .all()) {
      const task = r.taskId === null ? undefined : this.deps.tasks.get(r.taskId);
      if (task === undefined || task.status === 'failed' || task.status === 'cancelled') {
        this.finish(r.id, { status: 'failed', error: task?.status ?? 'task lost' });
      }
    }
  }

  private configsTargeting(machineId: string): BackupReplicationRow[] {
    return this.deps.db
      .select()
      .from(backupReplication)
      .where(eq(backupReplication.machineId, machineId))
      .all();
  }

  // --- Sources de transfert (même chaîne que la migration) ---------------------------------------------

  /** Listener direct sur la machine qui détient l'archive (optionnel) + jeton relais panel (toujours). */
  private async buildSources(
    tokenOwner: string,
    fromMachineId: string,
    serverId: string,
    manifest: BackupManifest,
  ): Promise<TransferSource[]> {
    const ttlMs = this.deps.ttlMs ?? 3_600_000;
    const sources: TransferSource[] = [];
    try {
      const served = await this.deps.registry
        .require(fromMachineId)
        .peer.request('transfer.serve', {
          serverId,
          backupId: manifest.backupId,
          token: ulid(this.deps.now()).toLowerCase(),
          ttlSec: Math.max(60, Math.round(ttlMs / 1000)),
        });
      for (const url of served.urls) sources.push({ url, kind: 'direct' });
    } catch (error) {
      this.deps.logger.info(
        { fromMachineId, backupId: manifest.backupId, err: error },
        'no direct listener on the archive holder; relay only',
      );
    }
    // Le jeton relais est un jeton « migration » (même relais, même flux `transfers.download`) ;
    // son `migrationId` est l'id de la task, ce qui permet de le révoquer à l'issue.
    const token = this.deps.relay.issue(
      {
        kind: 'migration',
        migrationId: tokenOwner,
        machineId: fromMachineId,
        serverId,
        backupId: manifest.backupId,
        size: manifest.sizeBytes,
        fileName: path.basename(fileNameOf(manifest)),
      },
      ttlMs,
    );
    sources.push({ url: relayUrl(token), kind: 'relay' });
    return sources;
  }

  private finish(
    id: string,
    patch: {
      status: 'success' | 'failed' | 'deleted';
      error?: string | undefined;
      archivePath?: string | undefined;
      sizeBytes?: number | undefined;
      sha256?: string | undefined;
    },
  ): void {
    this.deps.db
      .update(backupReplicas)
      .set({
        status: patch.status,
        finishedAt: this.deps.now(),
        error: patch.error ?? null,
        ...(patch.archivePath === undefined ? {} : { archivePath: patch.archivePath }),
        ...(patch.sizeBytes === undefined ? {} : { sizeBytes: patch.sizeBytes }),
        ...(patch.sha256 === undefined ? {} : { sha256: patch.sha256 }),
      })
      .where(eq(backupReplicas.id, id))
      .run();
  }
}
