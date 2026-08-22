/**
 * Schéma `mmo.db` (doc 04 §1–§6). Conventions : timestamps epoch ms (`*_at`, `ts`), IDs métier
 * ULID, booléens 0/1, JSON en TEXT. Amendements phase 4 (actés doc 04) : `machines.agent_token_prev_*`
 * (rotation avec grâce 24 h), `servers.detection_json` (dernière détection), `processed_events`
 * (dédup des événements critiques rejoués par les agents). Phase 8 : `backups.manifest_json/task_id`.
 * Phase 9 : `machines.runtime_version`, `server_migrations.{source_path,to_path,mode,export_task_id,
 * import_task_id,restart_after}` (migration `0002_phase9`).
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

// --- 1. Utilisateurs, sessions, notifications ---------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'operator', 'viewer'] })
      .notNull()
      .default('viewer'),
    locale: text('locale', { enum: ['fr', 'en'] })
      .notNull()
      .default('fr'),
    theme: text('theme').notNull().default('dark'),
    isActive: integer('is_active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    lastLoginAt: integer('last_login_at'),
  },
  (t) => [
    check('users_role', sql`${t.role} IN ('admin','operator','viewer')`),
    check('users_locale', sql`${t.locale} IN ('fr','en')`),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('idx_sessions_user').on(t.userId), index('idx_sessions_expires').on(t.expiresAt)],
);

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: integer('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSuccessAt: integer('last_success_at'),
    failCount: integer('fail_count').notNull().default(0),
  },
  (t) => [index('idx_push_user').on(t.userId)],
);

export const notificationPrefs = sqliteTable(
  'notification_prefs',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    enabled: integer('enabled').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventType] })],
);

// --- 2. Machines, appairage, agent, répertoires, Java ---------------------------------------------

export const machines = sqliteTable(
  'machines',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    os: text('os', { enum: ['windows', 'linux', 'macos'] }),
    arch: text('arch', { enum: ['x64', 'arm64'] }),
    hostname: text('hostname'),
    agentVersion: text('agent_version'),
    protocolVersion: integer('protocol_version'),
    /** sha256 du secret d'agent. */
    agentTokenHash: text('agent_token_hash'),
    /** Rotation (doc 05 §3) : ancien hash encore accepté jusqu'à `agent_token_prev_until`. */
    agentTokenPrevHash: text('agent_token_prev_hash'),
    agentTokenPrevUntil: integer('agent_token_prev_until'),
    status: text('status', { enum: ['pending', 'online', 'offline', 'disabled'] })
      .notNull()
      .default('pending'),
    lastSeenAt: integer('last_seen_at'),
    cpuModel: text('cpu_model'),
    cpuCores: integer('cpu_cores'),
    ramTotalMb: integer('ram_total_mb'),
    createdAt: integer('created_at').notNull(),
    /** Phase 9 : runtime Node annoncé par l'agent (`auth.hello.runtimeVersion`). */
    runtimeVersion: text('runtime_version'),
  },
  (t) => [
    check('machines_os', sql`${t.os} IN ('windows','linux','macos')`),
    check('machines_arch', sql`${t.arch} IN ('x64','arm64')`),
    check('machines_status', sql`${t.status} IN ('pending','online','offline','disabled')`),
  ],
);

export const pairingCodes = sqliteTable('pairing_codes', {
  id: integer('id').primaryKey(),
  codeHash: text('code_hash').notNull().unique(),
  attempts: integer('attempts').notNull().default(0),
  createdBy: text('created_by').references(() => users.id),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  machineId: text('machine_id').references(() => machines.id, { onDelete: 'cascade' }),
});

export const agentReleases = sqliteTable('agent_releases', {
  version: text('version').primaryKey(),
  protocolVersion: integer('protocol_version').notNull(),
  channel: text('channel').notNull().default('stable'),
  releasedAt: integer('released_at').notNull(),
  bundlePath: text('bundle_path').notNull(),
  bundleSha256: text('bundle_sha256').notNull(),
  bundleSignature: text('bundle_signature').notNull(),
  bundleSize: integer('bundle_size').notNull(),
  runtimeVersion: text('runtime_version'),
  notes: text('notes'),
});

export const watchedDirectories = sqliteTable(
  'watched_directories',
  {
    id: text('id').primaryKey(),
    machineId: text('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    enabled: integer('enabled').notNull().default(1),
    lastScanAt: integer('last_scan_at'),
  },
  (t) => [unique('uq_watched_dir').on(t.machineId, t.path)],
);

export const javaRuntimes = sqliteTable(
  'java_runtimes',
  {
    id: text('id').primaryKey(),
    machineId: text('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    majorVersion: integer('major_version').notNull(),
    fullVersion: text('full_version'),
    vendor: text('vendor'),
    path: text('path').notNull(),
    managed: integer('managed').notNull().default(1),
    installedAt: integer('installed_at').notNull(),
  },
  (t) => [
    unique('uq_java_path').on(t.machineId, t.path),
    index('idx_java_machine').on(t.machineId, t.majorVersion),
  ],
);

// --- 3. Serveurs Minecraft --------------------------------------------------------------------------

export const servers = sqliteTable(
  'servers',
  {
    id: text('id').primaryKey(),
    machineId: text('machine_id')
      .notNull()
      .references(() => machines.id),
    directoryId: text('directory_id').references(() => watchedDirectories.id, {
      onDelete: 'set null',
    }),
    path: text('path').notNull(),
    name: text('name').notNull(),
    loader: text('loader', { enum: ['vanilla', 'forge', 'neoforge', 'fabric', 'unknown'] })
      .notNull()
      .default('unknown'),
    mcVersion: text('mc_version'),
    loaderVersion: text('loader_version'),
    detected: integer('detected').notNull().default(0),
    javaRuntimeId: text('java_runtime_id').references(() => javaRuntimes.id, {
      onDelete: 'set null',
    }),
    /** Déduit (manifest/table), surchargeable par l'utilisateur. */
    javaMajorRequired: integer('java_major_required'),
    /** JSON `string[]` d'arguments JVM supplémentaires. */
    javaArgs: text('java_args'),
    minRamMb: integer('min_ram_mb').notNull().default(1024),
    maxRamMb: integer('max_ram_mb').notNull().default(4096),
    gamePort: integer('game_port'),
    rconEnabled: integer('rcon_enabled').notNull().default(1),
    rconPort: integer('rcon_port'),
    rconPasswordEnc: text('rcon_password_enc'),
    eulaAccepted: integer('eula_accepted').notNull().default(0),
    exposeMode: text('expose_mode', { enum: ['tailnet', 'direct'] })
      .notNull()
      .default('tailnet'),
    provisioning: text('provisioning', {
      enum: ['installing', 'install_failed', 'ready', 'archived', 'migrating'],
    })
      .notNull()
      .default('installing'),
    runState: text('run_state', {
      enum: ['stopped', 'starting', 'running', 'stopping', 'crashed'],
    })
      .notNull()
      .default('stopped'),
    desiredState: text('desired_state', { enum: ['stopped', 'running'] })
      .notNull()
      .default('stopped'),
    attachMode: text('attach_mode', { enum: ['attached', 'detached'] })
      .notNull()
      .default('attached'),
    lastExitReason: text('last_exit_reason'),
    autoRestart: integer('auto_restart').notNull().default(0),
    crashLoopMax: integer('crash_loop_max').notNull().default(3),
    watchdogFreezeS: integer('watchdog_freeze_s').notNull().default(120),
    pid: integer('pid'),
    startedAt: integer('started_at'),
    stoppedAt: integer('stopped_at'),
    /** Dernière sortie de `detectServer()` (JSON `detectedServerSchema`) — phase 4. */
    detectionJson: text('detection_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    unique('uq_servers_path').on(t.machineId, t.path),
    index('idx_servers_machine').on(t.machineId),
    index('idx_servers_run').on(t.runState),
    index('idx_servers_ports').on(t.machineId, t.gamePort),
    check('servers_loader', sql`${t.loader} IN ('vanilla','forge','neoforge','fabric','unknown')`),
    check('servers_expose', sql`${t.exposeMode} IN ('tailnet','direct')`),
    check(
      'servers_provisioning',
      sql`${t.provisioning} IN ('installing','install_failed','ready','archived','migrating')`,
    ),
    check(
      'servers_run_state',
      sql`${t.runState} IN ('stopped','starting','running','stopping','crashed')`,
    ),
    check('servers_desired', sql`${t.desiredState} IN ('stopped','running')`),
    check('servers_attach', sql`${t.attachMode} IN ('attached','detached')`),
  ],
);

export const commandHistory = sqliteTable(
  'command_history',
  {
    id: integer('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    command: text('command').notNull(),
    via: text('via', { enum: ['stdin', 'rcon'] })
      .notNull()
      .default('stdin'),
    ts: integer('ts').notNull(),
  },
  (t) => [index('idx_cmdhist').on(t.serverId, t.userId, t.ts)],
);

export const serverLogFiles = sqliteTable(
  'server_log_files',
  {
    id: integer('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    sizeBytes: integer('size_bytes'),
    firstTs: integer('first_ts'),
    lastTs: integer('last_ts'),
  },
  (t) => [unique('uq_log_files').on(t.serverId, t.fileName)],
);

// --- 4. Joueurs ---------------------------------------------------------------------------------------

export const players = sqliteTable('players', {
  uuid: text('uuid').primaryKey(),
  lastName: text('last_name').notNull(),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
});

export const playerSessions = sqliteTable(
  'player_sessions',
  {
    id: integer('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    playerUuid: text('player_uuid')
      .notNull()
      .references(() => players.uuid),
    playerName: text('player_name').notNull(),
    joinedAt: integer('joined_at').notNull(),
    leftAt: integer('left_at'),
  },
  (t) => [
    index('idx_psess_server').on(t.serverId, t.joinedAt),
    index('idx_psess_player').on(t.playerUuid, t.joinedAt),
    index('idx_psess_online')
      .on(t.serverId)
      .where(sql`${t.leftAt} IS NULL`),
  ],
);

// --- 5. Backups, planificateur, tasks, migrations -------------------------------------------------

export const backupPolicies = sqliteTable(
  'backup_policies',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    cron: text('cron').notNull(),
    destination: text('destination'),
    keepLast: integer('keep_last'),
    keepDays: integer('keep_days'),
    onlyIfRunning: integer('only_if_running').notNull().default(0),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_bpol_server').on(t.serverId)],
);

export const backups = sqliteTable(
  'backups',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    policyId: text('policy_id').references(() => backupPolicies.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: ['manual', 'scheduled', 'pre_migration', 'pre_restore'] }).notNull(),
    status: text('status', { enum: ['running', 'success', 'failed', 'deleted'] }).notNull(),
    machineId: text('machine_id')
      .notNull()
      .references(() => machines.id),
    archivePath: text('archive_path'),
    sizeBytes: integer('size_bytes'),
    sha256: text('sha256'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    error: text('error'),
    createdBy: text('created_by').references(() => users.id),
    /** Phase 8 (amendement doc 04 §5) : manifeste agent (codec, hot, files, bytesRaw, comment) et task associée. */
    manifestJson: text('manifest_json'),
    taskId: text('task_id'),
  },
  (t) => [
    index('idx_backups_server').on(t.serverId, t.startedAt),
    check('backups_kind', sql`${t.kind} IN ('manual','scheduled','pre_migration','pre_restore')`),
    check('backups_status', sql`${t.status} IN ('running','success','failed','deleted')`),
  ],
);

export const scheduledTasks = sqliteTable(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    action: text('action', {
      enum: ['start', 'stop', 'restart', 'backup', 'command', 'announce'],
    }).notNull(),
    cron: text('cron').notNull(),
    payload: text('payload'),
    enabled: integer('enabled').notNull().default(1),
    lastRunAt: integer('last_run_at'),
    lastStatus: text('last_status'),
    nextRunAt: integer('next_run_at'),
    createdBy: text('created_by').references(() => users.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_tasks_next').on(t.enabled, t.nextRunAt),
    check(
      'sched_action',
      sql`${t.action} IN ('start','stop','restart','backup','command','announce')`,
    ),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    machineId: text('machine_id').references(() => machines.id),
    serverId: text('server_id').references(() => servers.id),
    status: text('status', {
      enum: ['pending', 'running', 'stalled', 'done', 'failed', 'cancelled'],
    }).notNull(),
    progress: real('progress'),
    payload: text('payload'),
    refId: text('ref_id'),
    createdBy: text('created_by').references(() => users.id),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
    error: text('error'),
  },
  (t) => [
    index('idx_tasks_status').on(t.status, t.createdAt),
    check(
      'tasks_status',
      sql`${t.status} IN ('pending','running','stalled','done','failed','cancelled')`,
    ),
  ],
);

export const serverMigrations = sqliteTable(
  'server_migrations',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    fromMachineId: text('from_machine_id')
      .notNull()
      .references(() => machines.id),
    toMachineId: text('to_machine_id')
      .notNull()
      .references(() => machines.id),
    toDirectoryId: text('to_directory_id').references(() => watchedDirectories.id),
    backupId: text('backup_id').references(() => backups.id),
    status: text('status', {
      enum: [
        'pending',
        'backing_up',
        'transferring',
        'restoring',
        'verifying',
        'done',
        'failed',
        'rolled_back',
      ],
    }).notNull(),
    progressPct: real('progress_pct'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    error: text('error'),
    createdBy: text('created_by').references(() => users.id),
    /** Phase 9 (amendement doc 04 §5) : chemins, mode de transfert, tasks, relance. */
    sourcePath: text('source_path'),
    toPath: text('to_path'),
    mode: text('mode'),
    exportTaskId: text('export_task_id'),
    importTaskId: text('import_task_id'),
    restartAfter: integer('restart_after').notNull().default(1),
  },
  (t) => [index('idx_migr_server').on(t.serverId, t.startedAt)],
);

// --- 6. Événements, audit, réglages -----------------------------------------------------------------

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey(),
    ts: integer('ts').notNull(),
    type: text('type').notNull(),
    severity: text('severity', { enum: ['debug', 'info', 'warning', 'error', 'critical'] })
      .notNull()
      .default('info'),
    machineId: text('machine_id'),
    serverId: text('server_id'),
    userId: text('user_id'),
    payload: text('payload'),
  },
  (t) => [
    index('idx_events_ts').on(t.ts),
    index('idx_events_server').on(t.serverId, t.ts),
    index('idx_events_type').on(t.type, t.ts),
    check('events_severity', sql`${t.severity} IN ('debug','info','warning','error','critical')`),
  ],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey(),
    ts: integer('ts').notNull(),
    userId: text('user_id'),
    username: text('username'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    details: text('details'),
    ip: text('ip'),
  },
  (t) => [index('idx_audit_ts').on(t.ts), index('idx_audit_user').on(t.userId, t.ts)],
);

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Événements critiques déjà traités (`eventId` des `server.stateChanged`, `player.event`…) : un
 * agent rejoue jusqu'à `event.ack` ; si le panel redémarre entre le traitement et l'ack, le rejeu
 * est reconnu ici et seulement ré-acquitté. Purge > 24 h.
 */
export const processedEvents = sqliteTable(
  'processed_events',
  {
    eventId: text('event_id').primaryKey(),
    ts: integer('ts').notNull(),
  },
  (t) => [index('idx_processed_ts').on(t.ts)],
);

export type UserRow = typeof users.$inferSelect;
export type MachineRow = typeof machines.$inferSelect;
export type ServerRow = typeof servers.$inferSelect;
export type WatchedDirectoryRow = typeof watchedDirectories.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type BackupRow = typeof backups.$inferSelect;
export type BackupPolicyRow = typeof backupPolicies.$inferSelect;
export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;
export type ServerMigrationRow = typeof serverMigrations.$inferSelect;
export type JavaRuntimeRow = typeof javaRuntimes.$inferSelect;
export type AgentReleaseRow = typeof agentReleases.$inferSelect;
