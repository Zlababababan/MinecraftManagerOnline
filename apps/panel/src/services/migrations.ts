/**
 * Migration agent → agent, orchestrée par le panel (doc 05 §8, doc 04 §5 `server_migrations`) :
 *
 *   pending → backing_up (`migration.export` sur la source : arrêt + backup `pre_migration`)
 *   → transferring (`transfer.serve` source + jeton relais panel ; `migration.precheck` cible ;
 *     `java.install` si demandé ; `migration.import` cible : direct puis relais, `Range`)
 *   → restoring (extraction sur la cible) → verifying (bascule de propriété en base, configurations
 *     poussées aux deux agents) → done (`migration.finalize` source : `.migrated-<date>`, purge différée)
 *
 * Rien n'est détruit côté source avant la bascule ; un échec laisse le serveur sur la source
 * (`provisioning` revient à `ready`). Une migration en cours au redémarrage du panel est marquée
 * `failed E_INTERRUPTED` (le dossier cible partiel est nettoyé par l'agent cible via sa task).
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  ProtocolError,
  backupManifestSchema,
  migrationExportResultSchema,
  ulid,
  type BackupManifest,
} from '@mmo/protocol';
import type {
  ApiError,
  MigrationDto,
  MigrationPrecheckDto,
  StartMigrationInput,
} from '@mmo/protocol/client';
import { desc, eq, inArray } from 'drizzle-orm';

import type { AgentRegistry } from '../agents/registry.js';
import type { MmoDatabase } from '../db/client.js';
import {
  serverMigrations,
  type ServerMigrationRow,
  type ServerRow,
  type TaskRow,
} from '../db/schema.js';
import { AppError, conflict, notFound } from '../errors.js';
import { parseJson, toJson } from '../util/json.js';
import type { AuditService } from './audit.js';
import type { BackupsService } from './backups.js';
import type { EventBus } from './events.js';
import type { JavaRuntimesService } from './java-runtimes.js';
import type { MachinesService } from './machines.js';
import { relayUrl, type RelayTokens } from './relay.js';
import type { ServersService } from './servers.js';
import type { TasksService } from './tasks.js';

export interface MigrationsDeps {
  db: MmoDatabase;
  now: () => number;
  registry: AgentRegistry;
  servers: ServersService;
  machines: MachinesService;
  tasks: TasksService;
  backups: BackupsService;
  java: JavaRuntimesService;
  relay: RelayTokens;
  events: EventBus;
  audit: AuditService;
  logger: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
  broadcast: (migration: MigrationDto) => void;
  /** Fournit l'origine HTTP du panel vue par les agents (URLs relatives sinon). */
  pushConfig: (machineId: string) => Promise<void>;
  /** TTL du listener direct et du jeton relais (défaut 1 h). */
  ttlMs?: number;
}

const ACTIVE: ServerMigrationRow['status'][] = [
  'pending',
  'backing_up',
  'transferring',
  'restoring',
  'verifying',
];

export class MigrationsService {
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: MigrationsDeps) {
    // Au démarrage : une migration interrompue par l'arrêt du panel est close (rien n'a été détruit).
    for (const row of this.listActive()) {
      this.finish(row.id, 'failed', {
        code: 'E_INTERRUPTED',
        message: 'panel restarted during the migration',
        retryable: true,
      });
      this.restoreProvisioning(row.serverId);
    }
    // Progression des tasks export/import → statut et pourcentage de la migration.
    this.unsubscribe = deps.tasks.subscribe((task) => {
      this.onTask(task);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  // --- Lecture --------------------------------------------------------------------------------

  get(id: string): ServerMigrationRow | undefined {
    return this.deps.db.select().from(serverMigrations).where(eq(serverMigrations.id, id)).get();
  }

  require(id: string): ServerMigrationRow {
    const row = this.get(id);
    if (!row) throw notFound('migration', id);
    return row;
  }

  listForServer(serverId: string): ServerMigrationRow[] {
    return this.deps.db
      .select()
      .from(serverMigrations)
      .where(eq(serverMigrations.serverId, serverId))
      .orderBy(desc(serverMigrations.startedAt))
      .limit(50)
      .all();
  }

  listActive(): ServerMigrationRow[] {
    return this.deps.db
      .select()
      .from(serverMigrations)
      .where(inArray(serverMigrations.status, ACTIVE))
      .all();
  }

  toDto(row: ServerMigrationRow): MigrationDto {
    return {
      id: row.id,
      serverId: row.serverId,
      fromMachineId: row.fromMachineId,
      toMachineId: row.toMachineId,
      toDirectoryId: row.toDirectoryId,
      sourcePath: row.sourcePath,
      toPath: row.toPath,
      backupId: row.backupId,
      status: row.status,
      progressPct: row.progressPct,
      mode: row.mode,
      exportTaskId: row.exportTaskId,
      importTaskId: row.importTaskId,
      restartAfter: row.restartAfter === 1,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: parseJson<ApiError | null>(row.error, null),
      createdBy: row.createdBy,
    };
  }

  // --- Pré-checks -----------------------------------------------------------------------------

  /** Chemin cible : `toPath` explicite, sinon `<répertoire surveillé>/<nom du dossier source>`. */
  resolveTarget(
    server: ServerRow,
    input: Pick<StartMigrationInput, 'toMachineId' | 'toDirectoryId' | 'toPath'>,
  ): { toPath: string; toDirectoryId: string | undefined } {
    const machine = this.deps.machines.require(input.toMachineId);
    if (machine.id === server.machineId) throw conflict('target machine is the current machine');
    if (input.toPath !== undefined) {
      const dir = this.deps.machines
        .directories(machine.id)
        .find((d) => isInside(input.toPath ?? '', d.path, machine.os === 'windows'));
      return { toPath: input.toPath, toDirectoryId: dir?.id };
    }
    const dirs = this.deps.machines.directories(machine.id);
    const dir =
      input.toDirectoryId === undefined ? dirs[0] : dirs.find((d) => d.id === input.toDirectoryId);
    if (!dir) throw new AppError('E_VALIDATION', 'target directory required');
    const sep = machine.os === 'windows' ? '\\' : '/';
    const base =
      path.basename(server.path.replace(/[\\/]+$/, '').replace(/\\/g, '/')) || server.name;
    return { toPath: `${dir.path.replace(/[\\/]+$/, '')}${sep}${base}`, toDirectoryId: dir.id };
  }

  async precheck(
    serverId: string,
    input: Pick<StartMigrationInput, 'toMachineId' | 'toDirectoryId' | 'toPath'>,
  ): Promise<MigrationPrecheckDto> {
    const server = this.deps.servers.require(serverId);
    const { toPath } = this.resolveTarget(server, input);
    const target = this.deps.registry.require(input.toMachineId);
    const detection = parseJson<{ javaRequirement?: { strict?: boolean } } | undefined>(
      server.detectionJson,
      undefined,
    );
    const result = await target.peer.request('migration.precheck', {
      serverId: server.id,
      path: toPath,
      ...(server.gamePort === null ? {} : { gamePort: server.gamePort }),
      ...(server.javaMajorRequired === null ? {} : { javaMajor: server.javaMajorRequired }),
      ...(detection?.javaRequirement?.strict === true ? { javaStrict: true } : {}),
      requiredBytes: await this.estimateBytes(server),
    });
    return { ...result, toPath };
  }

  private async estimateBytes(server: ServerRow): Promise<number> {
    // Dernier backup connu ⇒ ~ 2 × taille brute (archive + extraction) ; sinon 1 Gio par défaut.
    const last = this.deps.backups
      .list(server.id)
      .find((b) => b.status === 'success' && b.manifestJson !== null);
    const manifest = last ? parseJson<Partial<BackupManifest>>(last.manifestJson, {}) : undefined;
    const raw = manifest?.bytesRaw;
    return Promise.resolve(raw === undefined ? 1024 ** 3 : raw * 2);
  }

  // --- Démarrage ------------------------------------------------------------------------------

  async start(
    serverId: string,
    input: StartMigrationInput,
    userId: string | undefined,
  ): Promise<ServerMigrationRow> {
    const server = this.deps.servers.require(serverId);
    if (server.provisioning !== 'ready') {
      throw conflict(`server is ${server.provisioning}`, { provisioning: server.provisioning });
    }
    if (this.listActive().some((m) => m.serverId === serverId)) {
      throw new AppError('E_BUSY', 'a migration is already running for this server');
    }
    const { toPath, toDirectoryId } = this.resolveTarget(server, input);
    this.deps.registry.require(server.machineId);
    this.deps.registry.require(input.toMachineId);
    // Pré-checks avant tout : port, dossier, disque (Java peut être installé à la volée).
    const pre = await this.precheck(serverId, input);
    const javaBlocked = !pre.java.ok && !(input.installJava && pre.java.installable === true);
    if (!pre.path.ok || !pre.port.ok || !pre.disk.ok || javaBlocked) {
      throw new AppError('E_PRECHECK_FAILED', 'target pre-checks failed', {
        details: { checks: pre },
      });
    }
    const id = ulid(this.deps.now());
    const row = {
      id,
      serverId,
      fromMachineId: server.machineId,
      toMachineId: input.toMachineId,
      toDirectoryId: toDirectoryId ?? null,
      backupId: null,
      status: 'pending' as const,
      progressPct: 0,
      startedAt: this.deps.now(),
      finishedAt: null,
      error: null,
      createdBy: userId ?? null,
      sourcePath: server.path,
      toPath,
      mode: null,
      exportTaskId: null,
      importTaskId: null,
      restartAfter: input.restartAfter ? 1 : 0,
    };
    this.deps.db.insert(serverMigrations).values(row).run();
    this.deps.servers.setProvisioning(serverId, 'migrating');
    this.deps.audit.record({
      action: 'server.migrate',
      targetType: 'server',
      targetId: serverId,
      targetLabel: server.name,
      userId,
      details: { migrationId: id, toMachineId: input.toMachineId, toPath },
    });
    this.emit(id);
    void this.run(id, server, input, pre, userId).catch((error: unknown) => {
      this.deps.logger.warn({ migrationId: id, err: error }, 'migration failed');
    });
    return this.require(id);
  }

  // --- Orchestration --------------------------------------------------------------------------

  private async run(
    id: string,
    server: ServerRow,
    input: StartMigrationInput,
    pre: MigrationPrecheckDto,
    userId: string | undefined,
  ): Promise<void> {
    const ttlMs = this.deps.ttlMs ?? 3_600_000;
    const source = () => this.deps.registry.require(server.machineId);
    const target = () => this.deps.registry.require(input.toMachineId);
    let manifest: BackupManifest | undefined;
    try {
      // 1. Export sur la source (arrêt + backup pre_migration).
      this.patch(id, { status: 'backing_up' });
      const exportTaskId = ulid(this.deps.now());
      const backupId = ulid(this.deps.now());
      this.deps.tasks.create({
        id: exportTaskId,
        kind: 'migration.export',
        machineId: server.machineId,
        serverId: server.id,
        refId: id,
        createdBy: userId,
        request: { migrationId: id, backupId },
      });
      this.deps.backups.start({
        id: backupId,
        serverId: server.id,
        machineId: server.machineId,
        kind: 'pre_migration',
        taskId: exportTaskId,
        createdBy: userId,
        comment: `migration ${id}`,
      });
      this.patch(id, { exportTaskId, backupId });
      await source().peer.request(
        'migration.export',
        {
          taskId: exportTaskId,
          serverId: server.id,
          migrationId: id,
          backupId,
          ...(this.deps.backups.defaultDestination() === undefined
            ? {}
            : { destination: this.deps.backups.defaultDestination() }),
          ...(input.announce === undefined ? {} : { announce: input.announce }),
        },
        userId === undefined ? {} : { userId },
      );
      this.deps.tasks.markRunning(exportTaskId);
      const exported = await this.deps.tasks.waitForFinish(exportTaskId);
      if (exported.status !== 'done') throw taskError(exported);
      const exportResult = migrationExportResultSchema.parse(
        this.deps.tasks.toDto(exported).result ?? {},
      );
      manifest = backupManifestSchema.parse(exportResult);
      const wasRunning = exportResult.wasRunning;

      // 2. Java manquant sur la cible : installation à la volée si demandée.
      if (!pre.java.ok && input.installJava && server.javaMajorRequired !== null) {
        this.patch(id, { status: 'transferring', progressPct: 5 });
        const machine = this.deps.machines.require(input.toMachineId);
        const { taskId } = await this.deps.java.install(
          machine,
          { majorVersion: server.javaMajorRequired, relay: false },
          userId,
        );
        const installed = await this.deps.tasks.waitForFinish(taskId);
        if (installed.status !== 'done') throw taskError(installed);
      }

      // 3. Sources de données : listener direct sur la source (optionnel), relais panel (toujours).
      this.patch(id, { status: 'transferring', progressPct: 10 });
      const token = randomBytes(16).toString('hex');
      const sources: { url: string; kind: 'direct' | 'relay'; headers?: Record<string, string> }[] =
        [];
      try {
        const served = await source().peer.request('transfer.serve', {
          serverId: server.id,
          backupId,
          token,
          ttlSec: Math.max(60, Math.round(ttlMs / 1000)),
        });
        for (const url of served.urls) sources.push({ url, kind: 'direct' });
      } catch (error) {
        this.deps.logger.info(
          { migrationId: id, message: errorMessage(error) },
          'no direct listener on the source; relay only',
        );
      }
      const relayToken = this.deps.relay.issue(
        {
          kind: 'migration',
          migrationId: id,
          machineId: server.machineId,
          serverId: server.id,
          backupId,
          size: manifest.sizeBytes,
          fileName: path.basename(manifest.archivePath),
        },
        ttlMs,
      );
      sources.push({ url: relayUrl(relayToken), kind: 'relay' });

      // 4. Import sur la cible.
      const importTaskId = ulid(this.deps.now());
      this.deps.tasks.create({
        id: importTaskId,
        kind: 'migration.import',
        machineId: input.toMachineId,
        serverId: server.id,
        refId: id,
        createdBy: userId,
        request: { migrationId: id, toPath: pre.toPath, sources: sources.map((s) => s.kind) },
      });
      this.patch(id, { importTaskId });
      const config = { ...this.deps.servers.toAgentConfig(server), path: pre.toPath };
      await target().peer.request(
        'migration.import',
        {
          taskId: importTaskId,
          migrationId: id,
          config,
          manifest,
          sources,
          startAfter: input.restartAfter && wasRunning,
        },
        userId === undefined ? {} : { userId },
      );
      this.deps.tasks.markRunning(importTaskId);
      const imported = await this.deps.tasks.waitForFinish(importTaskId);
      if (imported.status !== 'done') throw taskError(imported);
      const importResult = this.deps.tasks.toDto(imported).result ?? {};
      const mode = importResult.source === 'relay' ? 'relay' : 'direct';

      // 5. Bascule de propriété en base, configurations poussées, finalisation côté source.
      this.patch(id, { status: 'verifying', progressPct: 97, mode });
      this.deps.servers.moveToMachine(server.id, {
        machineId: input.toMachineId,
        path: pre.toPath,
        directoryId: this.get(id)?.toDirectoryId ?? null,
        desiredState: input.restartAfter && wasRunning ? 'running' : 'stopped',
        running: importResult.started === true,
      });
      await this.deps.pushConfig(input.toMachineId).catch(() => undefined);
      await this.deps.pushConfig(server.machineId).catch(() => undefined);
      try {
        const fin = await source().peer.request('migration.finalize', {
          serverId: server.id,
          migrationId: id,
          path: server.path,
          action: 'rename',
        });
        this.patch(id, { sourcePath: fin.path });
      } catch (error) {
        // La source est injoignable : la bascule est faite, le dossier sera renommé à la main.
        this.deps.logger.warn(
          { migrationId: id, message: errorMessage(error) },
          'migration.finalize failed on the source',
        );
      }
      this.deps.relay.revokeMigration(id);
      this.finish(id, 'done');
      this.deps.events.publish({
        type: 'migration.done',
        machineId: input.toMachineId,
        serverId: server.id,
        userId,
        payload: {
          migrationId: id,
          from: server.machineId,
          to: input.toMachineId,
          mode,
          toPath: pre.toPath,
        },
      });
    } catch (error) {
      const api = AppError.from(error).toJSON();
      this.deps.relay.revokeMigration(id);
      this.finish(id, 'failed', api);
      this.restoreProvisioning(server.id);
      this.deps.events.publish({
        type: 'migration.failed',
        severity: 'error',
        machineId: server.machineId,
        serverId: server.id,
        userId,
        payload: { migrationId: id, to: input.toMachineId, error: api },
      });
    }
  }

  // --- Suivi des tasks ------------------------------------------------------------------------

  private onTask(task: TaskRow): void {
    if (task.refId === null) return;
    if (task.kind !== 'migration.export' && task.kind !== 'migration.import') return;
    const row = this.get(task.refId);
    if (!row || !ACTIVE.includes(row.status)) return;
    const pct = task.progress ?? 0;
    const live = this.deps.tasks.toDto(task);
    if (task.kind === 'migration.export') {
      this.patch(row.id, { progressPct: Math.min(30, pct * 0.3) });
    } else {
      const extracting = live.phase === 'extracting' || live.phase === 'registering';
      const patch: Partial<ServerMigrationRow> = {
        progressPct: Math.min(96, 30 + pct * 0.66),
      };
      if (extracting && row.status === 'transferring') patch.status = 'restoring';
      this.patch(row.id, patch);
    }
  }

  // --- Internes -------------------------------------------------------------------------------

  private patch(id: string, patch: Partial<ServerMigrationRow>): void {
    this.deps.db.update(serverMigrations).set(patch).where(eq(serverMigrations.id, id)).run();
    this.emit(id);
  }

  private finish(id: string, status: 'done' | 'failed', error?: ApiError): void {
    this.patch(id, {
      status,
      finishedAt: this.deps.now(),
      progressPct: status === 'done' ? 100 : (this.get(id)?.progressPct ?? null),
      error: error === undefined ? null : toJson(error),
    });
  }

  private restoreProvisioning(serverId: string): void {
    const row = this.deps.servers.get(serverId);
    if (row?.provisioning === 'migrating') this.deps.servers.setProvisioning(serverId, 'ready');
  }

  private emit(id: string): void {
    const row = this.get(id);
    if (row) this.deps.broadcast(this.toDto(row));
  }
}

function taskError(task: TaskRow): AppError {
  const error = parseJson<ApiError | null>(task.error, null);
  if (error) return new AppError(error.code, error.message, { details: error.details ?? {} });
  return new AppError('E_INTERNAL', `task ${task.id} ended with status ${task.status}`);
}

function errorMessage(error: unknown): string {
  return error instanceof ProtocolError || error instanceof Error ? error.message : String(error);
}

function isInside(target: string, dir: string, caseInsensitive: boolean): boolean {
  const norm = (p: string): string => {
    const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? n.toLowerCase() : n;
  };
  return norm(target).startsWith(`${norm(dir)}/`);
}
