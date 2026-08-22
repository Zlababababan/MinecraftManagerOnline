/**
 * Phase 9 — migration agent → agent (doc 05 §8). Contrôle par le panel, données directes entre
 * agents (HTTP one-shot sur IP privée, token unique, TTL court, reprise `Range`), repli relais via
 * le panel. Format d'export = archive de backup (`pre_migration`) + manifeste (sha256 + taille).
 *
 *   migration.export (task, source) → transfer.serve (source) → migration.precheck (cible)
 *   → migration.import (task, cible) → bascule de propriété en base → migration.finalize (source)
 */
import { z } from 'zod';

import { epochMsSchema, javaRuntimeSchema, portSchema, serverIdSchema } from '../common.js';
import { serverConfigSchema } from './agent.js';
import { backupCodecSchema, backupManifestSchema, taskIdSchema } from './tasks.js';

export const migrationIdSchema = z.string().min(1);

// --- migration.export (P→A source, task) ---------------------------------------------------------

/** Arrête le serveur s'il tourne (annonce optionnelle) puis crée un backup `pre_migration`. */
export const migrationExportSchema = z.object({
  taskId: taskIdSchema,
  serverId: serverIdSchema,
  migrationId: migrationIdSchema,
  /** ID de la sauvegarde produite (panel = autorité). */
  backupId: z.string().min(1),
  codec: backupCodecSchema.optional(),
  destination: z.string().optional(),
  /** Message envoyé aux joueurs avant l'arrêt. */
  announce: z.string().optional(),
  stopTimeoutSec: z.int().positive().optional(),
});
/** Résultat : manifeste du backup + état du serveur avant export. */
export const migrationExportResultSchema = backupManifestSchema.extend({
  wasRunning: z.boolean(),
  durationMs: z.int().nonnegative(),
});

// --- transfer.serve (P→A source) -----------------------------------------------------------------

/** Listener HTTP one-shot : sert l'archive d'un backup sur les IP privées de la machine. */
export const transferServeSchema = z.object({
  serverId: serverIdSchema,
  backupId: z.string().min(1),
  /** Jeton d'accès (32 caractères hex, fourni par le panel, à usage unique). */
  token: z.string().min(16),
  /** Durée de vie du listener (défaut 600 s). */
  ttlSec: z.int().positive().max(86_400).default(600),
});
export const transferServeResponseSchema = z.object({
  /** URLs candidates (une par adresse privée), à essayer dans l'ordre. */
  urls: z.array(z.url()),
  size: z.int().nonnegative(),
  sha256: z.string().length(64),
  expiresAt: epochMsSchema,
});

// --- migration.precheck (P→A cible) ---------------------------------------------------------------

export const migrationPrecheckSchema = z.object({
  serverId: serverIdSchema,
  /** Dossier cible absolu (doit être absent ou vide). */
  path: z.string().min(1),
  gamePort: portSchema.optional(),
  javaMajor: z.int().positive().optional(),
  javaStrict: z.boolean().optional(),
  /** Octets nécessaires (archive + extraction ≈ 2 × bytesRaw). */
  requiredBytes: z.int().nonnegative(),
});
export const precheckItemSchema = z.object({
  ok: z.boolean(),
  /** Code d'explication (traduit par l'UI) : `port_in_use`, `path_exists`, `java_missing`, `disk_full`… */
  code: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export const migrationPrecheckResponseSchema = z.object({
  ok: z.boolean(),
  path: precheckItemSchema,
  port: precheckItemSchema,
  java: precheckItemSchema.extend({
    runtime: javaRuntimeSchema.optional(),
    /** Aucun JRE adapté, mais `java.install` peut en fournir un. */
    installable: z.boolean().optional(),
  }),
  disk: precheckItemSchema.extend({
    freeBytes: z.int().nonnegative().optional(),
    requiredBytes: z.int().nonnegative().optional(),
  }),
});
export type MigrationPrecheckResult = z.infer<typeof migrationPrecheckResponseSchema>;

// --- migration.import (P→A cible, task) -----------------------------------------------------------

export const migrationImportSchema = z.object({
  taskId: taskIdSchema,
  migrationId: migrationIdSchema,
  /** Configuration complète du serveur sur la cible (même `serverId`, nouveau `path`). */
  config: serverConfigSchema,
  /** Manifeste de l'archive exportée (intégrité : sha256 + taille). */
  manifest: backupManifestSchema,
  /**
   * Sources à essayer dans l'ordre : directes (listener de la source) puis relais (panel). Une URL
   * relative est résolue contre l'origine HTTP du panel. Toutes supportent `Range` (reprise).
   */
  sources: z
    .array(
      z.object({
        url: z.string().min(1),
        kind: z.enum(['direct', 'relay']),
        /** En-têtes à envoyer (jeton). */
        headers: z.record(z.string(), z.string()).optional(),
      }),
    )
    .min(1),
  /** Délai de connexion par source directe (défaut 5 s). */
  connectTimeoutMs: z.int().positive().optional(),
  /** Relancer le serveur après import (état souhaité avant migration). */
  startAfter: z.boolean().default(false),
});
export const migrationImportResultSchema = z.object({
  serverId: serverIdSchema,
  path: z.string(),
  files: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  /** Source ayant fourni l'archive. */
  source: z.enum(['direct', 'relay']),
  started: z.boolean(),
});

// --- migration.finalize (P→A source) --------------------------------------------------------------

/** Après bascule : le dossier source est renommé `.migrated-<date>` (purge différée) ou conservé. */
export const migrationFinalizeSchema = z.object({
  serverId: serverIdSchema,
  migrationId: migrationIdSchema,
  path: z.string().min(1),
  action: z.enum(['rename', 'keep']).default('rename'),
});
export const migrationFinalizeResponseSchema = z.object({
  /** Nouveau chemin du dossier source (`rename`) ou chemin inchangé (`keep`). */
  path: z.string(),
  renamed: z.boolean(),
  /** Date de purge automatique du dossier renommé (agent). */
  purgeAfter: epochMsSchema.optional(),
});
