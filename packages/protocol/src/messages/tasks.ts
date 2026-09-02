/**
 * Jalon B — tasks (doc 05 §6 « Tasks et événements fiables », doc 04 §5) et backups (doc 05 §6
 * « Backups »). Une task est une opération longue lancée par une requête qui répond immédiatement
 * `{ taskId }` ; sa progression arrive par `task.progress`, son issue par `task.completed` /
 * `task.failed` (critiques : journalisés côté agent, rejoués jusqu'à `event.ack`). L'initiateur
 * fournit le `taskId` (ULID) : le panel pour les ordres, l'agent pour ses plannings locaux.
 */
import { z } from 'zod';

import { epochMsSchema, loaderSchema, serverIdSchema, ulidSchema } from '../common.js';
import { protocolErrorSchema } from '../errors.js';
import { relativePathSchema } from './fs.js';

export const taskIdSchema = ulidSchema;

/** Genres connus (chaîne libre : un genre inconnu est affiché tel quel par l'UI). */
export const TASK_KINDS = [
  'backup.create',
  'backup.restore',
  'backup.restorePaths',
  'backup.receive',
  'fs.fetch',
  'migration.export',
  'migration.import',
  'java.install',
] as const;
export const taskKindSchema = z.string().min(1);

export const taskStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Réponse immédiate de toute requête qui démarre une task. */
export const taskAcceptedSchema = z.object({ taskId: taskIdSchema });

// --- Événements -----------------------------------------------------------------------------------

export const taskProgressSchema = z.object({
  taskId: taskIdSchema,
  kind: taskKindSchema,
  serverId: serverIdSchema.optional(),
  ts: epochMsSchema,
  /** Phase courante (code stable, traduit par l'UI : `saving`, `archiving`, `verifying`…). */
  phase: z.string(),
  pct: z.number().min(0).max(100).optional(),
  detail: z.string().optional(),
  etaSec: z.int().nonnegative().optional(),
});

export const taskCompletedSchema = z.object({
  eventId: ulidSchema,
  taskId: taskIdSchema,
  kind: taskKindSchema,
  serverId: serverIdSchema.optional(),
  startedAt: epochMsSchema,
  finishedAt: epochMsSchema,
  /** Résultat propre au genre (ex. manifeste de backup). */
  result: z.record(z.string(), z.unknown()).default({}),
});

export const taskFailedSchema = z.object({
  eventId: ulidSchema,
  taskId: taskIdSchema,
  kind: taskKindSchema,
  serverId: serverIdSchema.optional(),
  startedAt: epochMsSchema,
  finishedAt: epochMsSchema,
  error: protocolErrorSchema,
  /** `true` si l'échec résulte d'un `task.cancel` (erreur `E_CANCELLED`). */
  cancelled: z.boolean().default(false),
});

// --- Requêtes -------------------------------------------------------------------------------------

export const taskCancelSchema = z.object({ taskId: taskIdSchema });
export const taskCancelResponseSchema = z.object({
  /** `false` si la task était déjà terminée (ou inconnue) : rien à annuler. */
  cancelled: z.boolean(),
  status: taskStatusSchema.optional(),
});

/** Le panel a enregistré le résultat : l'agent peut oublier la task de son journal. */
export const taskAckResultSchema = z.object({ taskId: taskIdSchema });

export const taskInfoSchema = z.object({
  taskId: taskIdSchema,
  kind: taskKindSchema,
  serverId: serverIdSchema.optional(),
  status: taskStatusSchema,
  phase: z.string().optional(),
  pct: z.number().min(0).max(100).optional(),
  startedAt: epochMsSchema,
  updatedAt: epochMsSchema,
  finishedAt: epochMsSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: protocolErrorSchema.optional(),
});
export type TaskInfo = z.infer<typeof taskInfoSchema>;

/** Réconciliation au boot du panel : toutes les tasks connues du journal de l'agent. */
export const taskListResponseSchema = z.object({ tasks: z.array(taskInfoSchema) });

// --- Backups --------------------------------------------------------------------------------------

export const backupKindSchema = z.enum(['manual', 'scheduled', 'pre_migration', 'pre_restore']);
export type BackupKind = z.infer<typeof backupKindSchema>;

/** Codec d'archive (spike n°3) : zstd 3 par défaut si le runtime le supporte, gzip en repli. */
export const backupCodecSchema = z.enum(['zstd', 'gzip']);
export type BackupCodec = z.infer<typeof backupCodecSchema>;

export const backupCreateSchema = z.object({
  taskId: taskIdSchema,
  serverId: serverIdSchema,
  /** ID de la sauvegarde (panel = autorité pour les ordres ; absent ⇒ l'agent en génère un). */
  backupId: z.string().min(1).optional(),
  kind: backupKindSchema.default('manual'),
  policyId: z.string().optional(),
  /** Dossier de destination absolu ; absent ⇒ destination globale (`agent.configure`) ou défaut agent. */
  destination: z.string().optional(),
  codec: backupCodecSchema.optional(),
  /** Rotation après succès (plannings) : garde les N plus récentes de la même politique. */
  keep: z.int().positive().optional(),
  keepDays: z.int().positive().optional(),
  comment: z.string().max(500).optional(),
});
export const backupCreateResponseSchema = z.object({
  taskId: taskIdSchema,
  backupId: z.string().min(1),
});

/** Manifeste `<backupId>.json` déposé à côté de l'archive — seule source d'intégrité (sha256 + taille). */
export const backupManifestSchema = z.object({
  backupId: z.string().min(1),
  serverId: serverIdSchema,
  kind: backupKindSchema,
  policyId: z.string().optional(),
  createdAt: epochMsSchema,
  codec: backupCodecSchema,
  /** Chemin absolu de l'archive sur la machine de l'agent. */
  archivePath: z.string(),
  sizeBytes: z.int().nonnegative(),
  sha256: z.string().length(64),
  files: z.int().nonnegative(),
  bytesRaw: z.int().nonnegative(),
  /** Sauvegarde à chaud (serveur en marche : `save-off` / `save-all flush` / `save-on`). */
  hot: z.boolean(),
  serverName: z.string().optional(),
  mcVersion: z.string().optional(),
  loader: loaderSchema.optional(),
  agentVersion: z.string().optional(),
  comment: z.string().optional(),
  /**
   * Lot 4 (2026-09-02) — vérification périodique par l'agent : relecture complète de l'archive
   * (taille + sha256) et résultat **écrit dans le manifeste**, pour que `backup.list` le porte à
   * la reconnexion même si l'événement `backup.verified` (non critique) s'est perdu. Optionnels :
   * un manifeste d'agent N-1 n'en a pas, il vaut « jamais vérifié ».
   */
  verifiedAt: epochMsSchema.optional(),
  verifyStatus: z.enum(['ok', 'corrupted']).optional(),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** Résultat de `backup.create` (dans `task.completed.result`). */
export const backupCreateResultSchema = backupManifestSchema.extend({
  durationMs: z.int().nonnegative(),
});

export const backupListSchema = z.object({
  serverId: serverIdSchema,
  /** Dossiers à inspecter en plus de la destination courante (anciennes destinations). */
  destinations: z.array(z.string()).optional(),
});
export const backupListResponseSchema = z.object({ backups: z.array(backupManifestSchema) });

export const backupRestoreSchema = z.object({
  taskId: taskIdSchema,
  serverId: serverIdSchema,
  backupId: z.string().min(1),
  /** Chemin de l'archive si elle n'est pas dans la destination courante. */
  archivePath: z.string().optional(),
  /** Backup de sécurité avant restauration (défaut : oui). */
  safetyBackup: z.boolean().default(true),
  safetyBackupId: z.string().min(1).optional(),
  restartAfter: z.boolean().default(false),
});

/** Résultat de `backup.restore`. */
export const backupRestoreResultSchema = z.object({
  backupId: z.string(),
  safetyBackup: backupManifestSchema.optional(),
  files: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  /** Serveur relancé après restauration (`restartAfter`). */
  restarted: z.boolean(),
  /** Le serveur tournait avant la restauration (arrêté par la task). */
  wasRunning: z.boolean(),
});

export const backupDeleteSchema = z.object({
  serverId: serverIdSchema,
  backupId: z.string().min(1),
  archivePath: z.string().optional(),
});
export const backupDeleteResponseSchema = z.object({ deleted: z.boolean() });

// --- Restauration partielle (lot 4, 2026-09-02 — ajouts sans bump) ------------------------------

/**
 * `backup.browse` : contenu d'une archive lu **sans extraction** (une passe sur les en-têtes tar).
 * Les dossiers portent la taille et le nombre de fichiers qu'ils contiennent ; au plus
 * `BROWSE_FILES_PER_DIR` fichiers sont listés par dossier (`truncated` sur le dossier, puis sur la
 * réponse) — un dossier se restaure entier quel que soit ce qui est listé dessous. Un agent N-1
 * répond `E_UNSUPPORTED_TYPE` : l'UI dit de le mettre à jour.
 */
export const BROWSE_FILES_PER_DIR = 2000;
export const BROWSE_MAX_ENTRIES = 50_000;

export const backupBrowseSchema = z.object({
  serverId: serverIdSchema,
  backupId: z.string().min(1),
  archivePath: z.string().optional(),
});
export const backupBrowseEntrySchema = z.object({
  /** Chemin relatif jailé, séparateur `/`. */
  path: z.string().min(1),
  kind: z.enum(['file', 'dir']),
  /** Fichier : sa taille ; dossier : somme des fichiers qu'il contient (listés ou non). */
  size: z.int().nonnegative(),
  modifiedAt: epochMsSchema.optional(),
  /** Dossier : nombre de fichiers contenus (récursif). */
  files: z.int().nonnegative().optional(),
  /** Dossier : une partie de ses fichiers directs n'est pas listée. */
  truncated: z.boolean().optional(),
});
export type BackupBrowseEntry = z.infer<typeof backupBrowseEntrySchema>;
export const backupBrowseResponseSchema = z.object({
  entries: z.array(backupBrowseEntrySchema),
  totalFiles: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),
  /** Au moins un fichier de l'archive n'est pas listé. */
  truncated: z.boolean(),
});
export type BackupBrowseResponse = z.infer<typeof backupBrowseResponseSchema>;

/** Chemins à restaurer : relatifs, jailés, non vides ; un dossier vaut tout son contenu. */
export const restorePathListSchema = z
  .array(relativePathSchema.refine((p) => p !== '', { message: 'path expected' }))
  .min(1)
  .max(500);

/**
 * `side_by_side` (défaut) : extraction dans `restored-<date>/` à la racine du serveur — rien n'est
 * remplacé, le serveur continue de tourner. `in_place` : les chemins choisis sont supprimés puis
 * réécrits depuis l'archive, serveur arrêté, sauvegarde de sécurité d'abord.
 */
export const restoreModeSchema = z.enum(['side_by_side', 'in_place']);
export type RestoreMode = z.infer<typeof restoreModeSchema>;

export const backupRestorePathsSchema = z.object({
  taskId: taskIdSchema,
  serverId: serverIdSchema,
  backupId: z.string().min(1),
  archivePath: z.string().optional(),
  paths: restorePathListSchema,
  mode: restoreModeSchema.default('side_by_side'),
  /** `in_place` seulement : sauvegarde de sécurité avant de remplacer (défaut : oui). */
  safetyBackup: z.boolean().default(true),
  safetyBackupId: z.string().min(1).optional(),
  /** `in_place` seulement : relancer le serveur arrêté pour la restauration. */
  restartAfter: z.boolean().default(false),
});

/** Résultat de `backup.restorePaths`. */
export const backupRestorePathsResultSchema = z.object({
  backupId: z.string(),
  mode: restoreModeSchema,
  /** Chemins effectivement restaurés (normalisés, dédoublonnés). */
  paths: z.array(z.string()),
  /** `side_by_side` : dossier créé à la racine du serveur (`restored-<date>`). */
  destination: z.string().optional(),
  files: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  safetyBackup: backupManifestSchema.optional(),
  restarted: z.boolean(),
  wasRunning: z.boolean(),
});
export type BackupRestorePathsResult = z.infer<typeof backupRestorePathsResultSchema>;

/**
 * Occurrence de planning volontairement NON exécutée (serveur arrêté et `onlyIfRunning`, autre
 * task de sauvegarde en cours, expression cron invalide). Sans ce message, ces trois sorties sont
 * muettes côté panel : la politique paraît morte alors qu'elle se comporte comme prévu.
 *
 * ⚠ Événement **non critique** délibérément : un type inconnu d'un panel N-1 est journalisé puis
 * jeté sans acquittement (`rpc/peer.ts`). Déclaré critique, il resterait pour toujours dans
 * `pendingEvents` et finirait par évincer de vrais `task.completed`.
 */
export const backupSkippedSchema = z.object({
  serverId: serverIdSchema,
  ts: epochMsSchema,
  policyId: z.string(),
  /** Chaîne libre volontairement : le panel l'affiche, il ne branche pas dessus. */
  reason: z.enum(['server_stopped', 'task_running', 'invalid_cron', 'start_failed']),
  detail: z.string().max(500).optional(),
});

/**
 * Lot 4 (2026-09-02) — résultat d'une vérification d'archive par l'agent (passe périodique :
 * relecture complète, taille + sha256 contre le manifeste). `ok: false` = archive corrompue ou
 * tronquée ; le panel publie `backup.corrupted` et l'affiche sur la fiche.
 *
 * **Non critique**, comme `backup.skipped` (un panel N-1 ignore le type sans acquitter) : la
 * durabilité vient du manifeste (`verifiedAt`/`verifyStatus`), relu par `backup.list` à chaque
 * reconnexion — un résultat perdu en route est rattrapé là.
 */
export const backupVerifiedSchema = z.object({
  serverId: serverIdSchema,
  backupId: z.string().min(1),
  ts: epochMsSchema,
  ok: z.boolean(),
  /** Mesuré sur le disque à la vérification. */
  sizeBytes: z.int().nonnegative(),
  sha256: z.string().length(64),
  /** Attendu (manifeste) — présent pour que le panel puisse nommer l'écart sans relire sa table. */
  expectedSizeBytes: z.int().nonnegative(),
  expectedSha256: z.string().length(64),
  archivePath: z.string().optional(),
});

/** Rotation locale (agent) : archives supprimées — synchronise la table `backups` du panel. */
export const backupRotatedSchema = z.object({
  eventId: ulidSchema,
  serverId: serverIdSchema,
  ts: epochMsSchema,
  policyId: z.string().optional(),
  deleted: z.array(z.object({ backupId: z.string(), archivePath: z.string() })),
});

// --- Réplication hors-site (lot 4, 2026-09-02 — ajout sans bump) ---------------------------------

export const transferSourceSchema = z.object({
  url: z.string().min(1),
  kind: z.enum(['direct', 'relay']),
  headers: z.record(z.string(), z.string()).optional(),
});
export type TransferSource = z.infer<typeof transferSourceSchema>;

/**
 * `backup.receive` : cette machine reçoit une **copie** d'une archive produite ailleurs — mêmes
 * sources que `migration.import` (listener direct de l'agent source, puis relais panel, reprise
 * `Range`), sha256 vérifié, manifeste réécrit à côté sous le **même `backupId`** (`backup.list` la
 * voit, `transfer.serve` sait la servir pour un rapatriement), puis rotation `keep` sur ce dossier :
 * la rétention de la copie est indépendante de celle de l'original. Le serveur n'a pas besoin
 * d'exister sur cette machine. Un agent N-1 répond `E_UNSUPPORTED_TYPE` (capacité `replication`).
 */
export const backupReceiveSchema = z.object({
  taskId: taskIdSchema,
  serverId: serverIdSchema,
  backupId: z.string().min(1),
  manifest: backupManifestSchema,
  sources: z.array(transferSourceSchema).min(1),
  /** Dossier racine absolu ; absent ⇒ destination globale de cet agent ou défaut. */
  destination: z.string().optional(),
  /** Copies conservées dans ce dossier pour ce serveur (les plus anciennes partent). */
  keep: z.int().positive().optional(),
  connectTimeoutMs: z.int().positive().optional(),
});
export type BackupReceiveRequest = z.infer<typeof backupReceiveSchema>;

/** Résultat de `backup.receive` (dans `task.completed.result`). */
export const backupReceiveResultSchema = z.object({
  backupId: z.string().min(1),
  serverId: serverIdSchema,
  archivePath: z.string(),
  sizeBytes: z.int().nonnegative(),
  sha256: z.string().length(64),
  source: z.enum(['direct', 'relay']),
  durationMs: z.int().nonnegative(),
  /** Copies plus anciennes supprimées par la rotation `keep` de ce dossier. */
  rotated: z.array(z.string()),
});
export type BackupReceiveResult = z.infer<typeof backupReceiveResultSchema>;

// --- fs.fetch (task) : l'agent télécharge une URL dans le dossier du serveur --------------------

export const fsFetchSchema = z.object({
  taskId: taskIdSchema,
  serverId: serverIdSchema,
  /** Destination relative, jailée (ex. `mods/spark-forge.jar`). */
  path: relativePathSchema.refine((p) => p !== '', { message: 'path expected' }),
  url: z.url(),
  /**
   * Sources de repli, essayées dans l'ordre APRÈS `url` : un miroir, ou le relais du panel pour une
   * machine sans accès direct. Ajout pur — un agent N-1 les ignore et se contente de `url`.
   */
  sources: z
    .array(z.object({ url: z.url(), kind: z.enum(['direct', 'relay']).optional() }))
    .max(8)
    .optional(),
  sha256: z.string().length(64).optional(),
  sha1: z.string().length(40).optional(),
  size: z.int().nonnegative().optional(),
  overwrite: z.boolean().default(false),
});
export const fsFetchResultSchema = z.object({
  path: z.string(),
  size: z.int().nonnegative(),
  sha256: z.string().length(64),
  /**
   * Empreinte sha1 du fichier obtenu : c'est celle qu'utilisent les catalogues de mods pour
   * identifier un jar. Optionnelle, donc un agent N-1 qui ne la renvoie pas reste valide.
   */
  sha1: z.string().length(40).optional(),
});
