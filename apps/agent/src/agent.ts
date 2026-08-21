/**
 * Assemblage du noyau local (phase 3) : état, connexion panel, scan, gestion des serveurs, relais
 * des événements (`server.stateChanged`, `console.lines`, `player.event`, `server.detected`…).
 */
import os from 'node:os';

import {
  PROTOCOL_VERSION,
  ProtocolError,
  type EventPayload,
  type EventTypesFrom,
  type Os,
  type RequestPayload,
} from '@mmo/protocol';
import { PROJECT_NAME } from '@mmo/shared';

import {
  AgentConnection,
  machineInfo,
  type AgentPeer,
  type SessionInfo,
} from './connection/connection.js';
import type { WebSocketFactory } from './connection/ws-transport.js';
import { Logger, errorMessage } from './log.js';
import { ServerManager, type ServerManagerOptions } from './minecraft/server-manager.js';
import type { ServerProcessEvent } from './minecraft/server-process.js';
import { JavaRegistry, defaultManagedJavaDir } from './platform/java.js';
import { Scanner, type ScanDiff, type ScanTarget } from './scan/scanner.js';
import { StateStore } from './state/store.js';

export const AGENT_VERSION = '0.3.0';

export function currentOs(): Os {
  return process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : 'linux';
}

export interface AgentOptions {
  stateDir: string;
  panelUrl?: string | undefined;
  pairCode?: string | undefined;
  logger?: Logger;
  webSocketFactory?: WebSocketFactory;
  /** Scan périodique des répertoires surveillés (défaut 5 min ; 0 = désactivé). */
  scanIntervalMs?: number;
  manager?: Partial<
    Pick<
      ServerManagerOptions,
      | 'commandBuilder'
      | 'javaResolver'
      | 'totalRamMb'
      | 'ramReserveMb'
      | 'rconPortRange'
      | 'startTimeoutMs'
      | 'rconProbeIntervalMs'
      | 'exitPollMs'
    >
  >;
  backoff?: { baseMs?: number; maxMs?: number };
  /** Sortie du processus (agent.restart) — injectable en test. */
  exit?: (code: number) => void;
  restrictPermissions?: boolean;
  /** Observateur local des événements serveurs (CLI `dev`, tests). */
  onServerEvent?: (serverId: string, event: ServerProcessEvent) => void;
}

export class Agent {
  readonly logger: Logger;
  readonly store: StateStore;
  readonly manager: ServerManager;
  readonly scanner: Scanner;
  readonly java: JavaRegistry;
  private connection: AgentConnection | undefined;
  private readonly consoleSubscriptions = new Set<string>();
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(private readonly options: AgentOptions) {
    this.logger = options.logger ?? new Logger('agent');
    this.store = new StateStore(options.stateDir, {
      ...(options.restrictPermissions === undefined
        ? {}
        : { restrictPermissions: options.restrictPermissions }),
    });
    this.java = new JavaRegistry(defaultManagedJavaDir(options.stateDir));
    this.manager = new ServerManager({
      store: this.store,
      logger: this.logger.child('servers'),
      os: currentOs(),
      java: this.java,
      onEvent: (serverId, event) => {
        this.onServerEvent(serverId, event);
      },
      ...options.manager,
    });
    this.scanner = new Scanner({
      logger: this.logger.child('scan'),
      os: currentOs(),
      serverIdForPath: (p) => this.serverIdForPath(p),
      onDiff: (diff) => {
        this.publishScan(diff);
      },
    });
  }

  get isConnected(): boolean {
    return this.connection?.isConnected ?? false;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.store.load();
    const panelUrl = this.options.panelUrl ?? this.store.get().panelUrl;
    if (
      this.options.panelUrl !== undefined &&
      this.store.get().panelUrl !== this.options.panelUrl
    ) {
      await this.store.update((s) => {
        s.panelUrl = this.options.panelUrl;
      });
    }
    await this.manager.init();
    if (panelUrl !== undefined) {
      this.connection = new AgentConnection({
        panelUrl,
        store: this.store,
        logger: this.logger.child('ws'),
        agentVersion: AGENT_VERSION,
        pairCode: this.options.pairCode,
        capabilities: ['rcon'],
        registerHandlers: (peer) => {
          this.registerHandlers(peer);
        },
        buildSyncState: () => this.buildSyncState(),
        buildHeartbeat: () => this.buildHeartbeat(),
        onSession: (session, peer) => {
          this.onSession(session, peer);
        },
        ...(this.options.webSocketFactory === undefined
          ? {}
          : { webSocketFactory: this.options.webSocketFactory }),
        ...(this.options.backoff === undefined ? {} : { backoff: this.options.backoff }),
      });
      this.connection.start();
    } else {
      this.logger.warn('no panel URL configured: running standalone');
    }
    const interval = this.options.scanIntervalMs ?? 5 * 60_000;
    if (interval > 0) {
      this.scanTimer = setInterval(() => {
        void this.runScan();
      }, interval);
      this.scanTimer.unref();
      void this.runScan();
    }
  }

  async stop(): Promise<void> {
    if (this.scanTimer !== undefined) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    await this.connection?.stop();
    this.manager.dispose();
    await this.store.flush();
    this.started = false;
  }

  // --- Session --------------------------------------------------------------------------------

  private onSession(session: SessionInfo, peer: AgentPeer): void {
    this.consoleSubscriptions.clear();
    for (const sub of session.subscriptions) {
      if (!sub.channel.startsWith('console:')) continue;
      const serverId = sub.channel.slice('console:'.length);
      this.consoleSubscriptions.add(serverId);
      const proc = this.manager.get(serverId);
      if (!proc) continue;
      const { lines } = proc.buffer.since(sub.sinceSeq);
      for (let i = 0; i < lines.length; i += 200) {
        peer.emit('console.lines', { serverId, lines: lines.slice(i, i + 200) });
      }
    }
  }

  private buildSyncState(): RequestPayload<'sync.state'> {
    return {
      servers: this.manager.snapshotServers(),
      tasks: [],
      seqs: { ...this.store.get().seqs },
      portsInUse: this.manager.portsInUse(),
      javaRuntimes: [],
    };
  }

  private buildHeartbeat(): EventPayload<'agent.heartbeat'> {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      ts: Date.now(),
      ramUsedMb: Math.round((total - free) / 1048576),
      ramTotalMb: Math.max(1, Math.round(total / 1048576)),
      activeServers: this.manager.runningCount,
      activeTasks: 0,
    };
  }

  // --- Handlers -------------------------------------------------------------------------------

  private registerHandlers(peer: AgentPeer): void {
    peer
      .handle('agent.info', async () => ({
        machine: machineInfo(),
        agentVersion: AGENT_VERSION,
        runtimeVersion: process.version,
        volumes: [],
        javaRuntimes: await this.java.list(),
        watchedDirectories: this.store.get().watchedDirectories.map((d) => d.path),
        capabilities: ['rcon'],
      }))
      .handle('agent.configure', async (cfg) => {
        const rescan = cfg.watchedDirectories !== undefined;
        await this.store.update((s) => {
          if (cfg.watchedDirectories) s.watchedDirectories = cfg.watchedDirectories;
          if (cfg.desiredStates) s.desiredStates = cfg.desiredStates;
          if (cfg.restoreOnBoot !== undefined) s.restoreOnBoot = cfg.restoreOnBoot;
          if (cfg.metricsIntervalSec !== undefined) s.metricsIntervalSec = cfg.metricsIntervalSec;
        });
        if (cfg.servers) await this.manager.applyConfigs(cfg.servers);
        if (rescan) void this.runScan();
        return { applied: true as const };
      })
      .handle('agent.rotateSecret', async ({ newSecret, graceUntil }) => {
        await this.store.update((s) => {
          if (s.agentSecret !== undefined) s.previousSecret = { secret: s.agentSecret, graceUntil };
          s.agentSecret = newSecret;
        });
        return {};
      })
      .handle('agent.restart', ({ reason }) => {
        this.logger.info('restart requested', { reason });
        setTimeout(() => {
          void this.stop().then(() => {
            (this.options.exit ?? ((code: number) => process.exit(code)))(75);
          });
        }, 200);
        return { accepted: true as const };
      })
      .handle('scan.run', async ({ directoryIds, paths }) => {
        const targets = this.scanTargets(directoryIds);
        for (const p of paths ?? []) targets.push({ id: undefined, path: p });
        const diff = await this.scanner.scan(targets);
        return { scannedPaths: diff.scannedPaths, servers: diff.servers };
      })
      .handle('server.start', async ({ serverId }) => {
        try {
          const r = await this.manager.start(serverId);
          return {
            alreadyRunning: r.alreadyRunning,
            ...(r.pid === undefined ? {} : { pid: r.pid }),
          };
        } catch (error) {
          if (error instanceof ProtocolError && error.code === 'E_PORT_IN_USE') {
            const port = error.details?.port;
            if (typeof port === 'number')
              this.emit('port.conflict', { ts: Date.now(), port, serverId });
          }
          throw error;
        }
      })
      .handle('server.stop', async ({ serverId, timeoutSec, announce, forceAfterTimeout }) =>
        this.manager.stop(serverId, {
          ...(timeoutSec === undefined ? {} : { timeoutMs: timeoutSec * 1000 }),
          ...(announce === undefined ? {} : { announce }),
          ...(forceAfterTimeout === undefined ? {} : { forceAfterTimeout }),
        }),
      )
      .handle('server.restart', async ({ serverId, timeoutSec, announce }) => {
        await this.manager.restart(serverId, {
          ...(timeoutSec === undefined ? {} : { timeoutMs: timeoutSec * 1000 }),
          ...(announce === undefined ? {} : { announce }),
        });
        return {};
      })
      .handle('server.kill', ({ serverId }) => this.manager.kill(serverId))
      .handle('server.command', async ({ serverId, command }) => ({
        via: await this.manager.command(serverId, command),
      }))
      .handle('server.rcon', async ({ serverId, command, timeoutMs }) => ({
        response: await this.manager.rcon(serverId, command, timeoutMs),
      }))
      .handle('server.eulaAccept', async ({ serverId }) => {
        await this.manager.acceptEula(serverId);
        return {};
      })
      .handle('server.setProvisioning', async ({ serverId, provisioning }) => {
        await this.store.update((s) => {
          const r = s.servers[serverId];
          if (!r) throw new ProtocolError('E_NOT_FOUND', `unknown server ${serverId}`);
          r.provisioning = provisioning;
        });
        return {};
      })
      .handle('player.list', ({ serverId }) => this.manager.require(serverId).listPlayers())
      .handle('console.subscribe', ({ serverId, sinceSeq }) => {
        const proc = this.manager.require(serverId);
        this.consoleSubscriptions.add(serverId);
        const { lines, truncated } = proc.buffer.since(sinceSeq);
        const oldest = proc.buffer.oldestSeq;
        return {
          lines,
          truncated,
          ...(oldest === undefined ? {} : { oldestSeq: oldest }),
          latestSeq: proc.buffer.latestSeq ?? this.store.currentSeq(`console:${serverId}`),
        };
      })
      .handle('console.unsubscribe', ({ serverId }) => {
        this.consoleSubscriptions.delete(serverId);
        return {};
      })
      .handle('metrics.configure', async ({ intervalSec }) => {
        await this.store.update((s) => {
          s.metricsIntervalSec = intervalSec;
        });
        return {};
      })
      .handle('java.list', async () => ({ runtimes: await this.java.list(true) }));
  }

  // --- Scan -----------------------------------------------------------------------------------

  private scanTargets(directoryIds?: string[]): ScanTarget[] {
    const wanted = directoryIds === undefined ? undefined : new Set(directoryIds);
    return this.store
      .get()
      .watchedDirectories.filter((d) => d.enabled && (wanted === undefined || wanted.has(d.id)))
      .map((d) => ({ id: d.id, path: d.path }));
  }

  async runScan(): Promise<ScanDiff | undefined> {
    const targets = this.scanTargets();
    if (targets.length === 0) return undefined;
    try {
      return await this.scanner.scan(targets);
    } catch (error) {
      this.logger.warn('scan failed', { error: errorMessage(error) });
      return undefined;
    }
  }

  private publishScan(diff: ScanDiff): void {
    const ts = Date.now();
    for (const a of diff.added) {
      this.emit('server.detected', (eventId) => ({
        eventId,
        ts,
        ...(a.directoryId === undefined ? {} : { directoryId: a.directoryId }),
        server: a.server,
      }));
    }
    for (const u of diff.updated) {
      this.emit('server.updated', (eventId) => ({
        eventId,
        ts,
        serverId: u.serverId,
        ...(u.directoryId === undefined ? {} : { directoryId: u.directoryId }),
        server: u.server,
      }));
    }
    for (const r of diff.removed) {
      this.emit('server.removed', (eventId) => ({
        eventId,
        ts,
        path: r.path,
        ...(r.serverId === undefined ? {} : { serverId: r.serverId }),
      }));
    }
  }

  private serverIdForPath(p: string): string | undefined {
    const norm = normalize(p);
    for (const [id, r] of Object.entries(this.store.get().servers)) {
      if (normalize(r.config.path) === norm) return id;
    }
    return undefined;
  }

  // --- Événements serveurs --------------------------------------------------------------------

  private onServerEvent(serverId: string, event: ServerProcessEvent): void {
    this.options.onServerEvent?.(serverId, event);
    const ts = Date.now();
    switch (event.kind) {
      case 'state':
        this.emit('server.stateChanged', (eventId) => ({
          eventId,
          serverId,
          ts,
          state: event.state,
          previous: event.previous,
          attachMode: event.attachMode,
          ...(event.pid === undefined ? {} : { pid: event.pid }),
          ...(event.exitReason === undefined ? {} : { exitReason: event.exitReason }),
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
          ...(event.crashReportPath === undefined
            ? {}
            : { crashReportPath: event.crashReportPath }),
        }));
        break;
      case 'lines':
        if (this.consoleSubscriptions.has(serverId)) {
          this.emit('console.lines', { serverId, lines: event.lines });
        }
        break;
      case 'player':
        this.emit('player.event', (eventId) => ({
          eventId,
          serverId,
          ts,
          kind: event.event,
          name: event.name,
          ...(event.uuid === undefined ? {} : { uuid: event.uuid }),
          online: event.online,
        }));
        break;
      case 'eula-required':
        this.emit('agent.log', {
          ts,
          level: 'WARN',
          message: 'server refused to start: EULA not accepted',
          context: { serverId, code: 'E_EULA_REQUIRED' },
        });
        break;
      case 'start-timeout':
        this.emit('agent.log', {
          ts,
          level: 'WARN',
          message: 'server start timeout: still not ready',
          context: { serverId },
        });
        break;
      case 'log-event':
        break;
    }
  }

  /**
   * Émet vers le panel (journalisé si critique). Les événements critiques portent un `eventId` de
   * payload égal à l'`id` d'enveloppe (fourni par la connexion à la fabrique de payload).
   */
  private emit<T extends EventTypesFrom<'agent'>>(
    type: T,
    payload: EventPayload<T> | ((eventId: string) => EventPayload<T>),
  ): void {
    this.connection?.emit(type, payload);
  }

  describe(): string {
    return `${PROJECT_NAME} agent ${AGENT_VERSION} — protocole v${String(PROTOCOL_VERSION)} — node ${process.version} ${process.platform}/${process.arch}`;
  }
}

function normalize(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
