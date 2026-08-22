/**
 * Assemblage du noyau local (phase 3) : état, connexion panel, scan, gestion des serveurs, relais
 * des événements (`server.stateChanged`, `console.lines`, `player.event`, `server.detected`…).
 * Phase 7 : collecteur `metrics.sample` (tampon hors ligne rejoué) et watchdog local
 * (crash/freeze/RAM/ports → `watchdog.alert`, `port.conflict`), politique poussée par `agent.configure`.
 * Phase 8 : tasks (journal WAL, `task.*`), backups (création à chaud, restauration, rotation,
 * plannings locaux autonomes), transferts binaires (`fs.download/upload`, `fs.fetch`).
 * Phase 9 : migration agent → agent (`migration.*`, `transfer.serve`), Java géré (`java.install/remove`),
 * mises à jour (`agent.update`, `runtime.update`, signal de santé au launcher, `agent.updateResult`).
 */
import os from 'node:os';

import {
  PROTOCOL_VERSION,
  ProtocolError,
  ulid,
  type Compression,
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
import { BackupService } from './backup/backup-service.js';
import { BackupScheduler } from './backup/scheduler.js';
import { JavaInstaller } from './java/installer.js';
import { AgentMigration } from './migration/migration.js';
import { AgentUpdater, detectAgentHome } from './update/updater.js';
import { panelHttpOrigin } from './util/download.js';
import { Logger, errorMessage } from './log.js';
import { ServerManager, type ServerManagerOptions } from './minecraft/server-manager.js';
import type { ServerProcessEvent } from './minecraft/server-process.js';
import { MetricsCollector } from './monitoring/metrics.js';
import { PlatformSampler, type ProcessSampler } from './monitoring/sampler.js';
import { Watchdog, type WatchdogOptions } from './monitoring/watchdog.js';
import { JavaRegistry, defaultManagedJavaDir } from './platform/java.js';
import { Scanner, type ScanDiff, type ScanTarget } from './scan/scanner.js';
import { StateStore } from './state/store.js';
import { TaskJournal } from './tasks/journal.js';
import { TaskRunner } from './tasks/runner.js';
import { AgentTransfers } from './transfer/transfers.js';

export const AGENT_VERSION = '0.11.0';
export const AGENT_CAPABILITIES = [
  'rcon',
  'tasks',
  'backups',
  'transfers',
  'migration',
  'java',
  'update',
];

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
  /** Période d'évaluation des plannings de backups (défaut 30 s ; 0 = désactivé). */
  backupSchedulerTickMs?: number;
  /** Attente de confirmation console après `save-all` en stdin (tests : court). */
  saveSettleMs?: number;
  /** `fetch` pour `fs.fetch`, `java.install`, `migration.import`, `agent.update` (tests : serveur local). */
  fetchImpl?: typeof fetch;
  /** Phase 9 : dossier géré par le launcher (défaut `MMO_AGENT_HOME`) ; absent = mises à jour refusées. */
  agentHome?: string | undefined;
  /** Phase 9 : clés publiques Ed25519 acceptées (tests) ; défaut : clés embarquées. */
  updatePublicKeys?: readonly string[];
  /** Phase 9 : version annoncée (tests de mise à jour) ; défaut `AGENT_VERSION`. */
  agentVersion?: string;
  /** Phase 9 : adresses annoncées par `transfer.serve` (tests : `127.0.0.1`). */
  serveAddresses?: () => string[];
  /** Phase 9 : sonde `java -version` (tests). */
  javaProbe?: (
    javaPath: string,
  ) => Promise<{ majorVersion: number; fullVersion: string; vendor: string } | undefined>;
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
  readonly tasks: TaskRunner;
  readonly backups: BackupService;
  readonly backupScheduler: BackupScheduler;
  readonly transfers: AgentTransfers;
  readonly javaInstaller: JavaInstaller;
  readonly migration: AgentMigration;
  readonly updater: AgentUpdater;
  readonly version: string;
  private readonly sampler: ProcessSampler;
  private sessionCompression: Compression | undefined;
  private connection: AgentConnection | undefined;
  private readonly consoleSubscriptions = new Set<string>();
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private updateResultReported = false;
  private javaSnapshot: RequestPayload<'sync.state'>['javaRuntimes'] = [];
  private trashTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(private readonly options: AgentOptions) {
    this.logger = options.logger ?? new Logger('agent');
    this.version = options.agentVersion ?? AGENT_VERSION;
    this.store = new StateStore(options.stateDir, {
      ...(options.restrictPermissions === undefined
        ? {}
        : { restrictPermissions: options.restrictPermissions }),
    });
    this.java = new JavaRegistry(defaultManagedJavaDir(options.stateDir), options.javaProbe);
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
    this.tasks = new TaskRunner({
      journal: new TaskJournal(options.stateDir),
      logger: this.logger.child('tasks'),
      emit: (type, payload) => {
        this.emit(type, payload);
      },
    });
    this.backups = new BackupService({
      stateDir: options.stateDir,
      store: this.store,
      manager: this.manager,
      logger: this.logger.child('backups'),
      agentVersion: AGENT_VERSION,
      ...(options.saveSettleMs === undefined ? {} : { saveSettleMs: options.saveSettleMs }),
      onRotated: ({ serverId, policyId, deleted }) => {
        this.emit('backup.rotated', (eventId) => ({
          eventId,
          serverId,
          ts: Date.now(),
          ...(policyId === undefined ? {} : { policyId }),
          deleted,
        }));
      },
    });
    this.backupScheduler = new BackupScheduler({
      store: this.store,
      manager: this.manager,
      backups: this.backups,
      tasks: this.tasks,
      logger: this.logger.child('schedules'),
      ...(options.backupSchedulerTickMs === undefined || options.backupSchedulerTickMs <= 0
        ? {}
        : { tickMs: options.backupSchedulerTickMs }),
    });
    this.transfers = new AgentTransfers({
      manager: this.manager,
      backups: this.backups,
      logger: this.logger.child('transfers'),
      sessionCompression: () => this.sessionCompression,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    const panelOrigin = (): string | undefined =>
      panelHttpOrigin(this.options.panelUrl ?? this.store.get().panelUrl);
    this.javaInstaller = new JavaInstaller({
      managedDir: defaultManagedJavaDir(options.stateDir),
      registry: this.java,
      logger: this.logger.child('java'),
      panelOrigin,
      fetchImpl: options.fetchImpl,
      ...(options.javaProbe === undefined ? {} : { probe: options.javaProbe }),
    });
    this.migration = new AgentMigration({
      stateDir: options.stateDir,
      store: this.store,
      manager: this.manager,
      backups: this.backups,
      java: this.java,
      logger: this.logger.child('migration'),
      panelOrigin,
      fetchImpl: options.fetchImpl,
      ...(options.serveAddresses === undefined ? {} : { serveAddresses: options.serveAddresses }),
    });
    this.updater = new AgentUpdater({
      home: options.agentHome ?? detectAgentHome(),
      currentVersion: this.version,
      logger: this.logger.child('update'),
      ...(options.updatePublicKeys === undefined ? {} : { publicKeys: options.updatePublicKeys }),
      panelOrigin,
      fetchImpl: options.fetchImpl,
      restart: (code) => {
        void this.stop().then(() => {
          (this.options.exit ?? ((c: number) => process.exit(c)))(code);
        });
      },
    });
  }

  get isConnected(): boolean {
    return this.connection?.isConnected ?? false;
  }

  /** Phase 11 : appairage seul (commande `pair` des installeurs), sans démarrer l'agent. */
  async pair(): Promise<{ agentId: string; alreadyPaired: boolean }> {
    await this.store.load();
    const panelUrl = this.options.panelUrl ?? this.store.get().panelUrl;
    if (panelUrl === undefined) throw new Error('panel url required');
    const connection = new AgentConnection({
      panelUrl,
      store: this.store,
      logger: this.logger.child('ws'),
      agentVersion: this.version,
      pairCode: this.options.pairCode,
      capabilities: AGENT_CAPABILITIES,
      registerHandlers: () => undefined,
      buildSyncState: () => this.buildSyncState(),
      buildHeartbeat: () => this.buildHeartbeat(),
      ...(this.options.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: this.options.webSocketFactory }),
    });
    return connection.pairOnly();
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
    await this.tasks.journal.load();
    // Inventaire Java (sondes `java -version`, en cache ensuite) : remonté dans `sync.state`.
    this.javaSnapshot = await this.java.list().catch(() => []);
    if (panelUrl !== undefined) {
      this.connection = new AgentConnection({
        panelUrl,
        store: this.store,
        logger: this.logger.child('ws'),
        agentVersion: this.version,
        pairCode: this.options.pairCode,
        capabilities: AGENT_CAPABILITIES,
        registerHandlers: (peer) => {
          this.registerHandlers(peer);
        },
        buildSyncState: () => this.buildSyncState(),
        buildHeartbeat: () => this.buildHeartbeat(),
        pendingTaskIds: () => this.tasks.journal.running().map((t) => t.taskId),
        onSession: (session, peer) => {
          this.onSession(session, peer);
        },
        onDisconnect: () => {
          this.sessionCompression = undefined;
          void this.transfers.detachAll();
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
    // Après la création de la connexion : les `task.failed` sont journalisés même hors ligne.
    const interrupted = await this.tasks.recover();
    if (interrupted > 0) {
      this.logger.warn('interrupted tasks failed at boot', { count: interrupted });
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
        void this.migration.purgeMigrated();
      }, purgeEvery);
      this.trashTimer.unref();
      void this.manager.purgeTrash();
      void this.migration.purgeMigrated();
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
    if ((this.options.backupSchedulerTickMs ?? 30_000) > 0) this.backupScheduler.start();
  }

  async stop(): Promise<void> {
    if (this.scanTimer !== undefined) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    if (this.trashTimer !== undefined) clearInterval(this.trashTimer);
    this.trashTimer = undefined;
    this.backupScheduler.stop();
    this.metrics.stop();
    this.watchdog.dispose();
    await this.tasks.dispose();
    await this.transfers.detachAll();
    this.migration.closeAll();
    await this.connection?.stop();
    this.manager.dispose();
    this.sampler.close();
    await this.store.flush();
    this.started = false;
  }

  // --- Session --------------------------------------------------------------------------------

  private onSession(session: SessionInfo, peer: AgentPeer): void {
    this.sessionCompression = session.compression;
    // Phase 9 : santé confirmée au launcher (health-check post-mise à jour) et issue de la bascule.
    this.updater.notifyHealthy();
    if (!this.updateResultReported) {
      this.updateResultReported = true;
      void this.updater.consumeUpdateResult().then((result) => {
        if (result) this.emit('agent.updateResult', (eventId) => ({ eventId, ...result }));
      });
    }
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
      tasks: this.tasks.list().map((t) => ({
        taskId: t.taskId,
        type: t.kind,
        status: t.status,
        updatedAt: t.updatedAt,
      })),
      seqs: { ...this.store.get().seqs },
      portsInUse: this.manager.portsInUse(),
      javaRuntimes: this.javaSnapshot,
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
      activeTasks: this.tasks.activeCount + this.transfers.activeCount,
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
    this.transfers.bind(peer);
    this.registerTaskHandlers(peer);
    peer
      .handle('agent.info', async () => ({
        machine: machineInfo(),
        agentVersion: this.version,
        runtimeVersion: process.version,
        volumes: [],
        javaRuntimes: await this.java.list(),
        watchedDirectories: this.store.get().watchedDirectories.map((d) => d.path),
        capabilities: AGENT_CAPABILITIES,
      }))
      // Phase 9 — mises à jour
      .handle('agent.update', (req) => this.updater.update(req))
      .handle('runtime.update', (req) => this.updater.updateRuntime(req))
      // Phase 9 — Java géré
      .handle('java.install', async ({ taskId, ...req }) => {
        const active = [...this.tasks.list()].find(
          (t) => t.kind === 'java.install' && t.status === 'running' && t.taskId !== taskId,
        );
        if (active) {
          throw new ProtocolError('E_BUSY', 'another java.install is running', {
            details: { taskId: active.taskId },
          });
        }
        await this.tasks.start({ taskId, kind: 'java.install', payload: req }, async (ctx) => {
          const result = await this.javaInstaller.install(req, ctx);
          this.javaSnapshot = await this.java.list(true).catch(() => this.javaSnapshot);
          return { ...result };
        });
        return { taskId };
      })
      .handle('java.remove', async ({ path: javaPath }) => {
        const removed = await this.javaInstaller.remove(javaPath);
        this.javaSnapshot = await this.java.list(true).catch(() => this.javaSnapshot);
        return { removed };
      })
      // Phase 9 — migration
      .handle('migration.export', async ({ taskId, ...req }) => {
        this.ensureServerIdle(req.serverId, taskId);
        this.watchdog.cancel(req.serverId);
        await this.tasks.start(
          { taskId, kind: 'migration.export', serverId: req.serverId, payload: req },
          (ctx) => this.migration.exportServer(req, ctx),
        );
        return { taskId };
      })
      .handle('transfer.serve', (req) => this.migration.serve(req))
      .handle('migration.precheck', (req) => this.migration.precheck(req))
      .handle('migration.import', async ({ taskId, ...req }) => {
        await this.tasks.start(
          { taskId, kind: 'migration.import', serverId: req.config.serverId, payload: req },
          (ctx) => this.migration.importServer(req, ctx),
        );
        return { taskId };
      })
      .handle('migration.finalize', (req) => this.migration.finalize(req))
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
          if (cfg.backupDestination !== undefined) {
            s.backupDestination = cfg.backupDestination === '' ? undefined : cfg.backupDestination;
          }
          if (cfg.backupSchedules) s.backupSchedules = cfg.backupSchedules;
        });
        if (cfg.backupSchedules) await this.backupScheduler.prune();
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
      .handle('java.list', async () => {
        this.javaSnapshot = await this.java.list(true);
        return { runtimes: this.javaSnapshot };
      });
  }

  // --- Tasks, backups, fs.fetch (phase 8) -----------------------------------------------------

  /** Une seule task backup/restore à la fois par serveur (`E_BUSY`), sauf rejeu du même `taskId`. */
  private ensureServerIdle(serverId: string, taskId: string): void {
    const active = this.tasks.activeFor(serverId, [
      'backup.create',
      'backup.restore',
      'migration.export',
    ]);
    if (active && active.taskId !== taskId) {
      throw new ProtocolError('E_BUSY', 'another backup task is running for this server', {
        details: { serverId, taskId: active.taskId, kind: active.kind },
      });
    }
  }

  private registerTaskHandlers(peer: AgentPeer): void {
    peer
      .handle('task.cancel', ({ taskId }) => {
        const r = this.tasks.cancel(taskId);
        return { cancelled: r.cancelled, ...(r.status === undefined ? {} : { status: r.status }) };
      })
      .handle('task.ackResult', async ({ taskId }) => {
        await this.tasks.ack(taskId);
        return {};
      })
      .handle('task.list', () => ({ tasks: this.tasks.list() }))
      .handle('backup.create', async ({ taskId, ...req }) => {
        this.ensureServerIdle(req.serverId, taskId);
        const request = { ...req, backupId: req.backupId ?? ulid(Date.now()) };
        const record = await this.tasks.start(
          { taskId, kind: 'backup.create', serverId: req.serverId, payload: request },
          (ctx) => this.backups.create(request, ctx),
        );
        const payload = record.payload as { backupId?: string } | undefined;
        return { taskId, backupId: payload?.backupId ?? request.backupId };
      })
      .handle('backup.list', async ({ serverId, destinations }) => ({
        backups: await this.backups.list(serverId, destinations ?? []),
      }))
      .handle('backup.delete', async ({ serverId, backupId, archivePath }) => ({
        deleted: await this.backups.delete(serverId, backupId, archivePath),
      }))
      .handle('backup.restore', async ({ taskId, ...req }) => {
        this.ensureServerIdle(req.serverId, taskId);
        this.watchdog.cancel(req.serverId);
        await this.tasks.start(
          { taskId, kind: 'backup.restore', serverId: req.serverId, payload: req },
          (ctx) => this.backups.restore(req, ctx),
        );
        return { taskId };
      })
      .handle('fs.fetch', async ({ taskId, ...req }) => {
        await this.tasks.start(
          { taskId, kind: 'fs.fetch', serverId: req.serverId, payload: req },
          (ctx) => this.transfers.fetchToServer(req, ctx),
        );
        return { taskId };
      });
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
    return `${PROJECT_NAME} agent ${this.version} — protocole v${String(PROTOCOL_VERSION)} — node ${process.version} ${process.platform}/${process.arch}`;
  }
}

function normalize(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
