/** Cycle de vie agent : appairage, authentification, snapshot, heartbeat, configuration (doc 05 §3–6). */
import { z } from 'zod';

import {
  attachModeSchema,
  capabilitySchema,
  compressionSchema,
  cpuSourceSchema,
  desiredStateSchema,
  emptyPayloadSchema,
  epochMsSchema,
  javaRuntimeSchema,
  loaderSchema,
  logLevelSchema,
  machineInfoSchema,
  portSchema,
  runStateSchema,
  serverIdSchema,
  ulidSchema,
} from '../common.js';
import { launchPlanSchema } from './server.js';

// --- pair.request (A→P) -------------------------------------------------------------------------

export const pairRequestSchema = z.object({
  /** Code d'appairage saisi par l'installateur (`MMOP-7F2K-9QXB`), comparé haché côté panel. */
  code: z.string().min(1),
  machine: machineInfoSchema,
  agentVersion: z.string(),
  protoMin: z.int().positive(),
  protoMax: z.int().positive(),
});
export const pairResponseSchema = z.object({
  agentId: z.string().min(1),
  /** Secret 256 bits (hex) — stocké chiffré/ACL côté agent, haché côté panel. */
  secret: z.string().min(32),
});

// --- auth.hello (A→P) -----------------------------------------------------------------------------

export const resumeInfoSchema = z.object({
  pendingTaskIds: z.array(z.string()).default([]),
  lastAckedReqId: ulidSchema.optional(),
});

export const authHelloSchema = z.object({
  agentId: z.string().min(1),
  agentSecret: z.string().min(1),
  agentVersion: z.string(),
  protoMin: z.int().positive(),
  protoMax: z.int().positive(),
  capabilities: z.array(capabilitySchema).default([]),
  /** Codecs supportés par le runtime de l'agent (spike n°3 : zstd ≥ Node 22.15). Jamais présumé. */
  compression: z.array(compressionSchema).optional(),
  resume: resumeInfoSchema.optional(),
  machine: machineInfoSchema.optional(),
});

export const subscriptionSchema = z.object({
  channel: z.string().min(1),
  sinceSeq: z.int().nonnegative(),
});

export const authOkSchema = z.object({
  protocolVersion: z.int().positive(),
  heartbeatIntervalSec: z.int().positive(),
  wantFullSync: z.boolean(),
  subscriptions: z.array(subscriptionSchema).default([]),
  /** Codec retenu par le panel parmi ceux annoncés (`zstd` préféré, `gzip` garanti). */
  compression: compressionSchema.optional(),
  serverTime: epochMsSchema.optional(),
});

// --- sync.state (A→P) -----------------------------------------------------------------------------

export const syncServerSchema = z.object({
  /** ID connu via le marqueur `.mmo-server.json` ; absent si jamais adopté par le panel. */
  serverId: serverIdSchema.optional(),
  path: z.string(),
  runState: runStateSchema,
  attachMode: attachModeSchema,
  pid: z.int().positive().optional(),
  startedAt: epochMsSchema.optional(),
  gamePort: portSchema.optional(),
  rconPort: portSchema.optional(),
});

export const syncTaskSchema = z.object({
  taskId: z.string(),
  type: z.string(),
  status: z.string(),
  updatedAt: epochMsSchema.optional(),
});

export const syncStateSchema = z.object({
  servers: z.array(syncServerSchema),
  tasks: z.array(syncTaskSchema).default([]),
  /** Compteurs `seq` par canal (`console:<serverId>`, `metrics`, `agent.log`). */
  seqs: z.record(z.string(), z.int().nonnegative()).default({}),
  portsInUse: z.array(portSchema).default([]),
  javaRuntimes: z.array(javaRuntimeSchema).default([]),
});

// --- agent.heartbeat (A→P, event) --------------------------------------------------------------

export const agentHeartbeatSchema = z.object({
  ts: epochMsSchema,
  cpuPct: z.number().min(0).optional(),
  cpuSource: cpuSourceSchema.optional(),
  ramUsedMb: z.int().nonnegative().optional(),
  ramTotalMb: z.int().positive().optional(),
  diskUsedGb: z.number().nonnegative().optional(),
  diskTotalGb: z.number().positive().optional(),
  activeServers: z.int().nonnegative(),
  activeTasks: z.int().nonnegative(),
});

// --- agent.info (P→A) -----------------------------------------------------------------------------

export const volumeSchema = z.object({
  path: z.string(),
  totalGb: z.number().nonnegative(),
  freeGb: z.number().nonnegative(),
});

export const agentInfoResponseSchema = z.object({
  machine: machineInfoSchema,
  agentVersion: z.string(),
  runtimeVersion: z.string().optional(),
  volumes: z.array(volumeSchema).default([]),
  javaRuntimes: z.array(javaRuntimeSchema).default([]),
  watchedDirectories: z.array(z.string()).default([]),
  capabilities: z.array(capabilitySchema).default([]),
});

// --- agent.configure (P→A) ------------------------------------------------------------------------

export const watchedDirectorySchema = z.object({
  id: z.string(),
  path: z.string(),
  enabled: z.boolean().default(true),
});

export const watchdogPolicySchema = z.object({
  serverId: serverIdSchema,
  autoRestart: z.boolean(),
  crashLoopMax: z.int().nonnegative(),
  freezeTimeoutSec: z.int().positive(),
  freezeAction: z.enum(['none', 'kill_restart']),
});

export const backupScheduleSchema = z.object({
  id: z.string(),
  serverId: serverIdSchema,
  /** Expression cron 5 champs, évaluée localement par l'agent (heure locale de la machine). */
  cron: z.string(),
  /** Rotation : garde les N plus récentes de cette politique. */
  keep: z.int().positive().optional(),
  keepDays: z.int().positive().optional(),
  onlyIfRunning: z.boolean().default(false),
  destination: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;

/**
 * Configuration de lancement d'un serveur, poussée par le panel (autorité des IDs et des réglages)
 * et **persistée côté agent** : l'agent doit savoir lancer un serveur sans panel (restauration au
 * boot, watchdog). L'agent dépose le marqueur `.mmo-server.json` dans `path`. Ajout phase 3 (sans bump).
 */
export const serverConfigSchema = z.object({
  serverId: serverIdSchema,
  /** Chemin absolu du dossier sur la machine de l'agent. */
  path: z.string().min(1),
  name: z.string().optional(),
  maxRamMb: z.int().positive(),
  minRamMb: z.int().positive().optional(),
  loader: loaderSchema.optional(),
  mcVersion: z.string().optional(),
  /** Template de lancement (doc 06 §1) ; absent ⇒ redétection du dossier au démarrage. */
  launch: launchPlanSchema.optional(),
  /** Version Java majeure requise (override utilisateur ou manifest) ; absente ⇒ table par version MC. */
  javaMajor: z.int().positive().optional(),
  /** Exactement cette version majeure (Forge ≤ 1.16.5). */
  javaStrict: z.boolean().optional(),
  /** Exécutable java imposé (ignore la sélection automatique). */
  javaPath: z.string().optional(),
  /** Arguments JVM supplémentaires (après les flags injectés par l'agent). */
  jvmArgs: z.array(z.string()).optional(),
  startTimeoutSec: z.int().positive().optional(),
  stopTimeoutSec: z.int().positive().optional(),
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const agentConfigureSchema = z.object({
  watchedDirectories: z.array(watchedDirectorySchema).optional(),
  /** Serveurs adoptés par le panel (liste complète si présente : un serveur absent est oublié par l'agent). */
  servers: z.array(serverConfigSchema).optional(),
  backupDestination: z.string().optional(),
  watchdog: z.array(watchdogPolicySchema).optional(),
  backupSchedules: z.array(backupScheduleSchema).optional(),
  /** `desired_state` par serveur, persisté côté agent (autonomie, doc 05 §5). */
  desiredStates: z.record(serverIdSchema, desiredStateSchema).optional(),
  restoreOnBoot: z.boolean().optional(),
  metricsIntervalSec: z.int().positive().optional(),
});
export const agentConfigureResponseSchema = z.object({ applied: z.literal(true) });

// --- agent.rotateSecret / agent.restart (P→A) -----------------------------------------------------

export const agentRotateSecretSchema = z.object({
  newSecret: z.string().min(32),
  /** Les deux secrets restent valides jusqu'à cette date (24 h) pour éviter le lockout. */
  graceUntil: epochMsSchema,
});

export const agentRestartSchema = z.object({ reason: z.string().optional() });
export const agentRestartResponseSchema = z.object({ accepted: z.literal(true) });

// --- agent.log (A→P, event) ----------------------------------------------------------------------

export const agentLogSchema = z.object({
  ts: epochMsSchema,
  level: logLevelSchema,
  message: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export { emptyPayloadSchema };
