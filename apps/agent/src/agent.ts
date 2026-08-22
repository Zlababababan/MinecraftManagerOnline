/**
 * Assemblage du noyau local (phase 3) : état, connexion panel, scan, gestion des serveurs, relais
 * des événements (`server.stateChanged`, `console.lines`, `player.event`, `server.detected`…).
 * Phase 7 : collecteur `metrics.sample` (tampon hors ligne rejoué) et watchdog local
 * (crash/freeze/RAM/ports → `watchdog.alert`, `port.conflict`), politique poussée par `agent.configure`.
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
import { MetricsCollector } from './monitoring/metrics.js';
import { PlatformSampler, type ProcessSampler } from './monitoring/sampler.js';
import { Watchdog, type WatchdogOptions } from './monitoring/watchdog.js';
import { JavaRegistry, defaultManagedJavaDir } from './platform/java.js';
import { Scanner, type ScanDiff, type ScanTarget } from './scan/scanner.js';
import { StateStore } from './state/store.js';

export const AGENT_VERSION = '0.7.0';

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
      | 'fetchImpl'
      | 'now'
    >
  >;
  /** Purge de la corbeille `.mmo-trash/` (défaut 6 h ; 0 = désactivé). */
  trashPurgeIntervalMs?: number;
  /** Échantillonneur CPU/RSS (défaut : selon l'OS ; tests : stub). */
  sampler?: ProcessSampler;
  /** Intervalle de métriques imposé (défaut : état persistant, 15 s). 0 = désactivé. */
  metricsIntervalMs?: number;
  /** Réglages fins du watchdog (tests : délais courts). */
  watchdog?: Partial<
    Pick<
      WatchdogOptions,
      | 'crashWindowMs'
      | 'restartDelayMs'
      | 'restartDelayMaxMs'
      | 'minProbeIntervalMs'
      | 'maxProbeIntervalMs'
      | 'probeTimeoutMs'
      | 'freezeFailures'
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
  readonly metrics: MetricsCollector;
  readonly watchdog: Watchdog;
  private readonly sampler: ProcessSampler;
  private connection: AgentConnection | undefined;
  private readonly consoleSubscriptions = new Set<string>();
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private trashTimer: ReturnType<typeof setInterval> | undefined;
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
    this.sampler = options.sampler ?? new PlatformSampler(this.logger.child('metrics'));
    this.watchdog = new Watchdog({
      logger: this.logger.child('watchdog'),
      policy: (serverId) => this.store.get().watchdog[serverId],
      view: (serverId) => this.manager.watchdogView(serverId),
      restart: (serverId) => this.startServer(serverId),
      alert: (alert) => {
        this.emit('watchdog.alert', (eventId) => ({ eventId, ...alert }));
      },
      ...options.watchdog,
    });
    this.metrics = new MetricsCollector({
      logger: this.logger.child('metrics'),
      sampler: this.sampler,
      targets: () => this.manager.metricsTargets(),
      emit: (sample) => {
        this.emit('metrics.sample', sample);
      },
      isConnected: () => this.isConnected,
      diskPath: options.stateDir,
      onRamExceeded: (serverId, rssMb, maxRamMb) => {
        this.watchdog.onRamExceeded(serverId, rssMb, maxRamMb);
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
    const purgeEvery = this.options.trashPurgeIntervalMs ?? 6 * 3600_000;
    if (purgeEvery > 0) {
      this.trashTimer = setInterval(() => {
        void this.manager.purgeTrash();
      }, purgeEvery);
      this.trashTimer.unref();
      void this.manager.purgeTrash();
    }
    const metricsEvery =
      this.options.metricsIntervalMs ?? this.store.get().metricsIntervalSec * 1000;
    if (metricsEvery > 0) {
      this.metrics.setInterval(metricsEvery);
      this.metrics.start();
    }
    // Serveurs ré-adoptés ou relancés au boot : le watchdog les surveille dès maintenant.
    for (const target of this.manager.metricsTargets()) {
      this.watchdog.onStateChanged(target.serverId, target.state);
    }
  }

  async stop(): Promise<void> {
    if (this.scanTimer !== undefined) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    if (this.trashTimer !== undefined) clearInterval(this.trashTimer);
    this.trashTimer = undefined;
    this.metrics.stop();
    this.watchdog.dispose();
    await this.connection?.stop();
    this.manager.dispose();
    this.sampler.close();
    await this.store.flush();
    this.started = false;
  }

  // --- Session --------------------------------------------------------------------------------

  private onSession(session: SessionInfo, peer: AgentPeer): void {
    const replayed = this.metrics.replay();
    if (replayed > 0) this.logger.info('replayed buffered metrics', { count: replayed });
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
    const m = this.metrics.summary;
    return {
      ts: Date.now(),
      ...(m?.cpuPct === undefined ? {} : { cpuPct: m.cpuPct, cpuSource: m.cpuSource }),
      ramUsedMb: Math.round((total - free) / 1048576),
      ramTotalMb: Math.max(1, Math.round(total / 1048576)),
      ...(m?.diskUsedGb === undefined || m.diskTotalGb === undefined
        ? {}
        : { diskUsedGb: m.diskUsedGb, diskTotalGb: m.diskTotalGb }),
      activeServers: this.manager.runningCount,
      activeTasks: 0,
    };
  }

  /** Démarrage avec signalement `port.conflict` (handler `server.start` et watchdog). */
  private async startServer(
    serverId: string,
  ): Promise<{ alreadyRunning: boolean; pid: number | undefined }> {
    try {
      return await this.manager.start(serverId);
    } catch (error) {
      if (error instanceof ProtocolError && error.code === 'E_PORT_IN_USE') {
        const port = error.details?.port;
        if (typeof port === 'number')
          this.emit('port.conflict', { ts: Date.now(), port, serverId });
      }
      throw error;
    }
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
          if (cfg.watchdog) {
            s.watchdog = {};
            for (const { serverId, ...policy } of cfg.watchdog) s.watchdog[serverId] = policy;
          }
        });
        if (cfg.metricsIntervalSec !== undefined && this.options.metricsIntervalMs === undefined) {
          this.metrics.setInterval(cfg.metricsIntervalSec * 1000);
        }
        if (cfg.servers) await this.manager.applyConfigs(cfg.servers);
        if (cfg.watchdog) {
          // Politique modifiée à chaud : les sondes de freeze repartent avec le nouvel intervalle.
          for (const target of this.manager.metricsTargets()) {
            this.watchdog.onStateChanged(target.serverId, target.state);
          }
        }
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
        this.watchdog.cancel(serverId);
        const r = await this.startServer(serverId);
        return {
          alreadyRunning: r.alreadyRunning,
          ...(r.pid === undefined ? {} : { pid: r.pid }),
        };
      })
      .handle('server.stop', async ({ serverId, timeoutSec, announce, forceAfterTimeout }) => {
        this.watchdog.cancel(serverId);
        return this.manager.stop(serverId, {
          ...(timeoutSec === undefined ? {} : { timeoutMs: timeoutSec * 1000 }),
          ...(announce === undefined ? {} : { announce }),
          ...(forceAfterTimeout === undefined ? {} : { forceAfterTimeout }),
        });
      })
      .handle('server.restart', async ({ serverId, timeoutSec, announce }) => {
        this.watchdog.cancel(serverId);
        await this.manager.restart(serverId, {
          ...(timeoutSec === undefined ? {} : { timeoutMs: timeoutSec * 1000 }),
          ...(announce === undefined ? {} : { announce }),
        });
        return {};
      })
      .handle('server.kill', ({ serverId }) => {
        this.watchdog.cancel(serverId);
        return this.manager.kill(serverId);
      })
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
      .handle('player.action', ({ serverId, action, target, reason, level }) =>
        this.manager.config(serverId).playerAction(action, target, reason, level),
      )
      .handle('player.resolve', ({ serverId, names }) =>
        this.manager.resolvePlayers(serverId, names),
      )
      // Fichiers et configuration (phase 6)
      .handle('fs.list', async ({ serverId, path: p }) => ({
        entries: await this.manager.files(serverId).list(p),
      }))
      .handle('fs.stat', ({ serverId, path: p }) => this.manager.files(serverId).stat(p))
      .handle('fs.mkdir', async ({ serverId, path: p }) => {
        await this.manager.files(serverId).mkdir(p);
        return {};
      })
      .handle('fs.rename', async ({ serverId, from, to, overwrite }) => {
        await this.manager.files(serverId).rename(from, to, overwrite);
        return {};
      })
      .handle('fs.copy', async ({ serverId, from, to, overwrite }) => {
        await this.manager.files(serverId).copy(from, to, overwrite);
        return {};
      })
      .handle('fs.delete', ({ serverId, path: p }) => this.manager.files(serverId).delete(p))
      .handle('fs.read', ({ serverId, path: p, maxBytes }) =>
        this.manager.files(serverId).read(p, maxBytes),
      )
      .handle('fs.write', ({ serverId, path: p, content, expectedSha256 }) =>
        this.manager.files(serverId).write(p, content, expectedSha256),
      )
      .handle('config.get', ({ serverId, file }) => this.manager.config(serverId).get(file))
      .handle('config.set', ({ serverId, file, data, expectedSha256 }) =>
        this.manager.config(serverId).set(file, data, expectedSha256),
      )
      .handle('logs.listFiles', async ({ serverId }) => ({
        files: await this.manager.listLogFiles(serverId),
      }))
      .handle('logs.search', ({ serverId, ...options }) =>
        this.manager.searchLogs(serverId, options),
      )
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
        if (this.options.metricsIntervalMs === undefined) {
          this.metrics.setInterval(intervalSec * 1000);
        }
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
        if (event.state === 'starting') this.metrics.resetServer(serverId);
        this.watchdog.onStateChanged(serverId, event.state, {
          ...(event.exitReason === undefined ? {} : { exitReason: event.exitReason }),
          ...(event.crashReportPath === undefined
            ? {}
            : { crashReportPath: event.crashReportPath }),
          ...(event.crashSignal === undefined ? {} : { crashSignal: event.crashSignal }),
        });
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
      case 'bind-failed': {
        const port = this.store.getServer(serverId)?.runtime?.gamePort;
        if (port !== undefined) this.emit('port.conflict', { ts, port, serverId });
        break;
      }
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
