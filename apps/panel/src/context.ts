/** Contexte applicatif : bases, services, registre des agents, hub des clients, relais console. */
import type { FastifyBaseLogger } from 'fastify';
import path from 'node:path';

import { ConsoleRelay } from './agents/console.js';
import { AccessService } from './services/access.js';
import { NotificationsService } from './services/notifications.js';
import { AgentRegistry } from './agents/registry.js';
import { ClientHub } from './clients/hub.js';
import type { PanelConfig } from './config.js';
import {
  openMetricsDatabase,
  openMmoDatabase,
  type MetricsDatabase,
  type MmoDatabase,
} from './db/client.js';
import type { SqliteHandle } from './db/sqlite.js';
import { PublicRateLimits, type PublicRateLimitOptions } from './http/rate-limits.js';
import { AuditService } from './services/audit.js';
import { BackupsService } from './services/backups.js';
import { EventBus } from './services/events.js';
import { JavaResolver } from './services/java.js';
import { JavaRuntimesService } from './services/java-runtimes.js';
import { ServerGroupsService } from './services/groups.js';
import { MigrationsService } from './services/migrations.js';
import { RelayTokens } from './services/relay.js';
import { DistributionService } from './services/distribution.js';
import { ReleasesService } from './services/releases.js';
import { MachinesService } from './services/machines.js';
import { MetricsService } from './services/metrics.js';
import { PanelBackupService } from './services/panel-backup.js';
import { ApiKeysService } from './services/api-keys.js';
import { PermissionsService } from './services/permissions.js';
import { PANEL_VERSION } from './version.js';
import { ProcessedEventsService } from './services/processed-events.js';
import { UpdateCheckService } from './services/update-check.js';
import { WebhooksService, type WebhooksServiceOptions } from './services/webhooks.js';
import { ReplicationService } from './services/replication.js';
import { AlertsService, DEFAULT_THRESHOLDS } from './services/alerts.js';
import { collectConditions } from './services/alert-conditions.js';
import { CommandCatalogService } from './services/command-catalog.js';
import { MacrosService } from './services/macros.js';
import { SchedulerService } from './services/scheduler.js';
import { ServersService } from './services/servers.js';
import { SessionsService } from './services/sessions.js';
import { SETTING_KEYS, SettingsService } from './services/settings.js';
import { TasksService } from './services/tasks.js';
import { TransferService } from './services/transfers.js';
import { UiEventsService } from './services/ui-events.js';
import { UsersService } from './services/users.js';

export interface AppContext {
  config: PanelConfig;
  logger: FastifyBaseLogger;
  now: () => number;
  db: MmoDatabase;
  sqlite: SqliteHandle;
  metrics: MetricsDatabase;
  metricsSqlite: SqliteHandle;
  /** Chemins des deux fichiers (`':memory:'` en test) : VACUUM hebdomadaire et contrôle d'espace disque. */
  files: { mmo: string; metrics: string };
  metricsService: MetricsService;
  uiEvents: UiEventsService;
  settings: SettingsService;
  audit: AuditService;
  events: EventBus;
  users: UsersService;
  sessions: SessionsService;
  /** Lot 8 : clés d'API (`Authorization: Bearer mmo_…`). */
  apiKeys: ApiKeysService;
  /** Lot 8 : droits par serveur et par machine (rôle effectif, visibilité, portées accordées). */
  permissions: PermissionsService;
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
  /** Aperçu des commandes de la console : lu chez le serveur, mis en cache court. */
  commandCatalog: CommandCatalogService;
  /** Séquences de commandes enregistrées, jouées depuis la console. */
  macros: MacrosService;
  alerts: AlertsService;
  transfers: TransferService;
  panelBackup: PanelBackupService;
  /** Phase 9 : jetons de relais (bundles, JRE, archives de migration). */
  relayTokens: RelayTokens;
  releases: ReleasesService;
  javaRuntimes: JavaRuntimesService;
  migrations: MigrationsService;
  /** Groupes de démarrage (lot 7) : actions ordonnées start/stop/restart. */
  groups: ServerGroupsService;
  /** Phase 10 : notifications (push + centre) et couche d'accès. */
  notifications: NotificationsService;
  access: AccessService;
  /** Phase 11 : archives d'installation et scripts servis par le panel. */
  distribution: DistributionService;
  /** Lot 2 : bannière « version X disponible » (releases.atom GitHub, 6 h). */
  updateCheck: UpdateCheckService;
  /** Lot 4 : webhooks sortants (Discord, JSON signé), abonnés au bus comme les notifications. */
  webhooks: WebhooksService;
  /** Lot 4 : copies hors-site des archives vers une autre machine du parc (chaîne de migration). */
  replication: ReplicationService;
  /** `fetch` injectable (tests) pour les appels sortants du panel (manifest Mojang, API spark). */
  fetchImpl: typeof fetch | undefined;
  /**
   * Lot 9 : ce que `/api/health` montre à un administrateur — instant de démarrage, journal
   * courant, dernier passage de maintenance (rempli par `runMaintenance`).
   */
  diagnostics: {
    startedAt: number;
    logFile: () => string | undefined;
    lastMaintenance: MaintenanceSummary | undefined;
  };
  /** Lot 9 : limiteurs par adresse des surfaces publiques. */
  rateLimits: PublicRateLimits;
  close(): void;
}

/** Résumé d'un passage de maintenance tel qu'exposé par `/api/health` (admin). */
export interface MaintenanceSummary {
  at: number;
  durationMs: number;
  /** Tables réellement purgées (compteurs non nuls seulement). */
  purged: Record<string, number>;
  vacuum: { file: string; status: string; reason?: string; afterBytes?: number }[];
}

export interface ContextOptions {
  config: PanelConfig;
  logger: FastifyBaseLogger;
  now?: () => number;
  /** `':memory:'` en test (sinon `<dataDir>/mmo.db`). */
  dbFile?: string;
  metricsFile?: string;
  /** Chemin du journal fichier courant du panel (`boot.ts`), exposé par `/api/health` aux admins. */
  logFile?: () => string | undefined;
  /** Limiteurs des surfaces publiques (relais, distribution, `/ws/agent`) ; bornes abaissées en test. */
  publicRateLimit?: PublicRateLimitOptions;
  /** Seuils de contre-pression vers les navigateurs (abaissés en test). */
  backpressure?: { dropAboveBytes: number; closeAboveBytes: number };
  /** Lot 4 : webhooks — faux résolveur/transport et attentes courtes en test. */
  webhooks?: WebhooksServiceOptions;
  fetch?: typeof fetch;
  /** Période du planificateur (0 = manuel, tests). */
  schedulerTickMs?: number;
  /** Attente de reconnexion d'un agent pendant un transfert (tests : court). */
  transferReconnectWaitMs?: number;
  /** Phase 9 : TTL des listeners/jetons de migration (tests : court). */
  migrationTtlMs?: number;
  /** Groupes : attentes d'état et cadence de relecture (tests : court). */
  groupWait?: { startTimeoutMs?: number; stopTimeoutMs?: number; pollMs?: number };
  /** Phase 10 : options de la couche d'accès (tests : adresses locales, faux DNS/ACME, cadences). */
  access?: Partial<
    Pick<
      ConstructorParameters<typeof AccessService>[0],
      | 'localAddresses'
      | 'resolveTxt'
      | 'acmeDirectory'
      | 'acme'
      | 'dyndnsIntervalMs'
      | 'renewIntervalMs'
      | 'renewBeforeDays'
    >
  >;
}

/** Un échantillon plus vieux que ça est un rejeu de tampon, pas un point à afficher en direct. */
const LIVE_SAMPLE_WINDOW_MS = 60_000;

export function createContext(options: ContextOptions): AppContext {
  const { config, logger } = options;
  const now = options.now ?? (() => Date.now());
  const files = {
    mmo: options.dbFile ?? path.join(config.dataDir, 'mmo.db'),
    metrics: options.metricsFile ?? path.join(config.dataDir, 'metrics.db'),
  };
  const mmo = openMmoDatabase(files.mmo);
  const metrics = openMetricsDatabase(files.metrics);
  const db = mmo.db;

  const settings = new SettingsService(db, now);
  const audit = new AuditService(db, now);
  const events = new EventBus(db, now);
  const users = new UsersService(db, now);
  const sessions = new SessionsService(db, now, config.sessionTtlMs);
  const apiKeys = new ApiKeysService(db, now);
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
    seedBackupPolicy: (serverId) => {
      backups.seedDefaultPolicy(serverId);
    },
  });
  const permissions = new PermissionsService({
    db,
    now,
    machineOf: (serverId) => servers.get(serverId)?.machineId,
    machineExists: (machineId) => machines.get(machineId) !== undefined,
  });
  // Rôle ou `scoped` modifiés, compte supprimé : la vue en cache de ses droits tombe.
  users.onChanged((userId) => {
    permissions.invalidate(userId);
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
    // Lot 8 : un compte limité ne reçoit que ce qui concerne ses portées, et ne peut s'abonner
    // qu'à la console d'un serveur qu'il voit.
    filter: (conn, message) =>
      permissions.visibleMessage(permissions.snapshot(conn.user.id), message),
    canSubscribe: (conn, channel) =>
      permissions.canSubscribe(permissions.snapshot(conn.user.id), channel),
    ...(options.backpressure === undefined ? {} : { backpressure: options.backpressure }),
  });
  relay.bind(hub);
  events.subscribe((event) => {
    hub.broadcast({ type: 'event', event });
  });
  const metricsService = new MetricsService({
    sqlite: metrics.sqlite,
    now,
    onSample: (machineId, sample) => {
      // Budget de performance (lot 9) : seuls les échantillons « vivants » vont aux navigateurs.
      // Un agent qui se reconnecte rejoue jusqu'à une heure de tampon (240 échantillons) : les
      // diffuser tous coûtait 240 messages par navigateur pour des points qu'aucune vue n'affiche
      // en direct — ils partent en base et les graphiques les reliront.
      if (sample.ts >= now() - LIVE_SAMPLE_WINDOW_MS) {
        hub.broadcast({ type: 'metrics.sample', machineId, sample });
      }
    },
  });

  const uiEvents = new UiEventsService(metrics.sqlite);

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
    // Lot 4 : archive déclarée corrompue par la relecture de l'agent — une fois par archive.
    onCorrupted: (row) => {
      const server = servers.get(row.serverId);
      events.publish({
        type: 'backup.corrupted',
        severity: 'error',
        serverId: row.serverId,
        machineId: row.machineId,
        payload: {
          backupId: row.id,
          path: row.archivePath,
          sizeBytes: row.sizeBytes,
          sha256: row.sha256,
          serverName: server?.name ?? row.serverId,
        },
      });
    },
  });
  // Rattrapage unique (recette 1.0) : les serveurs d'avant la politique par défaut en reçoivent
  // une s'ils n'en ont aucune. Jamais rejoué ensuite — supprimer la politique reste définitif.
  if (settings.get(SETTING_KEYS.backupDefaultsSeeded) !== '1') {
    for (const row of servers.list()) {
      if (!backups.hasPolicies(row.id)) backups.seedDefaultPolicy(row.id);
    }
    settings.set(SETTING_KEYS.backupDefaultsSeeded, '1');
  }
  /**
   * Catalogue des commandes, alimenté par le serveur lui-même. Vidé quand un serveur redémarre :
   * un modpack mis à jour n'expose plus les mêmes commandes.
   */
  const commandCatalog = new CommandCatalogService({ registry, servers, now, logger });
  const macros = new MacrosService({ db, now, logger });
  events.subscribe((event) => {
    if (event.type === 'server.stateChanged' && event.serverId !== null) {
      commandCatalog.invalidate(event.serverId);
    }
  });

  const scheduler = new SchedulerService({
    db,
    now,
    registry,
    servers,
    events,
    audit,
    logger,
    settings,
    ...(options.schedulerTickMs === undefined ? {} : { tickMs: options.schedulerTickMs }),
  });
  /**
   * Alertes à état. Les seuils sont lus dans `app_settings` à chaque évaluation : ils se règlent
   * sans redémarrer, et un réglage absent retombe sur le défaut.
   */
  const alertThresholds = () => ({
    machineOfflineMs:
      settings.getInt(
        'alerts.machineOfflineMinutes',
        DEFAULT_THRESHOLDS.machineOfflineMs / 60_000,
      ) * 60_000,
    serverDownMs:
      settings.getInt('alerts.serverDownMinutes', DEFAULT_THRESHOLDS.serverDownMs / 60_000) *
      60_000,
    diskEnterPct: settings.getInt('alerts.diskPercent', DEFAULT_THRESHOLDS.diskEnterPct),
    diskExitPct: settings.getInt('alerts.diskPercentClear', DEFAULT_THRESHOLDS.diskExitPct),
    tpsEnter: settings.getInt('alerts.tpsBelow', DEFAULT_THRESHOLDS.tpsEnter),
    tpsExit: settings.getInt('alerts.tpsClear', DEFAULT_THRESHOLDS.tpsExit),
    sampleMaxAgeMs: DEFAULT_THRESHOLDS.sampleMaxAgeMs,
    repeatMs:
      settings.getInt('alerts.repeatHours', DEFAULT_THRESHOLDS.repeatMs / 3_600_000) * 3_600_000,
  });
  const alerts = new AlertsService({
    db,
    now,
    thresholds: alertThresholds,
    conditions: (firing) =>
      collectConditions(
        {
          now: now(),
          thresholds: alertThresholds(),
          machines: machines.list(),
          servers: servers.list(),
          machineSample: (id) => metricsService.latestMachinePoint(id),
          serverSample: (id) => metricsService.latestServerPoint(id),
        },
        firing,
      ),
    publish: (event) => {
      events.publish(event);
    },
  });
  const transfers = new TransferService({
    registry,
    logger,
    ...(options.transferReconnectWaitMs === undefined
      ? {}
      : { reconnectWaitMs: options.transferReconnectWaitMs }),
  });
  const panelBackup = new PanelBackupService({
    sqlite: mmo.sqlite,
    dataDir: config.dataDir,
    now,
    panelVersion: PANEL_VERSION,
  });

  // Phase 9 : relais, releases d'agent, Java géré, migrations.
  const relayTokens = new RelayTokens(now);
  const releases = new ReleasesService({
    db,
    now,
    dataDir: config.dataDir,
    registry,
    relay: relayTokens,
    machines,
    settings,
    events,
    audit,
  });
  const distribution = new DistributionService({
    distDir: config.distDir ?? path.join(config.dataDir, 'dist'),
    settings,
    releases,
  });
  const updateCheck = new UpdateCheckService({
    settings,
    events,
    now,
    fetchImpl: options.fetch ?? fetch,
  });
  const javaRuntimes = new JavaRuntimesService({
    db,
    now,
    dataDir: config.dataDir,
    registry,
    relay: relayTokens,
    tasks,
    fetchImpl: options.fetch,
    logger,
  });
  const migrations = new MigrationsService({
    db,
    now,
    registry,
    servers,
    machines,
    tasks,
    backups,
    java: javaRuntimes,
    relay: relayTokens,
    events,
    audit,
    logger,
    broadcast: (migration) => {
      hub.broadcast({ type: 'migration.update', migration });
    },
    pushConfig: async (machineId) => {
      await registry.get(machineId)?.pushConfig();
    },
    ...(options.migrationTtlMs === undefined ? {} : { ttlMs: options.migrationTtlMs }),
  });
  const groups = new ServerGroupsService({
    db,
    now,
    servers,
    registry,
    events,
    audit,
    logger,
    ...(options.groupWait ?? {}),
  });

  // Lot 4 : copies hors-site — même relais et mêmes TTL que les migrations.
  const replication = new ReplicationService({
    db,
    now,
    registry,
    servers,
    machines,
    tasks,
    backups,
    relay: relayTokens,
    logger,
    ttlMs: options.migrationTtlMs,
  });

  // Phase 10 : notifications (abonné au bus) et couche d'accès.
  const notifications = new NotificationsService({
    db,
    now,
    events,
    settings,
    logger,
    fetchImpl: options.fetch ?? fetch,
    serverName: (id) => servers.get(id)?.name,
    machineName: (id) => machines.get(id)?.name,
    // Lot 8 : ni cloche ni push pour ce qu'un compte limité ne voit pas.
    visibleTo: (userId, event) => permissions.visibleRef(permissions.snapshot(userId), event),
  });
  const access = new AccessService({
    config,
    settings,
    machines,
    servers,
    events,
    audit,
    logger,
    now,
    fetchImpl: options.fetch ?? fetch,
    ...(options.access ?? {}),
  });
  // Lot 4 : webhooks sortants — même rendu localisé que le push, file par webhook.
  const webhooks = new WebhooksService({
    db,
    now,
    events,
    logger,
    render: (event, locale) => notifications.render(event, locale),
    serverName: (id) => servers.get(id)?.name,
    machineName: (id) => machines.get(id)?.name,
    publicUrl: () => settings.get(SETTING_KEYS.publicUrl),
    version: PANEL_VERSION,
    ...(options.webhooks ?? {}),
  });

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
    files,
    metricsService,
    alerts,
    uiEvents,
    settings,
    audit,
    events,
    users,
    sessions,
    apiKeys,
    permissions,
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
    commandCatalog,
    macros,
    transfers,
    panelBackup,
    relayTokens,
    releases,
    javaRuntimes,
    migrations,
    groups,
    notifications,
    access,
    distribution,
    updateCheck,
    webhooks,
    replication,
    fetchImpl: options.fetch,
    diagnostics: {
      startedAt: now(),
      logFile: options.logFile ?? (() => undefined),
      lastMaintenance: undefined,
    },
    rateLimits: new PublicRateLimits({ ...options.publicRateLimit, now }),
    close: () => {
      access.stop();
      notifications.dispose();
      webhooks.dispose();
      migrations.dispose();
      scheduler.stop();
      registry.closeAll();
      hub.closeAll();
      metricsService.close();
      mmo.close();
      metrics.close();
    },
  };
}
