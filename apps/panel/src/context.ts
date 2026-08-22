/** Contexte applicatif : bases, services, registre des agents, hub des clients, relais console. */
import type { FastifyBaseLogger } from 'fastify';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { ConsoleRelay } from './agents/console.js';
import { AgentRegistry } from './agents/registry.js';
import { ClientHub } from './clients/hub.js';
import type { PanelConfig } from './config.js';
import {
  openMetricsDatabase,
  openMmoDatabase,
  type MetricsDatabase,
  type MmoDatabase,
} from './db/client.js';
import { AuditService } from './services/audit.js';
import { BackupsService } from './services/backups.js';
import { EventBus } from './services/events.js';
import { JavaResolver } from './services/java.js';
import { MachinesService } from './services/machines.js';
import { MetricsService } from './services/metrics.js';
import { PanelBackupService } from './services/panel-backup.js';
import { ProcessedEventsService } from './services/processed-events.js';
import { SchedulerService } from './services/scheduler.js';
import { ServersService } from './services/servers.js';
import { SessionsService } from './services/sessions.js';
import { SettingsService } from './services/settings.js';
import { TasksService } from './services/tasks.js';
import { TransferService } from './services/transfers.js';
import { UsersService } from './services/users.js';

export interface AppContext {
  config: PanelConfig;
  logger: FastifyBaseLogger;
  now: () => number;
  db: MmoDatabase;
  sqlite: Database.Database;
  metrics: MetricsDatabase;
  metricsSqlite: Database.Database;
  metricsService: MetricsService;
  settings: SettingsService;
  audit: AuditService;
  events: EventBus;
  users: UsersService;
  sessions: SessionsService;
  machines: MachinesService;
  servers: ServersService;
  java: JavaResolver;
  processed: ProcessedEventsService;
  registry: AgentRegistry;
  relay: ConsoleRelay;
  hub: ClientHub;
  /** Phase 8. */
  tasks: TasksService;
  backups: BackupsService;
  scheduler: SchedulerService;
  transfers: TransferService;
  panelBackup: PanelBackupService;
  /** `fetch` injectable (tests) pour les appels sortants du panel (manifest Mojang, API spark). */
  fetchImpl: typeof fetch | undefined;
  close(): void;
}

export interface ContextOptions {
  config: PanelConfig;
  logger: FastifyBaseLogger;
  now?: () => number;
  /** `':memory:'` en test (sinon `<dataDir>/mmo.db`). */
  dbFile?: string;
  metricsFile?: string;
  fetch?: typeof fetch;
  /** Période du planificateur (0 = manuel, tests). */
  schedulerTickMs?: number;
  /** Attente de reconnexion d'un agent pendant un transfert (tests : court). */
  transferReconnectWaitMs?: number;
}

export function createContext(options: ContextOptions): AppContext {
  const { config, logger } = options;
  const now = options.now ?? (() => Date.now());
  const mmo = openMmoDatabase(options.dbFile ?? path.join(config.dataDir, 'mmo.db'));
  const metrics = openMetricsDatabase(
    options.metricsFile ?? path.join(config.dataDir, 'metrics.db'),
  );
  const db = mmo.db;

  const settings = new SettingsService(db, now);
  const audit = new AuditService(db, now);
  const events = new EventBus(db, now);
  const users = new UsersService(db, now);
  const sessions = new SessionsService(db, now, config.sessionTtlMs);
  const machines = new MachinesService(db, now);
  const java = new JavaResolver({
    manifest: config.mojangManifest,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now,
  });
  const servers = new ServersService({
    db,
    now,
    events,
    java,
    settings,
    backupSchedules: (serverIds) => backups.schedulesFor(serverIds),
  });
  const processed = new ProcessedEventsService(db, now);
  const registry = new AgentRegistry();
  const relay = new ConsoleRelay({ logger, registry, servers });
  const hub = new ClientHub({
    logger,
    now,
    onSubscribe: (channel, conn, first) => relay.onSubscribe(channel, conn, first),
    onUnsubscribe: (channel) => {
      relay.onUnsubscribe(channel);
    },
  });
  relay.bind(hub);
  events.subscribe((event) => {
    hub.broadcast({ type: 'event', event });
  });
  const metricsService = new MetricsService({
    sqlite: metrics.sqlite,
    now,
    onSample: (machineId, sample) => {
      hub.broadcast({ type: 'metrics.sample', machineId, sample });
    },
  });

  const tasks = new TasksService({
    db,
    now,
    broadcast: (task) => {
      hub.broadcast({ type: 'task.update', task });
    },
  });
  const backups = new BackupsService({
    db,
    now,
    settings,
    broadcast: (backup) => {
      hub.broadcast({ type: 'backup.update', backup });
    },
  });
  const scheduler = new SchedulerService({
    db,
    now,
    registry,
    servers,
    events,
    audit,
    logger,
    ...(options.schedulerTickMs === undefined ? {} : { tickMs: options.schedulerTickMs }),
  });
  const transfers = new TransferService({
    registry,
    logger,
    ...(options.transferReconnectWaitMs === undefined
      ? {}
      : { reconnectWaitMs: options.transferReconnectWaitMs }),
  });
  const panelBackup = new PanelBackupService({ sqlite: mmo.sqlite, dataDir: config.dataDir, now });

  // Au démarrage : aucun agent n'est connecté, tout `online` est un reliquat d'une exécution précédente.
  machines.markAllOffline();
  // Les tasks encore « en cours » seront réconciliées (`task.list`) à la reconnexion de chaque agent.
  for (const m of machines.list()) tasks.markStalled(m.id);

  return {
    config,
    logger,
    now,
    db,
    sqlite: mmo.sqlite,
    metrics: metrics.db,
    metricsSqlite: metrics.sqlite,
    metricsService,
    settings,
    audit,
    events,
    users,
    sessions,
    machines,
    servers,
    java,
    processed,
    registry,
    relay,
    hub,
    tasks,
    backups,
    scheduler,
    transfers,
    panelBackup,
    fetchImpl: options.fetch,
    close: () => {
      scheduler.stop();
      registry.closeAll();
      hub.closeAll();
      metricsService.close();
      mmo.close();
      metrics.close();
    },
  };
}
