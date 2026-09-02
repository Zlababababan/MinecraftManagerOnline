/**
 * Session d'un agent sur `/ws/agent` (doc 05 §3–§7) : `pair.request` → `auth.hello` (négociation
 * N/N-1, compression) → `sync.state` (réconciliation, config poussée, relance `desired_state`) →
 * heartbeat (offline à 40 s) ; événements critiques dédupliqués et acquittés par lots (`event.ack`).
 * Toute requête/événement avant authentification est rejeté (`E_AUTH`) / ignoré.
 * Phase 8 : tasks (`task.progress/completed/failed` → table `tasks`, backups), `backup.rotated`,
 * réconciliation `task.list` + `backup.list` après `sync.state`, transferts binaires routés.
 * Phase 9 : `runtimeVersion`, inventaire Java (`sync.state.javaRuntimes`), mise à jour automatique à
 * la connexion, `agent.updateResult`, manifeste des exports de migration.
 */
import type { FastifyBaseLogger } from 'fastify';

import {
  PANEL_VERSION_RANGE,
  ProtocolError,
  backupManifestSchema,
  createRpcPeer,
  negotiateProtocolVersion,
  type Compression,
  type EventContext,
  type ParsedEventPayload,
  type ParsedRequestPayload,
  type RpcPeer,
  type RpcTransport,
} from '@mmo/protocol';

import type { ClientHub } from '../clients/hub.js';
import type { PanelConfig } from '../config.js';
import type { AuditService } from '../services/audit.js';
import type { BackupsService } from '../services/backups.js';
import type { JavaRuntimesService } from '../services/java-runtimes.js';
import type { ReleasesService } from '../services/releases.js';
import type { EventBus } from '../services/events.js';
import type { MachinesService } from '../services/machines.js';
import type { MetricsService } from '../services/metrics.js';
import type { ProcessedEventsService } from '../services/processed-events.js';
import type { ServersService } from '../services/servers.js';
import type { TasksService } from '../services/tasks.js';
import type { TransferService } from '../services/transfers.js';
import type { TaskRow } from '../db/schema.js';
import type { ConsoleRelay } from './console.js';
import type { AgentRegistry } from './registry.js';

export type PanelPeer = RpcPeer<'panel'>;

export interface AgentSessionDeps {
  config: Pick<PanelConfig, 'heartbeatIntervalSec' | 'offlineAfterMs'>;
  logger: FastifyBaseLogger;
  now: () => number;
  machines: MachinesService;
  servers: ServersService;
  metrics: MetricsService;
  events: EventBus;
  audit: AuditService;
  processed: ProcessedEventsService;
  registry: AgentRegistry;
  relay: ConsoleRelay;
  hub: ClientHub;
  tasks: TasksService;
  backups: BackupsService;
  transfers: TransferService;
  /** Phase 9. */
  releases: ReleasesService;
  javaRuntimes: JavaRuntimesService;
}

export interface AgentHeartbeat extends ParsedEventPayload<'agent.heartbeat'> {
  receivedAt: number;
}

export interface AgentTransport extends RpcTransport {
  close(code?: number, reason?: string): void;
  readonly remoteAddress: string | undefined;
}

const ACK_FLUSH_MS = 50;
const CONFIG_PUSH_DEBOUNCE_MS = 100;

export class AgentSession {
  readonly peer: PanelPeer;
  private machineId: string | undefined;
  private protocolVersion = PANEL_VERSION_RANGE.protoMax;
  private closed = false;
  private lastHeartbeatAt: number;
  private latestHeartbeat: AgentHeartbeat | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private pendingAcks: string[] = [];
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private configTimer: ReturnType<typeof setTimeout> | undefined;
  private configChain: Promise<void> = Promise.resolve();
  private configQueued: Promise<void> | undefined;
  private readonly log: FastifyBaseLogger;
  private agentVersion: string | undefined;

  constructor(
    private readonly transport: AgentTransport,
    private readonly deps: AgentSessionDeps,
  ) {
    this.log = deps.logger.child({ component: 'agent-session' });
    this.lastHeartbeatAt = deps.now();
    this.peer = createRpcPeer({
      role: 'panel',
      transport,
      now: deps.now,
      logger: {
        warn: (message, context) => {
          this.log.warn({ ...context, machineId: this.machineId }, `rpc: ${message}`);
        },
      },
    });
    transport.onClose((reason) => {
      this.onClose(reason);
    });
    this.registerHandlers();
  }

  get isOpen(): boolean {
    return !this.closed && this.machineId !== undefined;
  }

  get id(): string | undefined {
    return this.machineId;
  }

  get version(): number {
    return this.protocolVersion;
  }

  get heartbeat(): AgentHeartbeat | undefined {
    return this.latestHeartbeat;
  }

  close(code?: number, reason?: string): void {
    this.transport.close(code, reason);
  }

  // --- Handlers ---------------------------------------------------------------------------------

  private requireAuth(): string {
    if (this.machineId === undefined) {
      throw new ProtocolError('E_AUTH', 'authenticate first (auth.hello)');
    }
    return this.machineId;
  }

  private registerHandlers(): void {
    const { peer } = this;
    peer.handle('pair.request', (p) => this.onPairRequest(p));
    peer.handle('auth.hello', (p) => this.onAuthHello(p));
    peer.handle('sync.state', (p) => this.onSyncState(p));

    peer.on('agent.heartbeat', (p) => {
      this.onHeartbeat(p);
    });
    peer.on('server.stateChanged', (p, ctx) => {
      this.critical(ctx, () => {
        const machineId = this.requireAuth();
        const row = this.deps.servers.applyStateChanged(p, machineId);
        if (row)
          this.deps.hub.broadcast({
            type: 'server.state',
            server: this.deps.servers.toDto(row, true),
          });
      });
    });
    peer.on('player.event', (p, ctx) => {
      this.critical(ctx, () => {
        this.deps.servers.applyPlayerEvent(p, this.requireAuth());
      });
    });
    peer.on('server.detected', (p, ctx) => {
      this.critical(ctx, () => this.onDetected(p.server, p.directoryId));
    });
    peer.on('server.updated', (p, ctx) => {
      this.critical(ctx, () => this.onDetected(p.server, p.directoryId));
    });
    peer.on('server.removed', (p, ctx) => {
      this.critical(ctx, () => {
        const machineId = this.requireAuth();
        const row = this.deps.servers.markRemoved(machineId, p.path, p.serverId);
        if (row)
          this.deps.hub.broadcast({
            type: 'server.state',
            server: this.deps.servers.toDto(row, true),
          });
      });
    });
    peer.on('watchdog.alert', (p, ctx) => {
      this.critical(ctx, () => {
        const machineId = this.requireAuth();
        this.deps.events.publish({
          type: 'watchdog.alert',
          severity: p.kind === 'crash_loop' || p.action === 'gave_up' ? 'critical' : 'warning',
          machineId,
          serverId: p.serverId,
          payload: p,
          ts: p.ts,
        });
        // Les actions automatiques (relance, kill) laissent une trace d'audit, comme un opérateur.
        if (p.action !== 'none') {
          const row = this.deps.servers.get(p.serverId);
          this.deps.audit.record({
            action: `watchdog.${p.action}`,
            targetType: 'server',
            targetId: p.serverId,
            targetLabel: row?.name,
            details: { kind: p.kind, attempt: p.attempt, detail: p.detail ?? null },
          });
        }
      });
    });
    peer.on('console.lines', (p) => {
      this.requireAuth();
      this.deps.relay.onLines(p.serverId, p.lines);
    });
    peer.on('agent.log', (p) => {
      const machineId = this.requireAuth();
      if (p.level === 'WARN' || p.level === 'ERROR' || p.level === 'FATAL') {
        this.deps.events.publish({
          type: 'agent.log',
          severity: p.level === 'WARN' ? 'warning' : 'error',
          machineId,
          serverId: typeof p.context?.serverId === 'string' ? p.context.serverId : undefined,
          payload: { level: p.level, message: p.message, context: p.context ?? null },
          ts: p.ts,
        });
      }
    });
    peer.on('port.conflict', (p) => {
      this.deps.events.publish({
        type: 'port.conflict',
        severity: 'warning',
        machineId: this.requireAuth(),
        serverId: p.serverId,
        payload: p,
        ts: p.ts,
      });
    });
    peer.on('metrics.sample', (p) => {
      const machineId = this.requireAuth();
      // Seuls les serveurs connus du panel sont retenus (l'agent peut remonter un ID obsolète).
      const known = new Set(this.deps.servers.listByMachine(machineId).map((r) => r.id));
      this.deps.metrics.ingest(machineId, {
        ...p,
        servers: p.servers.filter((s) => known.has(s.serverId)),
      });
    });
    // Phase 8 — tasks et backups
    peer.on('task.progress', (p) => {
      this.requireAuth();
      this.deps.tasks.progress(p.taskId, { phase: p.phase, pct: p.pct, detail: p.detail });
    });
    peer.on('task.completed', (p, ctx) => {
      this.critical(ctx, () => {
        const machineId = this.requireAuth();
        this.ensureTaskRow(machineId, p.taskId, p.kind, p.serverId);
        const row = this.deps.tasks.complete(p.taskId, p.result, p.finishedAt);
        if (row) this.onTaskFinished(machineId, row);
      });
    });
    peer.on('task.failed', (p, ctx) => {
      this.critical(ctx, () => {
        const machineId = this.requireAuth();
        this.ensureTaskRow(machineId, p.taskId, p.kind, p.serverId);
        const row = this.deps.tasks.fail(p.taskId, p.error, {
          cancelled: p.cancelled,
          finishedAt: p.finishedAt,
        });
        if (row) this.onTaskFinished(machineId, row);
      });
    });
    peer.on('agent.updateResult', (p, ctx) => {
      this.critical(ctx, () => {
        this.deps.releases.applyUpdateResult(this.requireAuth(), p);
      });
    });
    // Non critique (voir le catalogue) : pas de `critical()`, pas d'acquittement attendu.
    peer.on('backup.skipped', (p) => {
      this.requireAuth();
      this.deps.backups.recordPolicyRun(p.policyId, {
        status: 'skipped',
        at: p.ts,
        reason: p.detail === undefined ? p.reason : `${p.reason}: ${p.detail}`,
      });
    });
    // Lot 4 — non critique aussi : le manifeste porte le verdict, `backup.list` le rattrape.
    peer.on('backup.verified', (p) => {
      this.requireAuth();
      this.deps.backups.recordVerification(p.backupId, { ok: p.ok, at: p.ts });
    });
    peer.on('backup.rotated', (p, ctx) => {
      this.critical(ctx, () => {
        const machineId = this.requireAuth();
        const deleted = this.deps.backups.markDeleted(p.deleted.map((d) => d.backupId));
        this.deps.events.publish({
          type: 'backup.rotated',
          machineId,
          serverId: p.serverId,
          payload: { policyId: p.policyId ?? null, deleted: p.deleted, known: deleted.length },
          ts: p.ts,
        });
      });
    });
  }

  // --- Tasks (phase 8) ----------------------------------------------------------------------------

  /** Task lancée par l'agent seul (planning) : ligne créée à la volée si le panel ne la connaît pas. */
  private ensureTaskRow(
    machineId: string,
    taskId: string,
    kind: string,
    serverId: string | undefined,
  ): void {
    if (this.deps.tasks.get(taskId)) return;
    const known = serverId !== undefined && this.deps.servers.get(serverId) !== undefined;
    this.deps.tasks.create({ id: taskId, kind, machineId, serverId: known ? serverId : undefined });
  }

  /** Issue d'une task : répercussion sur les backups, événement, acquittement à l'agent. */
  private onTaskFinished(machineId: string, row: TaskRow): void {
    const dto = this.deps.tasks.toDto(row);
    const result = dto.result ?? {};
    if (row.status === 'done') {
      if (row.kind === 'backup.create' || row.kind === 'migration.export') {
        const manifest = backupManifestSchema.safeParse(result);
        if (manifest.success && this.deps.servers.get(manifest.data.serverId)) {
          const applied = this.deps.backups.applyManifest(manifest.data, machineId, {
            taskId: row.id,
            ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
          });
          // Preuve d'exécution de la politique : c'est le manifeste qui porte le `policyId`.
          if (manifest.data.policyId !== undefined) {
            this.deps.backups.recordPolicyRun(manifest.data.policyId, {
              status: 'success',
              at: manifest.data.createdAt,
              backupId: applied.id,
            });
          }
        }
      } else if (row.kind === 'backup.restore') {
        const safety = backupManifestSchema.safeParse(result.safetyBackup);
        if (safety.success && this.deps.servers.get(safety.data.serverId)) {
          this.deps.backups.applyManifest(safety.data, machineId, {
            taskId: row.id,
            ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
          });
        }
        if (row.refId !== null) {
          const target = this.deps.backups.get(row.refId);
          if (target?.status === 'running') this.deps.backups.fail(row.refId, 'restore target');
        }
      }
    } else if (row.kind === 'backup.create') {
      const error = dto.error?.message ?? row.status;
      if (row.refId !== null) this.deps.backups.fail(row.refId, error);
      // Une sauvegarde lancée par le PLANNING de l'agent n'a ni `refId` ni ligne `backups` : sans
      // ce rattrapage, son échec n'était rattaché à aucune politique et celle-ci continuait de
      // paraître saine. Le `policyId` est dans la requête que l'agent a jointe à la task.
      const policyId = parseRequest(row).policyId;
      if (typeof policyId === 'string') {
        this.deps.backups.recordPolicyRun(policyId, {
          status: 'failed',
          at: row.finishedAt ?? this.deps.now(),
          error,
        });
      }
    } else if (row.kind === 'migration.export') {
      const request = parseRequest(row);
      if (typeof request.backupId === 'string') {
        this.deps.backups.fail(request.backupId, dto.error?.message ?? row.status);
      }
    }
    const serverRow = row.serverId === null ? undefined : this.deps.servers.get(row.serverId);
    this.deps.events.publish({
      type: row.status === 'done' ? 'task.completed' : 'task.failed',
      severity: row.status === 'done' ? 'info' : row.status === 'cancelled' ? 'warning' : 'error',
      machineId,
      serverId: serverRow?.id,
      userId: row.createdBy ?? undefined,
      payload: {
        taskId: row.id,
        kind: row.kind,
        status: row.status,
        error: dto.error,
        summary: summarizeResult(row.kind, result),
      },
      ts: row.finishedAt ?? this.deps.now(),
    });
    // Le panel a tout enregistré : l'agent peut oublier la task.
    this.peer.request('task.ackResult', { taskId: row.id }).catch(() => undefined);
  }

  /** Réconciliation après `sync.state` : journal des tasks de l'agent, archives présentes. */
  private async reconcilePhase8(machineId: string): Promise<void> {
    try {
      const { tasks } = await this.peer.request('task.list', {});
      const { discovered, finished } = this.deps.tasks.reconcile(machineId, tasks, (serverId) =>
        serverId !== undefined && this.deps.servers.get(serverId) ? serverId : undefined,
      );
      for (const row of [...discovered, ...finished]) {
        if (row.status === 'pending' || row.status === 'running' || row.status === 'stalled') {
          continue;
        }
        this.onTaskFinished(machineId, row);
      }
    } catch (error) {
      // Agent sans jalon B (E_UNSUPPORTED_TYPE) : rien à réconcilier.
      this.log.debug({ machineId, message: errorMessage(error) }, 'task.list unavailable');
      return;
    }
    for (const server of this.deps.servers.listByMachine(machineId)) {
      try {
        const { backups } = await this.peer.request('backup.list', {
          serverId: server.id,
          destinations: this.deps.backups.knownDestinations(server.id),
        });
        this.deps.backups.reconcile(server.id, machineId, backups);
      } catch (error) {
        this.log.debug(
          { machineId, serverId: server.id, message: errorMessage(error) },
          'backup.list failed',
        );
      }
    }
  }

  /** Événement critique : dédup (`processed_events`) puis acquittement batché, même si déjà vu. */
  private critical(ctx: EventContext, apply: () => void | Promise<void>): void {
    const eventId = ctx.id;
    if (eventId === undefined) {
      void apply();
      return;
    }
    if (!this.deps.processed.claim(eventId)) {
      this.queueAck(eventId);
      return;
    }
    Promise.resolve()
      .then(apply)
      .then(
        () => {
          this.queueAck(eventId);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn({ type: ctx.type, eventId, message }, 'critical event handler failed');
          // Acquitté quand même : un rejeu reproduirait la même erreur (l'événement est journalisé côté panel).
          this.queueAck(eventId);
        },
      );
  }

  private queueAck(eventId: string): void {
    this.pendingAcks.push(eventId);
    if (this.pendingAcks.length >= 50) {
      this.flushAcks();
      return;
    }
    this.ackTimer ??= setTimeout(() => {
      this.flushAcks();
    }, ACK_FLUSH_MS);
  }

  private flushAcks(): void {
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    const eventIds = this.pendingAcks.splice(0);
    if (eventIds.length === 0 || this.peer.isClosed) return;
    this.peer.request('event.ack', { eventIds }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug({ message, count: eventIds.length }, 'event.ack failed');
    });
  }

  // --- Appairage et authentification --------------------------------------------------------

  private onPairRequest(p: ParsedRequestPayload<'pair.request'>) {
    const negotiated = negotiateProtocolVersion({ protoMin: p.protoMin, protoMax: p.protoMax });
    if (!negotiated.ok) throw unsupportedVersion(negotiated.reason);
    const { machine, secret } = this.deps.machines.consumePairingCode(
      p.code,
      { machine: p.machine, agentVersion: p.agentVersion, protocolVersion: negotiated.version },
      this.transport.remoteAddress ?? 'unknown',
    );
    this.deps.audit.record({
      action: 'machine.paired',
      targetType: 'machine',
      targetId: machine.id,
      targetLabel: machine.name,
      details: { hostname: p.machine.hostname, os: p.machine.os, arch: p.machine.arch },
      ip: this.transport.remoteAddress,
    });
    this.deps.events.publish({
      type: 'machine.paired',
      machineId: machine.id,
      payload: { name: machine.name, hostname: p.machine.hostname, agentVersion: p.agentVersion },
    });
    this.log.info({ machineId: machine.id, hostname: p.machine.hostname }, 'agent paired');
    return { agentId: machine.id, secret };
  }

  private onAuthHello(p: ParsedRequestPayload<'auth.hello'>) {
    const machine = this.deps.machines.authenticate(p.agentId, p.agentSecret);
    const negotiated = negotiateProtocolVersion({ protoMin: p.protoMin, protoMax: p.protoMax });
    if (!negotiated.ok) throw unsupportedVersion(negotiated.reason);
    this.protocolVersion = negotiated.version;
    this.peer.version = negotiated.version;
    this.machineId = machine.id;
    this.deps.registry.attach(this, machine.id);
    this.deps.transfers.bind(this, machine.id);
    this.deps.machines.markOnline(machine.id, {
      machine: p.machine,
      agentVersion: p.agentVersion,
      protocolVersion: negotiated.version,
      runtimeVersion: p.runtimeVersion,
    });
    this.agentVersion = p.agentVersion;
    this.lastHeartbeatAt = this.deps.now();
    this.startWatchdog();
    this.deps.events.publish({
      type: 'agent.online',
      machineId: machine.id,
      payload: { agentVersion: p.agentVersion, protocolVersion: negotiated.version },
    });
    this.log.info(
      { machineId: machine.id, agentVersion: p.agentVersion, protocolVersion: negotiated.version },
      'agent authenticated',
    );
    const compression = chooseCompression(p.compression);
    return {
      protocolVersion: negotiated.version,
      heartbeatIntervalSec: this.deps.config.heartbeatIntervalSec,
      wantFullSync: true,
      subscriptions: this.deps.relay.subscriptionsFor(machine.id),
      ...(compression === undefined ? {} : { compression }),
      serverTime: this.deps.now(),
    };
  }

  private onSyncState(p: ParsedRequestPayload<'sync.state'>) {
    const machineId = this.requireAuth();
    this.deps.relay.onSeqs(p.seqs);
    this.deps.javaRuntimes.sync(machineId, p.javaRuntimes);
    const { toStart, unknown } = this.deps.servers.applySyncState(machineId, p);
    if (unknown.length > 0) {
      this.log.warn({ machineId, unknown }, 'sync.state: servers unknown to the panel');
    }
    for (const row of this.deps.servers.listByMachine(machineId)) {
      this.deps.hub.broadcast({ type: 'server.state', server: this.deps.servers.toDto(row, true) });
    }
    // Après la réponse : configuration complète, réconciliation des tasks/backups (phase 8), puis
    // relance des serveurs souhaités « running ».
    setTimeout(() => {
      void this.pushConfig().then(async () => {
        await this.reconcilePhase8(machineId);
        // Phase 9 : mise à jour automatique (l'agent redémarre avec le code 75 si acceptée).
        if (this.agentVersion !== undefined) {
          try {
            if (await this.deps.releases.maybeAutoUpdate(machineId, this.agentVersion)) return;
          } catch (error) {
            this.log.warn({ machineId, message: errorMessage(error) }, 'auto-update failed');
          }
        }
        for (const row of toStart) {
          try {
            await this.peer.request('server.start', { serverId: row.id });
          } catch (error) {
            const e = error instanceof ProtocolError ? error : undefined;
            this.deps.events.publish({
              type: 'server.startFailed',
              severity: 'error',
              machineId,
              serverId: row.id,
              payload: {
                code: e?.code ?? 'E_INTERNAL',
                message: errorMessage(error),
                reconciled: true,
              },
            });
          }
        }
      });
    }, 0);
    return {};
  }

  // --- Détection ------------------------------------------------------------------------------

  private async onDetected(
    server: ParsedEventPayload<'server.detected'>['server'],
    directoryId: string | undefined,
  ): Promise<void> {
    const machineId = this.requireAuth();
    const result = await this.deps.servers.adoptDetected(machineId, server, directoryId);
    this.deps.machines.markScanned(machineId);
    if (result.server) {
      this.deps.hub.broadcast({
        type: 'server.state',
        server: this.deps.servers.toDto(result.server, true),
      });
      if (result.created) this.schedulePushConfig();
    }
  }

  // --- Configuration poussée --------------------------------------------------------------------

  /**
   * Pousse `agent.configure` complet. Les appels sont sérialisés et coalescés : un appel pendant un
   * envoi en cours programme un nouvel envoi (avec la configuration recalculée à ce moment-là).
   */
  pushConfig(): Promise<void> {
    if (this.configQueued) return this.configQueued;
    const run = this.configChain.then(() => {
      this.configQueued = undefined;
      return this.doPushConfig();
    });
    this.configQueued = run;
    this.configChain = run;
    return run;
  }

  private async doPushConfig(): Promise<void> {
    const machineId = this.machineId;
    if (machineId === undefined || this.peer.isClosed) return;
    try {
      await this.peer.request('agent.configure', this.deps.servers.buildAgentConfig(machineId));
    } catch (error) {
      this.log.warn({ machineId, message: errorMessage(error) }, 'agent.configure failed');
    }
  }

  schedulePushConfig(): void {
    if (this.configTimer !== undefined) clearTimeout(this.configTimer);
    this.configTimer = setTimeout(() => {
      this.configTimer = undefined;
      void this.pushConfig();
    }, CONFIG_PUSH_DEBOUNCE_MS);
  }

  // --- Heartbeat et fermeture ------------------------------------------------------------------

  private onHeartbeat(p: ParsedEventPayload<'agent.heartbeat'>): void {
    const machineId = this.requireAuth();
    const receivedAt = this.deps.now();
    this.lastHeartbeatAt = receivedAt;
    this.latestHeartbeat = { ...p, receivedAt };
    this.deps.machines.touch(machineId);
    this.deps.hub.broadcast({
      type: 'machine.heartbeat',
      machineId,
      heartbeat: {
        ts: p.ts,
        ...(p.cpuPct === undefined ? {} : { cpuPct: p.cpuPct }),
        ...(p.cpuSource === undefined ? {} : { cpuSource: p.cpuSource }),
        ...(p.ramUsedMb === undefined ? {} : { ramUsedMb: p.ramUsedMb }),
        ...(p.ramTotalMb === undefined ? {} : { ramTotalMb: p.ramTotalMb }),
        ...(p.diskUsedGb === undefined ? {} : { diskUsedGb: p.diskUsedGb }),
        ...(p.diskTotalGb === undefined ? {} : { diskTotalGb: p.diskTotalGb }),
        activeServers: p.activeServers,
        activeTasks: p.activeTasks,
        ...(p.agentRssMb === undefined ? {} : { agentRssMb: p.agentRssMb }),
        ...(p.agentCpuPct === undefined ? {} : { agentCpuPct: p.agentCpuPct }),
      },
    });
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const interval = Math.max(1000, Math.min(10_000, this.deps.config.offlineAfterMs / 4));
    this.watchdog = setInterval(() => {
      if (this.deps.now() - this.lastHeartbeatAt > this.deps.config.offlineAfterMs) {
        this.log.warn({ machineId: this.machineId }, 'heartbeat timeout: closing agent session');
        this.close(4002, 'heartbeat timeout');
      }
    }, interval);
    this.watchdog.unref();
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private onClose(reason: string | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatchdog();
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
    if (this.configTimer !== undefined) clearTimeout(this.configTimer);
    const machineId = this.machineId;
    if (machineId === undefined) return;
    this.deps.transfers.onSessionClosed(this.peer);
    if (this.deps.registry.detach(this, machineId)) {
      this.deps.machines.markOffline(machineId);
      this.deps.tasks.markStalled(machineId);
      this.deps.metrics.forgetMachine(
        machineId,
        this.deps.servers.listByMachine(machineId).map((r) => r.id),
      );
      this.deps.events.publish({
        type: 'agent.offline',
        severity: 'warning',
        machineId,
        payload: { reason: reason ?? null },
      });
      for (const row of this.deps.servers.listByMachine(machineId)) {
        this.deps.hub.broadcast({
          type: 'server.state',
          server: this.deps.servers.toDto(row, false),
        });
      }
      this.log.info({ machineId, reason }, 'agent disconnected');
    }
  }
}

function chooseCompression(offered: Compression[] | undefined): Compression | undefined {
  if (offered === undefined) return undefined;
  if (offered.includes('zstd')) return 'zstd';
  if (offered.includes('gzip')) return 'gzip';
  return 'none';
}

function unsupportedVersion(reason: string): ProtocolError {
  return new ProtocolError('E_UNSUPPORTED_VERSION', `protocol version not supported (${reason})`, {
    details: {
      reason,
      panelMin: PANEL_VERSION_RANGE.protoMin,
      panelMax: PANEL_VERSION_RANGE.protoMax,
      updateRequired: reason === 'agent_too_old',
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRequest(row: TaskRow): Record<string, unknown> {
  try {
    const payload = JSON.parse(row.payload ?? '{}') as { request?: unknown };
    return typeof payload.request === 'object' && payload.request !== null
      ? (payload.request as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Résumé lisible d'un résultat de task pour le journal d'événements. */
function summarizeResult(kind: string, result: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'backup.create') {
    return {
      backupId: result.backupId ?? null,
      sizeBytes: result.sizeBytes ?? null,
      files: result.files ?? null,
      hot: result.hot ?? null,
      durationMs: result.durationMs ?? null,
    };
  }
  if (kind === 'backup.restore') {
    const safety = result.safetyBackup as { backupId?: string } | undefined;
    return {
      backupId: result.backupId ?? null,
      safetyBackupId: safety?.backupId ?? null,
      restarted: result.restarted ?? null,
    };
  }
  if (kind === 'fs.fetch') return { path: result.path ?? null, size: result.size ?? null };
  if (kind === 'migration.export') {
    return { backupId: result.backupId ?? null, sizeBytes: result.sizeBytes ?? null };
  }
  if (kind === 'migration.import') {
    return {
      path: result.path ?? null,
      files: result.files ?? null,
      source: result.source ?? null,
    };
  }
  if (kind === 'java.install') {
    const runtime = result.runtime as { majorVersion?: number; path?: string } | undefined;
    return {
      majorVersion: runtime?.majorVersion ?? null,
      path: runtime?.path ?? null,
      vendor: result.vendor ?? null,
    };
  }
  return {};
}
