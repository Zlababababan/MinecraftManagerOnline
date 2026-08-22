/**
 * Session d'un agent sur `/ws/agent` (doc 05 §3–§7) : `pair.request` → `auth.hello` (négociation
 * N/N-1, compression) → `sync.state` (réconciliation, config poussée, relance `desired_state`) →
 * heartbeat (offline à 40 s) ; événements critiques dédupliqués et acquittés par lots (`event.ack`).
 * Toute requête/événement avant authentification est rejeté (`E_AUTH`) / ignoré.
 */
import type { FastifyBaseLogger } from 'fastify';

import {
  PANEL_VERSION_RANGE,
  ProtocolError,
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
import type { EventBus } from '../services/events.js';
import type { MachinesService } from '../services/machines.js';
import type { ProcessedEventsService } from '../services/processed-events.js';
import type { ServersService } from '../services/servers.js';
import type { ConsoleRelay } from './console.js';
import type { AgentRegistry } from './registry.js';

export type PanelPeer = RpcPeer<'panel'>;

export interface AgentSessionDeps {
  config: Pick<PanelConfig, 'heartbeatIntervalSec' | 'offlineAfterMs'>;
  logger: FastifyBaseLogger;
  now: () => number;
  machines: MachinesService;
  servers: ServersService;
  events: EventBus;
  audit: AuditService;
  processed: ProcessedEventsService;
  registry: AgentRegistry;
  relay: ConsoleRelay;
  hub: ClientHub;
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
        this.deps.events.publish({
          type: 'watchdog.alert',
          severity: p.kind === 'crash_loop' || p.action === 'gave_up' ? 'critical' : 'warning',
          machineId: this.requireAuth(),
          serverId: p.serverId,
          payload: p,
          ts: p.ts,
        });
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
    peer.on('metrics.sample', () => {
      this.requireAuth();
      // Phase 7 : écriture par lots dans metrics.db.
    });
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
    const { machine, secret } = this.deps.machines.consumePairingCode(p.code, {
      machine: p.machine,
      agentVersion: p.agentVersion,
      protocolVersion: negotiated.version,
    });
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
    this.deps.machines.markOnline(machine.id, {
      machine: p.machine,
      agentVersion: p.agentVersion,
      protocolVersion: negotiated.version,
    });
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
    const { toStart, unknown } = this.deps.servers.applySyncState(machineId, p);
    if (unknown.length > 0) {
      this.log.warn({ machineId, unknown }, 'sync.state: servers unknown to the panel');
    }
    for (const row of this.deps.servers.listByMachine(machineId)) {
      this.deps.hub.broadcast({ type: 'server.state', server: this.deps.servers.toDto(row, true) });
    }
    // Après la réponse : configuration complète, puis relance des serveurs souhaités « running ».
    setTimeout(() => {
      void this.pushConfig().then(async () => {
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
    if (this.deps.registry.detach(this, machineId)) {
      this.deps.machines.markOffline(machineId);
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
