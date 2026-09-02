/**
 * Contrat panel ↔ front (`@mmo/protocol/client`) : messages du WebSocket `/ws/client` et DTO de
 * l'API REST. Distinct du protocole panel↔agent (même règle : jamais `.strict()`, le front et le
 * panel peuvent différer d'une version).
 */
import { z } from 'zod';

import {
  archSchema,
  attachModeSchema,
  desiredStateSchema,
  epochMsSchema,
  exitReasonSchema,
  loaderSchema,
  osSchema,
  provisioningSchema,
  runStateSchema,
  tpsSourceSchema,
} from '../common.js';
import { ERROR_CODES } from '../errors.js';
import { consoleLineSchema, logsSearchSchema } from '../messages/console.js';
import {
  configFileSchema,
  configSetResponseSchema,
  fsEntrySchema,
  fsMoveSchema,
  fsPathSchema,
  fsReadResponseSchema,
  fsWriteSchema,
  relativePathSchema,
} from '../messages/fs.js';
import { javaVendorSchema } from '../messages/java.js';
import { migrationPrecheckResponseSchema } from '../messages/migration.js';
import { metricsSampleSchema } from '../messages/monitoring.js';
import { backupCodecSchema, backupKindSchema } from '../messages/tasks.js';
import {
  detectedServerSchema,
  playerActionResponseSchema,
  playerActionSchema,
  playerResolveResponseSchema,
  playerResolveSchema,
  type resolvedPlayerSchema,
} from '../messages/server.js';

// --- Erreurs HTTP --------------------------------------------------------------------------------

/** Codes propres au panel (en plus des codes protocole) — traduits par l'UI (`errors` de `@mmo/shared`). */
export const PANEL_ERROR_CODES = [
  'E_FORBIDDEN',
  'E_RATE_LIMITED',
  'E_SETUP_REQUIRED',
  'E_SETUP_DONE',
  'E_AGENT_OFFLINE',
  'E_VALIDATION',
  /** Phase 9 : aucune release d'agent publiée / bundle introuvable. */
  'E_NO_RELEASE',
  /** Phase 10 : push non configuré (VAPID absent) ; accès non configuré (domaine/fournisseur) ; ACME/DNS en échec. */
  'E_PUSH_DISABLED',
  'E_ACCESS_NOT_CONFIGURED',
  'E_ACME_FAILED',
  'E_DNS_FAILED',
] as const;
export const API_ERROR_CODES = [...ERROR_CODES, ...PANEL_ERROR_CODES] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// --- Utilisateurs et sessions ----------------------------------------------------------------------

export const roleSchema = z.enum(['admin', 'operator', 'viewer']);
export type Role = z.infer<typeof roleSchema>;
export const localeSchema = z.enum(['fr', 'en']);

export const userDtoSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: roleSchema,
  locale: localeSchema,
  theme: z.string(),
  isActive: z.boolean(),
  createdAt: epochMsSchema,
  lastLoginAt: epochMsSchema.nullable(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const usernameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/);
export const passwordSchema = z.string().min(8).max(256);

export const setupStatusSchema = z.object({ needsSetup: z.boolean() });
export const setupRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  locale: localeSchema.optional(),
  /**
   * URL publique du panel (base du one-liner d'installation et de l'URL WS des agents).
   * Saisie tolérée sans schéma (« panel.tailnet.ts.net ») : le panel normalise et revalide
   * strictement (`coerceOrigin`) — c'est lui l'autorité, pas ce schéma.
   */
  publicUrl: z.string().max(300).optional(),
  backupDestination: z.string().optional(),
  accessMode: z.enum(['tailscale', 'direct', 'manual']).optional(),
});
export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export const updateMeSchema = z.object({
  locale: localeSchema.optional(),
  theme: z.string().min(1).max(32).optional(),
  currentPassword: z.string().optional(),
  newPassword: passwordSchema.optional(),
});
export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema.optional(),
  locale: localeSchema.optional(),
});
export const updateUserSchema = z.object({
  role: roleSchema.optional(),
  locale: localeSchema.optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// --- Machines --------------------------------------------------------------------------------------

export const machineStatusSchema = z.enum(['pending', 'online', 'offline', 'disabled']);

export const machineHeartbeatDtoSchema = z.object({
  ts: epochMsSchema,
  cpuPct: z.number().optional(),
  cpuSource: z.enum(['cycles', 'proc', 'ticks']).optional(),
  ramUsedMb: z.int().optional(),
  ramTotalMb: z.int().optional(),
  diskUsedGb: z.number().optional(),
  diskTotalGb: z.number().optional(),
  activeServers: z.int(),
  activeTasks: z.int(),
  /** Lot 9 (`agent.self`) : coût du processus agent — RSS en Mio, CPU en cœurs (100 = un cœur). */
  agentRssMb: z.number().optional(),
  agentCpuPct: z.number().optional(),
});

export const machineDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  os: osSchema.nullable(),
  arch: archSchema.nullable(),
  hostname: z.string().nullable(),
  agentVersion: z.string().nullable(),
  protocolVersion: z.int().nullable(),
  status: machineStatusSchema,
  /** Session WebSocket ouverte à cet instant (dérivé, jamais stocké). */
  connected: z.boolean(),
  lastSeenAt: epochMsSchema.nullable(),
  cpuModel: z.string().nullable(),
  cpuCores: z.int().nullable(),
  ramTotalMb: z.int().nullable(),
  createdAt: epochMsSchema,
  /** Phase 9 : runtime Node de l'agent, dernière release publiée et disponibilité d'une mise à jour. */
  runtimeVersion: z.string().nullable().optional(),
  latestRelease: z.string().nullable().optional(),
  updateAvailable: z.boolean().optional(),
  /** Phase 10 : adresses remontées par l'agent et surcharges manuelles (adresse à donner aux amis). */
  addresses: z.object({ tailnet: z.array(z.string()), global: z.array(z.string()) }).optional(),
  tailnetHost: z.string().nullable().optional(),
  publicHost: z.string().nullable().optional(),
  /** Lot 2 : URL du panel telle que vue par cette machine (null = `panel.publicUrl`). */
  panelUrl: z.string().nullable().optional(),
  heartbeat: machineHeartbeatDtoSchema.optional(),
  watchedDirectories: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      enabled: z.boolean(),
      lastScanAt: epochMsSchema.nullable(),
    }),
  ),
});
export type MachineDto = z.infer<typeof machineDtoSchema>;

export const createMachineSchema = z.object({ name: z.string().min(1).max(64) });
export const updateMachineSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  disabled: z.boolean().optional(),
  /** Phase 10 : nom MagicDNS / IP tailnet et hôte public (domaine ou IPv6) — null = détection. */
  tailnetHost: z.string().max(253).nullable().optional(),
  publicHost: z.string().max(253).nullable().optional(),
  /** Lot 2 : adresse de rattachement de la machine (origine http(s)) — null = URL publique. */
  panelUrl: z.string().max(255).nullable().optional(),
});
export const pairingCodeDtoSchema = z.object({
  machineId: z.string(),
  /** Code en clair — affiché une seule fois, jamais stocké. */
  code: z.string(),
  expiresAt: epochMsSchema,
  /** One-liners d'installation (nécessitent `publicUrl`). */
  install: z.object({ windows: z.string(), unix: z.string() }).optional(),
});
export type PairingCodeDto = z.infer<typeof pairingCodeDtoSchema>;
export const addDirectorySchema = z.object({ path: z.string().min(1) });
export const scanRequestSchema = z.object({ paths: z.array(z.string().min(1)).optional() });

// --- Serveurs --------------------------------------------------------------------------------------

export const serverDtoSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  directoryId: z.string().nullable(),
  path: z.string(),
  name: z.string(),
  loader: loaderSchema,
  mcVersion: z.string().nullable(),
  loaderVersion: z.string().nullable(),
  detected: z.boolean(),
  javaMajorRequired: z.int().nullable(),
  javaArgs: z.array(z.string()),
  minRamMb: z.int(),
  maxRamMb: z.int(),
  gamePort: z.int().nullable(),
  rconEnabled: z.boolean(),
  rconPort: z.int().nullable(),
  eulaAccepted: z.boolean(),
  exposeMode: z.enum(['tailnet', 'direct']),
  provisioning: provisioningSchema,
  runState: runStateSchema,
  desiredState: desiredStateSchema,
  attachMode: attachModeSchema,
  lastExitReason: exitReasonSchema.nullable(),
  autoRestart: z.boolean(),
  crashLoopMax: z.int(),
  watchdogFreezeS: z.int(),
  pid: z.int().nullable(),
  startedAt: epochMsSchema.nullable(),
  stoppedAt: epochMsSchema.nullable(),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
  /** Agent joignable à cet instant (dérivé de la machine) ; sinon « inaccessible ». */
  reachable: z.boolean(),
  /** Groupe de démarrage et rang dans le groupe (démarrage croissant, arrêt décroissant). */
  groupId: z.string().nullable().default(null),
  groupPosition: z.int().default(0),
  /** Dernière détection (confiance, evidence, template de lancement). */
  detection: detectedServerSchema.optional(),
});
export type ServerDto = z.infer<typeof serverDtoSchema>;

export const createServerSchema = z.object({
  machineId: z.string().min(1),
  /** Dossier arbitraire sur la machine (ajout manuel, doc 02 §2) : scanné puis adopté. */
  path: z.string().min(1),
  name: z.string().min(1).max(64).optional(),
});
export const updateServerSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  minRamMb: z.int().positive().optional(),
  maxRamMb: z.int().positive().optional(),
  /** Override Java (null = retour à la détection). */
  javaMajorRequired: z.int().positive().nullable().optional(),
  javaArgs: z.array(z.string()).optional(),
  gamePort: z.int().min(1).max(65535).nullable().optional(),
  exposeMode: z.enum(['tailnet', 'direct']).optional(),
  autoRestart: z.boolean().optional(),
  crashLoopMax: z.int().nonnegative().optional(),
  watchdogFreezeS: z.int().positive().optional(),
  provisioning: z.enum(['ready', 'archived']).optional(),
  /** Groupe de démarrage (null = retirer du groupe) et rang dans le groupe. */
  groupId: z.string().min(1).nullable().optional(),
  groupPosition: z.int().min(0).max(9999).optional(),
});
export const stopServerSchema = z.object({
  timeoutSec: z.int().positive().optional(),
  announce: z.string().optional(),
  forceAfterTimeout: z.boolean().optional(),
});

/**
 * Groupes de démarrage (lot 7) : démarrage séquentiel par `groupPosition` croissante en attendant
 * `running`, arrêt en ordre inverse. L'appartenance et le rang se règlent serveur par serveur
 * (`updateServerSchema.groupId`/`groupPosition`).
 */
export const serverGroupDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
});
export type ServerGroupDto = z.infer<typeof serverGroupDtoSchema>;

export const serverGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export type ServerGroupInput = z.infer<typeof serverGroupInputSchema>;

export const groupActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
});
export type GroupAction = z.infer<typeof groupActionSchema>['action'];
export const commandRequestSchema = z.object({ command: z.string().min(1).max(4096) });
/**
 * Macros de console : une séquence de commandes enregistrée, exécutée dans l'ordre.
 *
 * Bornes délibérément basses. Une macro n'est pas un langage : pas de boucle, pas de condition,
 * pas d'attente. Ce qui demande un délai (« prévenir puis arrêter dans 5 minutes ») relève du
 * planificateur, qui sait déjà le faire et le montre dans l'interface.
 */
export const MACRO_MAX_COMMANDS = 20;
export const macroInputSchema = z.object({
  name: z.string().min(1).max(60),
  /** Une commande par ligne ; les lignes vides sont ignorées. */
  commands: z.string().min(1).max(4096),
  /** `null` = disponible sur tous les serveurs (le cas normal). */
  serverId: z.string().nullable().optional(),
});
export const macroDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  commands: z.array(z.string()),
  serverId: z.string().nullable(),
  createdBy: z.string().nullable(),
  updatedAt: epochMsSchema,
  /**
   * La macro contient au moins une commande qui arrête le serveur, bannit, ou détruit.
   * L'interface demande confirmation avant de la lancer : une macro est à un clic, et
   * « arrêter le serveur » ne doit jamais être un clic distrait.
   */
  destructive: z.boolean(),
});
/**
 * Lancement d'une macro. `confirmDestructive` est exigé par le panel pour toute macro qui arrête,
 * bannit ou détruit : la confirmation ne peut pas reposer sur le `destructive` d'un DTO en cache,
 * qui peut dater d'avant la modification de la macro depuis un autre serveur ou un autre onglet.
 * `approvedAt` lie la confirmation à la VERSION approuvée (le `updatedAt` que le modal a montré) :
 * un booléen seul validerait une séquence modifiée entre l'ouverture du modal et le clic.
 */
export const macroRunSchema = z.object({
  confirmDestructive: z.boolean().optional(),
  approvedAt: epochMsSchema.optional(),
});

export const macroRunResultSchema = z.object({
  /** Commandes réellement envoyées, dans l'ordre, avec leur issue. */
  results: z.array(
    z.object({
      command: z.string(),
      ok: z.boolean(),
      via: z.enum(['stdin', 'rcon']).optional(),
      error: z.string().optional(),
      /** Message technique de la cause, quand il y en a un (journal, diagnostic). */
      message: z.string().optional(),
    }),
  ),
  /** Longueur RÉELLE de la séquence exécutée — la liste du client peut être en retard. */
  total: z.int().optional(),
});

export type MacroInput = z.infer<typeof macroInputSchema>;
export type MacroDto = z.infer<typeof macroDtoSchema>;
export type MacroRunResult = z.infer<typeof macroRunResultSchema>;

export const commandHistoryItemSchema = z.object({
  id: z.int(),
  userId: z.string().nullable(),
  command: z.string(),
  via: z.enum(['stdin', 'rcon']),
  ts: epochMsSchema,
});

/** Conflit de marqueur (doc 04 §3) : un ID connu réapparaît ailleurs (copie ? migration ?). */
export const serverConflictDtoSchema = z.object({
  key: z.string(),
  serverId: z.string(),
  /** Emplacement connu du panel. */
  known: z.object({ machineId: z.string(), path: z.string() }),
  /** Emplacement où le marqueur a réapparu. */
  found: z.object({ machineId: z.string(), path: z.string() }),
  detectedAt: epochMsSchema,
  detection: detectedServerSchema,
});
export type ServerConflictDto = z.infer<typeof serverConflictDtoSchema>;
export const resolveConflictSchema = z.object({
  key: z.string(),
  /** `copy` = nouveau serveur (nouvel ID réécrit dans le marqueur) ; `migrate` = l'ID suit le dossier ; `ignore` = oublié jusqu'au prochain scan. */
  resolution: z.enum(['copy', 'migrate', 'ignore']),
});

export const playerOnlineDtoSchema = z.object({
  name: z.string(),
  uuid: z.string().nullable(),
  joinedAt: epochMsSchema.nullable(),
});

// --- Joueurs, configuration, fichiers, logs (phase 6) ------------------------------------------------

/** Historique `player_sessions` (doc 04 §4) ; `leftAt` null = en ligne. */
export const playerSessionDtoSchema = z.object({
  id: z.int(),
  playerUuid: z.string().nullable(),
  playerName: z.string(),
  joinedAt: epochMsSchema,
  leftAt: epochMsSchema.nullable(),
});
export type PlayerSessionDto = z.infer<typeof playerSessionDtoSchema>;

export const playerActionRequestSchema = playerActionSchema.omit({ serverId: true });
export type PlayerActionRequest = z.infer<typeof playerActionRequestSchema>;
export const playerActionResultSchema = playerActionResponseSchema;
export const playerResolveRequestSchema = playerResolveSchema.omit({ serverId: true });
export const playerResolveResultSchema = playerResolveResponseSchema;
export type ResolvedPlayerDto = z.infer<typeof resolvedPlayerSchema>;

export const configFileParamsSchema = z.object({ id: z.string().min(1), file: configFileSchema });
/** `config.get` relayé : `data` typé côté front par fichier (`CONFIG_DATA_SCHEMAS`). */
export const configGetResultSchema = z.object({
  file: configFileSchema,
  data: z.unknown(),
  sha256: z.string().length(64).optional(),
  source: z.enum(['file', 'live']),
});
export const configSetRequestSchema = z.object({
  data: z.unknown(),
  expectedSha256: z.string().length(64).optional(),
});
export const configSetResultSchema = configSetResponseSchema;
export type ConfigSetResult = z.infer<typeof configSetResultSchema>;

export const fsPathQuerySchema = z.object({ path: relativePathSchema.default('') });
export const fsPathBodySchema = fsPathSchema.omit({ serverId: true });
export const fsMoveBodySchema = fsMoveSchema.omit({ serverId: true });
export const fsWriteBodySchema = fsWriteSchema.omit({ serverId: true });
export const fsListResultSchema = z.object({ path: z.string(), entries: z.array(fsEntrySchema) });
export type FsEntryDto = z.infer<typeof fsEntrySchema>;
export const fsReadResultSchema = fsReadResponseSchema;
export type FsReadResult = z.infer<typeof fsReadResultSchema>;

export const logsSearchRequestSchema = logsSearchSchema.omit({ serverId: true });
export type LogsSearchRequest = z.infer<typeof logsSearchRequestSchema>;

// --- Métriques (phase 7) --------------------------------------------------------------------------

export const metricsResolutionSchema = z.enum(['raw', '1m', '1h']);
export type MetricsResolution = z.infer<typeof metricsResolutionSchema>;

/** `from`/`to` en epoch ms ; `resolution` absente ⇒ choisie selon la plage (brut ≤ 3 h, 1 min ≤ 3 j, sinon 1 h). */
export const metricsQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().nonnegative().optional(),
  resolution: metricsResolutionSchema.optional(),
});
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;

/** Point serveur normalisé : en brut `cpu`/`ram`/`tps` sont la valeur instantanée ; agrégé = moyenne + extrema. */
export const serverMetricsPointSchema = z.object({
  ts: epochMsSchema,
  cpu: z.number().nullable(),
  cpuMax: z.number().nullable().optional(),
  ram: z.number().nullable(),
  ramMax: z.number().nullable().optional(),
  tps: z.number().nullable(),
  tpsMin: z.number().nullable().optional(),
  mspt: z.number().nullable().optional(),
  players: z.int().nullable(),
  samples: z.int().optional(),
});
export type ServerMetricsPoint = z.infer<typeof serverMetricsPointSchema>;

export const machineMetricsPointSchema = z.object({
  ts: epochMsSchema,
  cpu: z.number().nullable(),
  cpuMax: z.number().nullable().optional(),
  ram: z.number().nullable(),
  ramMax: z.number().nullable().optional(),
  diskUsedGb: z.number().nullable(),
  diskTotalGb: z.number().nullable(),
  samples: z.int().optional(),
});
export type MachineMetricsPoint = z.infer<typeof machineMetricsPointSchema>;

export const serverMetricsResultSchema = z.object({
  resolution: metricsResolutionSchema,
  from: epochMsSchema,
  to: epochMsSchema,
  points: z.array(serverMetricsPointSchema),
  /** Dernier échantillon brut connu (même hors plage), pour l'affichage « maintenant ». */
  latest: serverMetricsPointSchema.nullable(),
  tpsSource: tpsSourceSchema.nullable(),
  cpuSource: z.enum(['cycles', 'proc', 'ticks']).nullable(),
});
export type ServerMetricsResult = z.infer<typeof serverMetricsResultSchema>;

export const machineMetricsResultSchema = z.object({
  resolution: metricsResolutionSchema,
  from: epochMsSchema,
  to: epochMsSchema,
  points: z.array(machineMetricsPointSchema),
  latest: machineMetricsPointSchema.nullable(),
  cpuSource: z.enum(['cycles', 'proc', 'ticks']).nullable(),
});
export type MachineMetricsResult = z.infer<typeof machineMetricsResultSchema>;

/** Échantillon temps réel diffusé aux navigateurs (même forme que `metrics.sample` agent). */
export const metricsSampleDtoSchema = metricsSampleSchema;
export type MetricsSampleDto = z.infer<typeof metricsSampleDtoSchema>;

// --- Tasks, backups, planificateur (phase 8) ---------------------------------------------------------

export const taskDtoStatusSchema = z.enum([
  'pending',
  'running',
  'stalled',
  'done',
  'failed',
  'cancelled',
]);
export type TaskDtoStatus = z.infer<typeof taskDtoStatusSchema>;

export const taskDtoSchema = z.object({
  id: z.string(),
  kind: z.string(),
  machineId: z.string().nullable(),
  serverId: z.string().nullable(),
  status: taskDtoStatusSchema,
  /** 0–100. */
  progress: z.number().nullable(),
  phase: z.string().nullable(),
  detail: z.string().nullable(),
  /** ex. `backups.id`. */
  refId: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: apiErrorSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: epochMsSchema,
  finishedAt: epochMsSchema.nullable(),
});
export type TaskDto = z.infer<typeof taskDtoSchema>;

export const tasksQuerySchema = z.object({
  status: taskDtoStatusSchema.optional(),
  /** `active` = pending + running + stalled. */
  active: z.coerce.boolean().optional(),
  serverId: z.string().optional(),
  machineId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const backupStatusSchema = z.enum(['running', 'success', 'failed', 'deleted']);
export const backupDtoSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  policyId: z.string().nullable(),
  kind: backupKindSchema,
  status: backupStatusSchema,
  machineId: z.string(),
  archivePath: z.string().nullable(),
  sizeBytes: z.int().nullable(),
  sha256: z.string().nullable(),
  startedAt: epochMsSchema,
  finishedAt: epochMsSchema.nullable(),
  error: z.string().nullable(),
  createdBy: z.string().nullable(),
  /** Détails du manifeste (si connu). */
  codec: backupCodecSchema.nullable(),
  hot: z.boolean().nullable(),
  files: z.int().nullable(),
  bytesRaw: z.int().nullable(),
  comment: z.string().nullable(),
  /** Task associée (création ou restauration en cours). */
  taskId: z.string().nullable(),
});
export type BackupDto = z.infer<typeof backupDtoSchema>;

export const createBackupSchema = z.object({ comment: z.string().max(500).optional() });
export const restoreBackupSchema = z.object({
  safetyBackup: z.boolean().default(true),
  restartAfter: z.boolean().default(false),
});

export const backupPolicyDtoSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  cron: z.string(),
  destination: z.string().nullable(),
  keepLast: z.int().nullable(),
  keepDays: z.int().nullable(),
  onlyIfRunning: z.boolean(),
  enabled: z.boolean(),
  createdAt: epochMsSchema,
  /** Calculé par le panel (heure locale du panel — l'agent évalue en heure locale de sa machine). */
  nextRunAt: epochMsSchema.nullable(),
  // Preuve d'exécution : sans ces champs, une politique morte s'affichait comme une politique
  // saine. `null` = jamais tourné depuis l'ajout des colonnes, c'est un état à part entière.
  lastRunAt: epochMsSchema.nullable(),
  lastStatus: z.enum(['success', 'failed', 'skipped']).nullable(),
  lastError: z.string().nullable(),
  /** Depuis quand l'occurrence attendue n'est pas arrivée ; `null` = à l'heure. */
  overdueSince: epochMsSchema.nullable(),
});
export type BackupPolicyDto = z.infer<typeof backupPolicyDtoSchema>;

export const backupPolicyInputSchema = z.object({
  cron: z.string().min(9).max(100),
  destination: z.string().max(1024).nullable().optional(),
  keepLast: z.int().positive().max(1000).nullable().optional(),
  keepDays: z.int().positive().max(3650).nullable().optional(),
  onlyIfRunning: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type BackupPolicyInput = z.infer<typeof backupPolicyInputSchema>;

/**
 * Action groupée. **Exécution séquentielle imposée par le produit** : le garde-fou mémoire de
 * l'agent refuse un démarrage quand `maxRamMb` dépasse `total - réserve - somme des maxRamMb des
 * serveurs déjà lancés`. Dix démarrages en parallèle passent tous la garde avant que le premier
 * n'ait été compté, ou s'effondrent en cascade de refus selon le minutage. Enchaîner suffit :
 * `server.start` répond après le spawn, et un serveur en `starting` est déjà compté.
 */
export const bulkActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
  serverIds: z.array(z.string().min(1)).min(1).max(50),
  /** Par défaut on s'arrête au premier refus : enchaîner sur une machine saturée est inutile. */
  continueOnError: z.boolean().optional(),
});
export type BulkAction = z.infer<typeof bulkActionSchema>;

export const bulkActionResultSchema = z.object({
  results: z.array(
    z.object({
      serverId: z.string(),
      name: z.string(),
      status: z.enum(['done', 'failed', 'skipped']),
      /** Erreur telle que l'agent l'a produite : l'UI la traduit, le panel ne la réécrit pas. */
      error: z
        .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
        .optional(),
    }),
  ),
});
export type BulkActionResult = z.infer<typeof bulkActionResultSchema>;

export const scheduledActionSchema = z.enum(['start', 'stop', 'restart', 'command', 'announce']);
export type ScheduledAction = z.infer<typeof scheduledActionSchema>;

/** Charge utile d'une action programmée (exécutée par le panel). */
export const schedulePayloadSchema = z.object({
  /** `command` : commande console ; `announce` : ignoré. */
  command: z.string().max(4096).optional(),
  /** Message d'annonce (`{minutes}` remplacé) pour `stop`/`restart` (avertissements) et `announce`. */
  message: z.string().max(500).optional(),
  /** Minutes avant l'action où un avertissement `say` est envoyé (`stop`/`restart`). */
  warnMinutes: z.array(z.int().positive().max(1440)).max(10).optional(),
  /** Délai d'arrêt gracieux (`stop`/`restart`). */
  timeoutSec: z.int().positive().max(3600).optional(),
});
export type SchedulePayload = z.infer<typeof schedulePayloadSchema>;

export const scheduledTaskDtoSchema = z.object({
  id: z.string(),
  serverId: z.string().nullable(),
  action: scheduledActionSchema,
  /** Récurrence : 1 à 10 expressions à 5 champs, une par ligne. `null` si exécution unique. */
  cron: z.string().nullable(),
  /** Exécution unique à cet instant (epoch ms, heure du panel). `null` si récurrente. */
  runAt: epochMsSchema.nullable(),
  payload: schedulePayloadSchema.nullable(),
  enabled: z.boolean(),
  lastRunAt: epochMsSchema.nullable(),
  lastStatus: z.string().nullable(),
  nextRunAt: epochMsSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: epochMsSchema,
});
export type ScheduledTaskDto = z.infer<typeof scheduledTaskDtoSchema>;

export const scheduledTaskInputSchema = z.object({
  action: scheduledActionSchema,
  /** Récurrence (exclusif avec `runAt`) : 1 à 10 expressions à 5 champs, une par ligne. */
  cron: z.string().min(9).max(400).optional(),
  /** Exécution unique à cet instant (exclusif avec `cron`) ; la fournir réarme la tâche. */
  runAt: epochMsSchema.optional(),
  payload: schedulePayloadSchema.nullable().optional(),
  enabled: z.boolean().optional(),
});
export type ScheduledTaskInput = z.infer<typeof scheduledTaskInputSchema>;

/** Sauvegarde du panel lui-même (`VACUUM INTO`). */
export const panelBackupDtoSchema = z.object({
  file: z.string(),
  sizeBytes: z.int().nonnegative(),
  createdAt: epochMsSchema,
});
export type PanelBackupDto = z.infer<typeof panelBackupDtoSchema>;

/** spark (TPS) : état et installation en un clic (jamais requis). */
export const sparkStatusSchema = z.object({
  /** Le loader accepte un mod spark (forge/neoforge/fabric). */
  supported: z.boolean(),
  installed: z.boolean(),
  file: z.string().nullable(),
  /** Plateforme spark correspondante (`forge`, `neoforge`, `fabric`). */
  platform: z.string().nullable(),
});
export type SparkStatus = z.infer<typeof sparkStatusSchema>;

// --- Phase 9 : migrations, Java géré, releases d'agent ----------------------------------------------

export const migrationStatusSchema = z.enum([
  'pending',
  'backing_up',
  'transferring',
  'restoring',
  'verifying',
  'done',
  'failed',
  'rolled_back',
]);
export type MigrationStatus = z.infer<typeof migrationStatusSchema>;

export const migrationDtoSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  fromMachineId: z.string(),
  toMachineId: z.string(),
  toDirectoryId: z.string().nullable(),
  sourcePath: z.string().nullable(),
  toPath: z.string().nullable(),
  backupId: z.string().nullable(),
  status: migrationStatusSchema,
  progressPct: z.number().nullable(),
  /** `direct` | `relay` une fois le transfert engagé. */
  mode: z.string().nullable(),
  exportTaskId: z.string().nullable(),
  importTaskId: z.string().nullable(),
  restartAfter: z.boolean(),
  startedAt: epochMsSchema,
  finishedAt: epochMsSchema.nullable(),
  error: apiErrorSchema.nullable(),
  createdBy: z.string().nullable(),
  /** `migrate` = déménagement (même serveur) ; `duplicate` = copie sous un nouvel ID. */
  kind: z.enum(['migrate', 'duplicate']).default('migrate'),
  /** Duplication : ID du serveur créé sur la cible. */
  targetServerId: z.string().nullable().default(null),
});
export type MigrationDto = z.infer<typeof migrationDtoSchema>;

export const startMigrationSchema = z.object({
  toMachineId: z.string().min(1),
  /** Répertoire surveillé cible (le dossier sera `<dir>/<nom>`) ou chemin absolu explicite. */
  toDirectoryId: z.string().min(1).optional(),
  toPath: z.string().min(1).optional(),
  /** Relancer sur la cible si le serveur tournait (défaut : oui). */
  restartAfter: z.boolean().default(true),
  /** Installer le JRE manquant sur la cible avant import (task `java.install`). */
  installJava: z.boolean().default(false),
  announce: z.string().max(200).optional(),
});
export type StartMigrationInput = z.infer<typeof startMigrationSchema>;

export const migrationPrecheckRequestSchema = startMigrationSchema.pick({
  toMachineId: true,
  toDirectoryId: true,
  toPath: true,
});
export const migrationPrecheckDtoSchema = migrationPrecheckResponseSchema.extend({
  toPath: z.string(),
});
export type MigrationPrecheckDto = z.infer<typeof migrationPrecheckDtoSchema>;

/**
 * Duplication d'un serveur : même chaîne que la migration (export → transfert → import) mais vers
 * un NOUVEL identifiant — la source reste en place (jamais de `migration.finalize`) et redémarre
 * si elle tournait. La cible peut être la machine du serveur source.
 */
export const duplicateServerSchema = z.object({
  toMachineId: z.string().min(1),
  /** Répertoire surveillé cible (le dossier sera `<dir>/<nom>`) ou chemin absolu explicite. */
  toDirectoryId: z.string().min(1).optional(),
  toPath: z.string().min(1).optional(),
  /** Nom du nouveau serveur — sert aussi de nom de dossier par défaut. */
  name: z.string().trim().min(1).max(120),
  /** Port de jeu du clone ; choisi parmi les ports libres de la cible si absent. */
  gamePort: z.int().min(1).max(65535).optional(),
  /** Installer le JRE manquant sur la cible avant import (task `java.install`). */
  installJava: z.boolean().default(false),
  /** Message envoyé aux joueurs de la source avant son arrêt. */
  announce: z.string().max(200).optional(),
});
export type DuplicateServerInput = z.infer<typeof duplicateServerSchema>;

export const duplicatePrecheckRequestSchema = duplicateServerSchema.pick({
  toMachineId: true,
  toDirectoryId: true,
  toPath: true,
  name: true,
  gamePort: true,
});
export const duplicatePrecheckDtoSchema = migrationPrecheckResponseSchema.extend({
  toPath: z.string(),
  /** Port de jeu retenu pour le clone (celui que le pré-check a vérifié). */
  gamePort: z.int().min(1).max(65535),
});
export type DuplicatePrecheckDto = z.infer<typeof duplicatePrecheckDtoSchema>;

export const javaRuntimeDtoSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  majorVersion: z.int(),
  fullVersion: z.string().nullable(),
  vendor: z.string().nullable(),
  path: z.string(),
  managed: z.boolean(),
  installedAt: epochMsSchema,
  /** Serveurs de la machine qui requièrent cette version majeure. */
  usedBy: z.int().nonnegative().optional(),
});
export type JavaRuntimeDto = z.infer<typeof javaRuntimeDtoSchema>;

export const installJavaSchema = z.object({
  majorVersion: z.int().positive().max(99),
  /** Forcer le relais panel (machine sans Internet sortant). */
  relay: z.boolean().default(false),
  /** Fournisseur imposé (sinon chaîne complète Temurin → Zulu → x64 émulé). */
  vendor: javaVendorSchema.optional(),
});
export type InstallJavaInput = z.infer<typeof installJavaSchema>;

export const agentReleaseDtoSchema = z.object({
  version: z.string(),
  protocolVersion: z.int(),
  channel: z.string(),
  releasedAt: epochMsSchema,
  sha256: z.string(),
  size: z.int().nonnegative(),
  runtimeVersion: z.string().nullable(),
  notes: z.string().nullable(),
  /** Signature Ed25519 (base64) — vérifiable par la clé publique embarquée dans l'agent. */
  signature: z.string(),
});
export type AgentReleaseDto = z.infer<typeof agentReleaseDtoSchema>;

export const publishReleaseQuerySchema = z.object({
  version: z.string().min(1).max(64),
  signature: z.string().min(1),
  protocolVersion: z.coerce.number().int().positive().optional(),
  channel: z.string().min(1).max(32).optional(),
  runtimeVersion: z.string().max(32).optional(),
  notes: z.string().max(2000).optional(),
});

export const updateAgentSchema = z.object({
  /** Version à pousser (défaut : dernière release du canal stable). */
  version: z.string().min(1).optional(),
});

export const uploadQuerySchema = z.object({
  path: relativePathSchema,
  size: z.coerce.number().int().nonnegative(),
  overwrite: z.coerce.boolean().optional(),
});

// --- Événements et audit ---------------------------------------------------------------------------

export const severitySchema = z.enum(['debug', 'info', 'warning', 'error', 'critical']);
export const eventDtoSchema = z.object({
  id: z.int(),
  ts: epochMsSchema,
  type: z.string(),
  severity: severitySchema,
  machineId: z.string().nullable(),
  serverId: z.string().nullable(),
  userId: z.string().nullable(),
  payload: z.unknown(),
});
export type EventDto = z.infer<typeof eventDtoSchema>;

export const auditDtoSchema = z.object({
  id: z.int(),
  ts: epochMsSchema,
  userId: z.string().nullable(),
  username: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  targetLabel: z.string().nullable(),
  details: z.unknown(),
  ip: z.string().nullable(),
});
export type AuditDto = z.infer<typeof auditDtoSchema>;

export const eventsQuerySchema = z.object({
  sinceId: z.coerce.number().int().nonnegative().optional(),
  serverId: z.string().optional(),
  machineId: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

// --- Parcours UI (maintenance) ---------------------------------------------------------------------

/** Interaction d'interface capturée côté client (clic, navigation), envoyée par lots. */
export const uiEventInputSchema = z.object({
  ts: epochMsSchema,
  kind: z.enum(['click', 'nav']),
  /** Chemin de la page (`location.pathname`), jamais de query string (données sensibles). */
  page: z.string().max(200),
  /** Identifiant de l'élément cliqué : `data-testid`, `aria-label` ou texte du bouton. */
  target: z.string().max(200).optional(),
});
export type UiEventInput = z.infer<typeof uiEventInputSchema>;

export const uiEventsPostSchema = z.object({
  events: z.array(uiEventInputSchema).min(1).max(100),
});

export const uiEventDtoSchema = uiEventInputSchema.extend({
  id: z.int(),
  userId: z.string().nullable(),
  username: z.string().nullable(),
});
export type UiEventDto = z.infer<typeof uiEventDtoSchema>;

export const uiEventsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

// --- Réglages --------------------------------------------------------------------------------------

/** Clés modifiables par l'API (`app_settings`) ; les clés secrètes (VAPID privé…) ne sortent jamais. */
export const EDITABLE_SETTINGS = [
  'panel.publicUrl',
  'access.mode',
  'backups.defaultDestination',
  /** Rétentions en jours (entiers 1–3650, validés par le panel) appliquées par la maintenance horaire. */
  'retention.eventsDays',
  'retention.auditDays',
  'retention.uiEventsDays',
  'retention.commandHistoryDays',
  'retention.playerSessionsDays',
  'retention.migrationsDays',
  'retention.deletedBackupsDays',
  'retention.tasksDays',
  /** Vie privée ('true'/'false') : résolution des pseudos chez Mojang, avatars mc-heads.net. */
  'privacy.mojangLookup',
  'privacy.externalAvatars',
  'agents.restoreOnBoot',
  'metrics.intervalSec',
  /** Fuseau dans lequel toutes les planifications sont lues (nom IANA, ex. `Europe/Paris`). */
  'schedule.timezone',
  /** Phase 9 : mise à jour automatique des agents à la connexion ('1'/'0'). */
  'agents.autoUpdate',
  /** Lot 2 : vérification des nouvelles versions du panel sur GitHub ('true'/'false'). */
  'panel.updateCheck.enabled',
  /** Phase 10 : couche d'accès (doc 03 §5). Les secrets (`access.dns.token`) ne ressortent jamais. */
  'access.domain',
  'access.httpsPort',
  'access.dns.provider',
  'access.dns.token',
  'access.dns.zone',
  'access.dns.updateUrl',
  'access.acme.email',
  'access.acme.directory',
  'access.dyndns.enabled',
  'access.publicHost',
  /** Lot 2 : voie directe activée EN PLUS du mode courant (une voie d'accès par machine). */
  'access.direct.enabled',
] as const;
export const settingsPatchSchema = z.partialRecord(z.enum(EDITABLE_SETTINGS), z.string());

// --- Phase 10 : notifications (push + centre in-app) -------------------------------------------------

/**
 * Catégories de notification, activables une par une (`notification_prefs`).
 *
 * Élargies le 2026-08-31 sur retour d'usage : la moitié des événements du bus n'avait aucune case
 * — un problème remonté par une machine, un serveur découvert, une machine appairée ne pouvaient
 * NI être notifiés NI être réglés. Et `resources` mélangeait disque et TPS, deux urgences très
 * différentes. Toute catégorie ajoutée ici doit être câblée dans `notificationTypeOf` ET traduite
 * (`web:notifications.types.<clé avec _>`) : le test de parité i18n échoue sinon.
 */
export const NOTIFICATION_TYPES = [
  'server.crashed',
  'server.startFailed',
  'watchdog.alert',
  'agent.offline',
  'task.failed',
  'backup.failed',
  'migration',
  'agent.update',
  'schedule.failed',
  'port.conflict',
  'server.state',
  'player.activity',
  /** Disque presque plein et TPS effondré : séparés, on ne réagit pas de la même façon. */
  'resource.disk',
  'resource.tps',
  /** WARN/ERROR remontés par un agent (EULA non acceptée, dossier non inscriptible, timeout). */
  'agent.problem',
  'machine.paired',
  'server.discovered',
  'server.lifecycle',
  'task.done',
  'schedule.done',
  'player.action',
  /** Lot 2 : une nouvelle version du panel est publiée sur GitHub. */
  'panel.update',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/**
 * Défauts. Règle : ce qui demande une intervention est activé, ce qui raconte la vie courante ne
 * l'est pas — un téléphone qui sonne pour tout finit par être ignoré quand ça compte.
 */
export const NOTIFICATION_DEFAULTS: Readonly<Record<NotificationType, boolean>> = {
  'server.crashed': true,
  'server.startFailed': true,
  'watchdog.alert': true,
  'agent.offline': true,
  'task.failed': true,
  'backup.failed': true,
  migration: true,
  'agent.update': true,
  'schedule.failed': true,
  'port.conflict': true,
  'server.state': false,
  'player.activity': false,
  'resource.disk': true,
  'resource.tps': true,
  'agent.problem': true,
  'machine.paired': true,
  'server.discovered': false,
  'server.lifecycle': false,
  'task.done': false,
  'schedule.done': false,
  'player.action': false,
  // Une release par-ci par-là, jamais la nuit : la cloche suffit, le téléphone n'a pas à sonner.
  'panel.update': true,
};

/**
 * Regroupement pour l'affichage : vingt interrupteurs en liste plate ne se lisent pas. L'ordre
 * des groupes et des catégories est celui de l'écran.
 */
export const NOTIFICATION_GROUPS = [
  {
    id: 'servers',
    types: [
      'server.crashed',
      'server.startFailed',
      'watchdog.alert',
      'port.conflict',
      'server.state',
      'server.discovered',
      'server.lifecycle',
    ],
  },
  {
    id: 'machines',
    types: ['agent.offline', 'agent.problem', 'machine.paired', 'agent.update', 'migration'],
  },
  { id: 'resources', types: ['resource.disk', 'resource.tps'] },
  {
    id: 'tasks',
    types: ['backup.failed', 'task.failed', 'task.done', 'schedule.failed', 'schedule.done'],
  },
  { id: 'players', types: ['player.activity', 'player.action'] },
  { id: 'panel', types: ['panel.update'] },
] as const satisfies readonly { id: string; types: readonly NotificationType[] }[];

/** Catégorie de notification d'un événement du bus (`undefined` = jamais notifié). */
export function notificationTypeOf(event: {
  type: string;
  severity: string;
  payload?: unknown;
}): NotificationType | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'server.stateChanged':
      return payload.state === 'crashed' || payload.runState === 'crashed'
        ? 'server.crashed'
        : payload.state === 'running' || payload.state === 'stopped'
          ? 'server.state'
          : undefined;
    case 'server.startFailed':
      return 'server.startFailed';
    case 'watchdog.alert':
      return 'watchdog.alert';
    // `agent.offline` n'est plus notifié directement : il partait dès la coupure du WebSocket,
    // donc un simple redémarrage de PC réveillait le téléphone, et son retour n'était jamais
    // annoncé. C'est la règle d'alerte `machine.offline` qui le remplace, avec un délai et une
    // notification de retour à la normale. L'événement reste publié pour l'historique.
    case 'alert.firing':
    case 'alert.resolved': {
      const rule = (event.payload as { rule?: unknown } | undefined)?.rule;
      if (rule === 'machine.offline') return 'agent.offline';
      if (rule === 'server.down') return 'server.crashed';
      if (rule === 'disk.low') return 'resource.disk';
      if (rule === 'tps.low') return 'resource.tps';
      return undefined;
    }
    case 'task.failed':
      return typeof payload.kind === 'string' && payload.kind.startsWith('backup.')
        ? 'backup.failed'
        : 'task.failed';
    // Une politique qui ne tourne plus relève de la même préoccupation qu'une sauvegarde ratée :
    // on réutilise la catégorie plutôt que d'ajouter une case à cocher de plus.
    case 'backup.overdue':
      return 'backup.failed';
    case 'task.completed':
      return 'task.done';
    case 'migration.done':
    case 'migration.failed':
      return 'migration';
    case 'agent.updateApplied':
    case 'agent.updateRolledBack':
      return 'agent.update';
    case 'panel.updateAvailable':
      return 'panel.update';
    case 'schedule.run':
      return event.severity === 'info' ? 'schedule.done' : 'schedule.failed';
    case 'port.conflict':
      return 'port.conflict';
    case 'player.joined':
    case 'player.left':
      return 'player.activity';
    case 'player.action':
      return 'player.action';
    // Un agent ne parle au bus que pour signaler une anomalie (EULA refusée, démarrage qui
    // n'aboutit pas, dossier non inscriptible) : c'est exactement ce qu'on veut savoir.
    case 'agent.log':
      return 'agent.problem';
    case 'machine.paired':
      return 'machine.paired';
    case 'server.adopted':
      return 'server.discovered';
    case 'server.removed':
    case 'server.deleted':
    case 'server.migrated':
    case 'server.conflict':
      return 'server.lifecycle';
    default:
      return undefined;
  }
}

/**
 * Canaux de notification RÉELS du produit : la cloche du panel et le push sur appareil. Ils se
 * règlent séparément — jusqu'ici couper une catégorie la retirait des deux, donc suivre les
 * arrivées de joueurs dans le panel imposait de se faire réveiller la nuit.
 */
export const NOTIFICATION_CHANNELS = ['inapp', 'push'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const notificationPrefsDtoSchema = z.record(notificationTypeSchema, z.boolean());
export type NotificationPrefsDto = z.infer<typeof notificationPrefsDtoSchema>;

/** Réglages effectifs, canal par canal (ce que l'écran affiche et ce que le panel applique). */
export const notificationChannelPrefsDtoSchema = z.record(
  notificationChannelSchema,
  notificationPrefsDtoSchema,
);
export type NotificationChannelPrefsDto = z.infer<typeof notificationChannelPrefsDtoSchema>;

/**
 * `channel` absent = les deux canaux : c'est le sens de l'ancien réglage unique, et ce que fait
 * un bouton « tout couper ».
 */
export const notificationPrefsPutSchema = z.object({
  channel: notificationChannelSchema.optional(),
  values: z.partialRecord(notificationTypeSchema, z.boolean()),
});
export type NotificationPrefsPut = z.infer<typeof notificationPrefsPutSchema>;

export const notificationsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export const notificationsResultSchema = z.object({
  notifications: z.array(eventDtoSchema),
  unread: z.int().nonnegative(),
  seenId: z.int().nonnegative(),
});
export type NotificationsResult = z.infer<typeof notificationsResultSchema>;
export const notificationsSeenSchema = z.object({ id: z.int().nonnegative() });

export const pushSubscribeSchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
  userAgent: z.string().max(512).optional(),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;
export const pushUnsubscribeSchema = z.object({ endpoint: z.url().max(2048) });
export const pushSubscriptionDtoSchema = z.object({
  id: z.int(),
  /** Endpoint tronqué (hôte + début du chemin) : jamais l'URL complète côté UI. */
  endpoint: z.string(),
  userAgent: z.string().nullable(),
  createdAt: epochMsSchema,
  lastSeenAt: epochMsSchema.nullable(),
  lastSuccessAt: epochMsSchema.nullable(),
  failCount: z.int(),
});
export type PushSubscriptionDto = z.infer<typeof pushSubscriptionDtoSchema>;
export const pushStatusDtoSchema = z.object({
  /** Clé publique VAPID (base64url, point non compressé) — `null` tant que le setup n'a pas tourné. */
  vapidPublicKey: z.string().nullable(),
  subscriptions: z.array(pushSubscriptionDtoSchema),
});
export type PushStatusDto = z.infer<typeof pushStatusDtoSchema>;

/** Contenu chiffré d'un push (JSON) — interprété par le service worker. */
export const pushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string(),
  tag: z.string().optional(),
  eventId: z.int().optional(),
  ts: epochMsSchema,
  locale: localeSchema.optional(),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

// --- Phase 10 : couche d'accès ----------------------------------------------------------------------

export const accessModeSchema = z.enum(['tailscale', 'direct', 'manual']);
export type AccessMode = z.infer<typeof accessModeSchema>;
/** Fournisseurs DNS du mode direct (DNS-01 + DynDNS) : `generic` = URL de mise à jour seule (pas de DNS-01). */
export const dnsProviderSchema = z.enum(['manual', 'duckdns', 'cloudflare', 'generic']);
export type DnsProvider = z.infer<typeof dnsProviderSchema>;

export const certificateDtoSchema = z.object({
  subject: z.string(),
  issuer: z.string(),
  validFrom: epochMsSchema,
  validTo: epochMsSchema,
  /** Noms couverts (SAN). */
  names: z.array(z.string()),
  daysLeft: z.number(),
});
export type CertificateDto = z.infer<typeof certificateDtoSchema>;

export const accessStatusDtoSchema = z.object({
  mode: accessModeSchema,
  publicUrl: z.string().nullable(),
  /** Adresse d'écoute réelle du panel (HTTP) et port HTTPS du mode direct. */
  listen: z.object({ host: z.string(), port: z.int() }),
  https: z.object({ listening: z.boolean(), port: z.int().nullable() }),
  /** Mode tailscale : commande `tailscale serve` à exécuter une fois. */
  tailscaleServeCommand: z.string().nullable(),
  /** Lot 2 : la voie directe répond (mode direct, OU seconde voie activée en plus du tailnet). */
  directEnabled: z.boolean().optional(),
  /** URL publique de la voie directe (dérivée du domaine + port HTTPS), si configurée. */
  directUrl: z.string().nullable().optional(),
  /** Voie directe (mode direct ou seconde voie). */
  direct: z
    .object({
      domain: z.string().nullable(),
      dnsProvider: dnsProviderSchema,
      dnsTokenSet: z.boolean(),
      acmeEmail: z.string().nullable(),
      acmeDirectory: z.string(),
      certificate: certificateDtoSchema.nullable(),
      certificateError: z.string().nullable(),
      dyndns: z.object({
        enabled: z.boolean(),
        currentAddress: z.string().nullable(),
        publishedAddress: z.string().nullable(),
        lastUpdateAt: epochMsSchema.nullable(),
        lastError: z.string().nullable(),
      }),
      /** Jeton TXT en attente pour un DNS-01 manuel (`_acme-challenge.<domaine>`). */
      pendingChallenge: z.object({ name: z.string(), value: z.string() }).nullable(),
    })
    .nullable(),
  /** Le dernier test de joignabilité (admin), s'il y en a eu un. */
  lastTest: z.object({ at: epochMsSchema, ok: z.boolean(), via: z.string().nullable() }).nullable(),
  /** Cette requête est arrivée derrière un reverse-proxy (X-Forwarded-*) / tailscale serve. */
  requestVia: z.enum(['tailscale', 'proxy', 'direct']),
});
export type AccessStatusDto = z.infer<typeof accessStatusDtoSchema>;

export const accessTestRequestSchema = z.object({
  /** URL à tester (défaut : `panel.publicUrl`). */
  url: z.url().optional(),
});
export const accessTestResultSchema = z.object({
  url: z.string(),
  http: z.object({
    ok: z.boolean(),
    status: z.int().nullable(),
    ms: z.int(),
    error: z.string().nullable(),
  }),
  ws: z.object({ ok: z.boolean(), ms: z.int(), error: z.string().nullable() }),
  /** Frame binaire (64 KiB aléatoires) renvoyée intacte par `/ws/probe`. */
  binary: z.object({ ok: z.boolean(), bytes: z.int(), error: z.string().nullable() }),
  tls: z.object({ ok: z.boolean(), issuer: z.string().nullable(), error: z.string().nullable() }),
  via: z.string().nullable(),
  ok: z.boolean(),
});
export type AccessTestResult = z.infer<typeof accessTestResultSchema>;

export const firewallRulesDtoSchema = z.object({
  /** Règles à poser sur l'hôte du panel (mode direct) et, par serveur exposé en direct, sur sa machine. */
  panel: z.object({ os: z.string(), port: z.int(), commands: z.array(z.string()) }).nullable(),
  servers: z.array(
    z.object({
      serverId: z.string(),
      name: z.string(),
      machineId: z.string(),
      machineName: z.string(),
      os: z.string().nullable(),
      port: z.int().nullable(),
      commands: z.array(z.string()),
    }),
  ),
  /** Rappel : ouvrir aussi les « pinholes » IPv6 de la box pour ces ports. */
  boxNote: z.boolean(),
});
export type FirewallRulesDto = z.infer<typeof firewallRulesDtoSchema>;

/** Adresse(s) à donner aux amis pour un serveur, selon son `exposeMode`. */
export const serverAddressDtoSchema = z.object({
  exposeMode: z.enum(['tailnet', 'direct']),
  /** Adresse retenue (`host:port`, IPv6 entre crochets) — `null` si rien n'est connu. */
  address: z.string().nullable(),
  host: z.string().nullable(),
  port: z.int().nullable(),
  /** Origine de l'hôte : surcharge manuelle, domaine du panel, adresse détectée par l'agent. */
  source: z.enum(['machine', 'domain', 'detected', 'none']),
  alternatives: z.array(z.string()),
});
export type ServerAddressDto = z.infer<typeof serverAddressDtoSchema>;

export const reachabilityRequestSchema = z.object({
  /** Adresse à tester (défaut : celle calculée). */
  address: z.string().min(1).max(300).optional(),
});
export const reachabilityResultSchema = z.object({
  address: z.string(),
  ok: z.boolean(),
  ms: z.int(),
  error: z.string().nullable(),
  /** Réponse Server List Ping (si le serveur a répondu). */
  status: z
    .object({
      version: z.string().nullable(),
      protocol: z.int().nullable(),
      online: z.int().nullable(),
      max: z.int().nullable(),
      motd: z.string().nullable(),
    })
    .nullable(),
});
export type ReachabilityResult = z.infer<typeof reachabilityResultSchema>;

// --- WebSocket /ws/client ----------------------------------------------------------------------------

/** Messages front → panel. */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), channels: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('unsubscribe'), channels: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('ping'), ts: epochMsSchema.optional() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Messages panel → front. */
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), user: userDtoSchema, serverTime: epochMsSchema }),
  z.object({ type: z.literal('pong'), ts: epochMsSchema }),
  z.object({ type: z.literal('event'), event: eventDtoSchema }),
  /** Rattrapage à l'abonnement (ring buffer panel + agent). */
  z.object({
    type: z.literal('console.snapshot'),
    serverId: z.string(),
    lines: z.array(consoleLineSchema),
    truncated: z.boolean(),
    latestSeq: z.int().nonnegative(),
  }),
  z.object({
    type: z.literal('console.lines'),
    serverId: z.string(),
    lines: z.array(consoleLineSchema),
  }),
  z.object({
    type: z.literal('machine.heartbeat'),
    machineId: z.string(),
    heartbeat: machineHeartbeatDtoSchema,
  }),
  z.object({ type: z.literal('server.state'), server: serverDtoSchema }),
  /** Phase 7 : échantillon de métriques d'une machine (toutes les 15 s), pour les graphiques en direct. */
  z.object({
    type: z.literal('metrics.sample'),
    machineId: z.string(),
    sample: metricsSampleDtoSchema,
  }),
  /** Phase 8 : progression et issue des tasks, sauvegardes mises à jour. */
  z.object({ type: z.literal('task.update'), task: taskDtoSchema }),
  z.object({ type: z.literal('backup.update'), backup: backupDtoSchema }),
  /** Phase 9 : progression d'une migration. */
  z.object({ type: z.literal('migration.update'), migration: migrationDtoSchema }),
  z.object({ type: z.literal('error'), error: apiErrorSchema, channel: z.string().optional() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function consoleChannel(serverId: string): string {
  return `console:${serverId}`;
}
export function parseConsoleChannel(channel: string): string | undefined {
  return channel.startsWith('console:') ? channel.slice('console:'.length) : undefined;
}

// --- Phase 11 : distribution des archives d'installation (doc 03 §3) --------------------------

export const DIST_PLATFORMS = ['win-x64', 'linux-x64', 'linux-arm64', 'darwin-arm64'] as const;
export const distPlatformSchema = z.enum(DIST_PLATFORMS);
export type DistPlatform = z.infer<typeof distPlatformSchema>;

const distFileSchema = z.object({
  file: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.int().nonnegative(),
});

/** `manifest.json` produit par `tools/release/build.mjs` (entrée de `PUT /api/admin/dist/manifest`). */
export const distManifestSchema = z.object({
  version: z.string().min(1).max(64),
  protocolVersion: z.int().positive(),
  runtimeVersion: z.string().min(1).max(32),
  builtAt: epochMsSchema.optional(),
  /** `dev` (clé de développement) ou clé publique SPKI base64 du mainteneur. */
  signingKey: z.string().optional(),
  bundle: distFileSchema.extend({ signature: z.string().min(1) }),
  platforms: z.record(z.string(), distFileSchema),
});
export type DistManifest = z.infer<typeof distManifestSchema>;

export const distArtifactDtoSchema = distFileSchema.extend({ url: z.string() });
export type DistArtifactDto = z.infer<typeof distArtifactDtoSchema>;

/** `GET /api/dist` : état de la distribution servie par ce panel. */
export const distStatusDtoSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  protocolVersion: z.int().nullable(),
  runtimeVersion: z.string().nullable(),
  builtAt: epochMsSchema.nullable(),
  signingKey: z.string().nullable(),
  /** Le bundle du manifeste est-il publié comme release d'agent (`agent.update`) ? */
  releasePublished: z.boolean(),
  platforms: z.record(z.string(), distArtifactDtoSchema),
  /** One-liners génériques (sans code d'appairage) — présents si `panel.publicUrl` est réglée. */
  install: z.object({ windows: z.string(), unix: z.string() }).nullable(),
});
export type DistStatusDto = z.infer<typeof distStatusDtoSchema>;

/** `GET /api/dist/:platform` : lu par `install.sh` / `install.ps1` (JSON plat). */
export const distPlatformDtoSchema = distArtifactDtoSchema.extend({
  platform: z.string(),
  version: z.string(),
  runtimeVersion: z.string(),
});
export type DistPlatformDto = z.infer<typeof distPlatformDtoSchema>;
