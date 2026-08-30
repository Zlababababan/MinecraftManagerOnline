/** Détection et contrôle des serveurs, joueurs (doc 05 §6, doc 06). */
import { z } from 'zod';

import {
  attachModeSchema,
  confidenceSchema,
  detectedFieldSchema,
  epochMsSchema,
  evidenceSchema,
  exitReasonSchema,
  loaderSchema,
  portSchema,
  provisioningSchema,
  runStateSchema,
  serverIdSchema,
  ulidSchema,
} from '../common.js';

// --- Détection ----------------------------------------------------------------------------------

/** Comment lancer le serveur (doc 06 §1, 4 templates) — déduit par la détection, éditable. */
export const launchPlanSchema = z.discriminatedUnion('kind', [
  /** `java <flags> -jar <jar> nogui` (Vanilla, Forge ≤ 1.16.5, Fabric). */
  z.object({ kind: z.literal('jar'), jar: z.string() }),
  /** `java <flags> @<argfileDir>/win_args.txt|unix_args.txt nogui` (Forge/NeoForge ≥ 1.17). */
  z.object({
    kind: z.literal('argfile'),
    argfileDir: z.string(),
    hasWinArgs: z.boolean(),
    hasUnixArgs: z.boolean(),
  }),
]);
export type LaunchPlan = z.infer<typeof launchPlanSchema>;

export const javaRequirementSchema = z.object({
  majorVersion: z.int().positive(),
  /** `true` = strictement cette version (Forge ≤ 1.16.5 : Java 8 uniquement). */
  strict: z.boolean(),
  source: z.enum(['override', 'manifest', 'table']),
});

export const detectedServerSchema = z.object({
  /** Chemin absolu du dossier sur la machine de l'agent. */
  path: z.string(),
  /** Nom proposé (nom du dossier). */
  name: z.string(),
  /** ID lu dans `.mmo-server.json` si présent (le panel reste l'autorité). */
  markerServerId: serverIdSchema.optional(),
  loader: detectedFieldSchema(loaderSchema),
  mcVersion: detectedFieldSchema(z.string()).optional(),
  loaderVersion: detectedFieldSchema(z.string()).optional(),
  maxRamMb: detectedFieldSchema(z.int().positive()),
  minRamMb: detectedFieldSchema(z.int().positive()).optional(),
  gamePort: portSchema.optional(),
  rconEnabled: z.boolean().optional(),
  rconPort: portSchema.optional(),
  queryPort: portSchema.optional(),
  motd: z.string().optional(),
  levelName: z.string().optional(),
  eulaAccepted: z.boolean(),
  javaRequirement: javaRequirementSchema.optional(),
  launch: launchPlanSchema.optional(),
  /** Installer présent mais `libraries/` absent : le loader n'a jamais été installé. */
  needsInstall: z.boolean().optional(),
  modCount: z.int().nonnegative().optional(),
  /** Confiance globale = min des champs essentiels (loader, version). */
  confidence: confidenceSchema,
  evidence: z.array(evidenceSchema),
});
export type DetectedServer = z.infer<typeof detectedServerSchema>;

export const serverDetectedSchema = z.object({
  eventId: ulidSchema,
  ts: epochMsSchema,
  directoryId: z.string().optional(),
  server: detectedServerSchema,
});
/** `scan.run` (P→A) : scan immédiat des répertoires surveillés (ou d'une sélection), phase 3. */
export const scanRunSchema = z.object({
  /** Restreint aux répertoires surveillés listés ; absent ⇒ tous. */
  directoryIds: z.array(z.string()).optional(),
  /** Chemins ad hoc à scanner en plus (assistant « ajouter un dossier »). */
  paths: z.array(z.string()).optional(),
});
export const scanRunResponseSchema = z.object({
  scannedPaths: z.array(z.string()),
  servers: z.array(detectedServerSchema),
});

export const serverRemovedSchema = z.object({
  eventId: ulidSchema,
  ts: epochMsSchema,
  path: z.string(),
  serverId: serverIdSchema.optional(),
});
export const serverUpdatedSchema = serverDetectedSchema.extend({ serverId: serverIdSchema });

// --- Contrôle ------------------------------------------------------------------------------------

export const serverRefSchema = z.object({ serverId: serverIdSchema });

export const serverStartResponseSchema = z.object({
  alreadyRunning: z.boolean().optional(),
  pid: z.int().positive().optional(),
});

export const serverStopSchema = z.object({
  serverId: serverIdSchema,
  /** Défaut 120 s (gros modpacks). */
  timeoutSec: z.int().positive().optional(),
  announce: z.string().optional(),
  forceAfterTimeout: z.boolean().optional(),
});
export const serverStopResponseSchema = z.object({
  alreadyStopped: z.boolean().optional(),
  forced: z.boolean().optional(),
});

export const serverRestartSchema = z.object({
  serverId: serverIdSchema,
  timeoutSec: z.int().positive().optional(),
  announce: z.string().optional(),
});

export const serverKillResponseSchema = z.object({ wasRunning: z.boolean() });

export const serverStateChangedSchema = z.object({
  eventId: ulidSchema,
  serverId: serverIdSchema,
  ts: epochMsSchema,
  state: runStateSchema,
  previous: runStateSchema.optional(),
  attachMode: attachModeSchema.optional(),
  pid: z.int().positive().optional(),
  exitReason: exitReasonSchema.optional(),
  exitCode: z.int().optional(),
  crashReportPath: z.string().optional(),
});

export const serverCommandSchema = z.object({
  serverId: serverIdSchema,
  /** Sans slash initial ; l'agent ajoute `\n`. */
  command: z.string().min(1),
});
export const serverCommandResponseSchema = z.object({ via: z.enum(['stdin', 'rcon']) });

export const serverRconSchema = z.object({
  serverId: serverIdSchema,
  command: z.string().min(1),
  timeoutMs: z.int().positive().optional(),
});
export const serverRconResponseSchema = z.object({ response: z.string() });

/**
 * Introspection des commandes du serveur (phase post-1.0). L'agent exécute `help` en RCON et rend
 * les lignes BRUTES : c'est le panel qui les analyse. Deux raisons — le parseur pourra être corrigé
 * sans mettre à jour les agents du parc, qui se mettent à jour bien plus lentement, et l'agent
 * reste bête. `name` demande le dépliage d'une seule commande (Brigadier abrège en `...`).
 */
export const serverCommandHelpSchema = z.object({
  serverId: serverIdSchema,
  name: z.string().max(64).optional(),
  timeoutMs: z.int().positive().optional(),
});
export const serverCommandHelpResponseSchema = z.object({
  /** `false` : serveur arrêté, RCON absent ou `help` inconnu — l'UI se rabat sans rien dire. */
  available: z.boolean(),
  lines: z.array(z.string()).max(4000),
  /** Des lignes ont été coupées : l'aperçu ne doit pas se prétendre exhaustif. */
  truncated: z.boolean(),
});

export const serverSetProvisioningSchema = z.object({
  serverId: serverIdSchema,
  provisioning: provisioningSchema,
});

// --- Joueurs ------------------------------------------------------------------------------------

export const playerEventSchema = z.object({
  eventId: ulidSchema,
  serverId: serverIdSchema,
  ts: epochMsSchema,
  kind: z.enum(['join', 'leave']),
  name: z.string(),
  uuid: z.string().optional(),
  /** Effectif en ligne après l'événement. */
  online: z.int().nonnegative(),
});

export const playerListResponseSchema = z.object({
  online: z.int().nonnegative(),
  max: z.int().nonnegative().optional(),
  players: z.array(z.object({ name: z.string(), uuid: z.string().optional() })),
});

/** Actions joueurs (phase 6) — routées par l'agent : en marche → commandes ; arrêté → fichiers (kick impossible). */
export const playerActionKindSchema = z.enum([
  'kick',
  'ban',
  'pardon',
  'banIp',
  'pardonIp',
  'op',
  'deop',
  'whitelistAdd',
  'whitelistRemove',
]);
export type PlayerActionKind = z.infer<typeof playerActionKindSchema>;
export const playerActionSchema = z.object({
  serverId: serverIdSchema,
  action: playerActionKindSchema,
  /** Nom de joueur, ou adresse IP pour `banIp`/`pardonIp`. */
  target: z.string().min(1).max(64),
  reason: z.string().max(256).optional(),
  /** Niveau d'op (1–4) en mode fichier ; ignoré en mode commandes (avertissement). */
  level: z.int().min(1).max(4).optional(),
});
export const playerActionResponseSchema = z.object({
  applied: z.enum(['file', 'commands']),
  /** Réponse RCON si disponible (vide via stdin). */
  response: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

/** Résolution nom → UUID (doc 06 §7) : usercache local, API Mojang (online-mode) ou UUID v3 hors ligne. */
export const playerResolveSchema = z.object({
  serverId: serverIdSchema,
  names: z.array(z.string().min(1).max(16)).min(1).max(50),
});
export const resolvedPlayerSchema = z.object({
  name: z.string(),
  uuid: z.string().nullable(),
  source: z.enum(['usercache', 'mojang', 'offline', 'unknown']),
});
export type ResolvedPlayer = z.infer<typeof resolvedPlayerSchema>;
export const playerResolveResponseSchema = z.object({
  players: z.array(resolvedPlayerSchema),
  onlineMode: z.boolean(),
});
