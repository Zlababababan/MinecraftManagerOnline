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
import {
  detectedServerSchema,
  playerActionResponseSchema,
  playerActionSchema,
  playerResolveResponseSchema,
  playerResolveSchema,
  resolvedPlayerSchema,
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
  /** URL publique du panel (base du one-liner d'installation et de l'URL WS des agents). */
  publicUrl: z.url().optional(),
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
});
export const stopServerSchema = z.object({
  timeoutSec: z.int().positive().optional(),
  announce: z.string().optional(),
  forceAfterTimeout: z.boolean().optional(),
});
export const commandRequestSchema = z.object({ command: z.string().min(1).max(4096) });
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

export const eventsQuerySchema = z.object({
  sinceId: z.coerce.number().int().nonnegative().optional(),
  serverId: z.string().optional(),
  machineId: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

// --- Réglages --------------------------------------------------------------------------------------

/** Clés modifiables par l'API (`app_settings`) ; les clés secrètes (VAPID privé…) ne sortent jamais. */
export const EDITABLE_SETTINGS = [
  'panel.publicUrl',
  'access.mode',
  'backups.defaultDestination',
  'retention.eventsDays',
  'retention.auditDays',
  'agents.restoreOnBoot',
  'metrics.intervalSec',
] as const;
export const settingsPatchSchema = z.partialRecord(z.enum(EDITABLE_SETTINGS), z.string());

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
  z.object({ type: z.literal('error'), error: apiErrorSchema, channel: z.string().optional() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function consoleChannel(serverId: string): string {
  return `console:${serverId}`;
}
export function parseConsoleChannel(channel: string): string | undefined {
  return channel.startsWith('console:') ? channel.slice('console:'.length) : undefined;
}
