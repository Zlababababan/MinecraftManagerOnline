/**
 * Phase 9 — gestionnaire Java (doc 03 §4, doc 05 §6 « Java ») : `java.install` est une task dont le
 * payload est la **chaîne ordonnée de sources décidée par le panel** (Temurin → Zulu → x64 émulé),
 * incluant le **mode relais** (URL servie par le panel pour les machines sans Internet sortant).
 * L'agent essaie chaque source dans l'ordre : téléchargement, vérification sha256, extraction sous
 * `<stateDir>/java/<major>-<vendor>/`, sonde `java -version`. Échec d'une source = source suivante.
 */
import { z } from 'zod';

import { javaRuntimeSchema } from '../common.js';
import { taskIdSchema } from './tasks.js';

export const javaVendorSchema = z.enum(['temurin', 'zulu', 'system', 'unknown']);

export const javaSourceSchema = z.object({
  vendor: javaVendorSchema,
  /** URL absolue (fournisseur) ou relative au panel (`/api/relay/…`, mode relais). */
  url: z.string().min(1),
  archive: z.enum(['zip', 'tar.gz']),
  sha256: z.string().length(64).optional(),
  size: z.int().nonnegative().optional(),
  /** Build x64 exécuté sous émulation (Java 8 sur Windows ARM, doc 03 §4). */
  emulated: z.boolean().default(false),
  /** Servie par le panel (relais) : les en-têtes éventuels (jeton). */
  relay: z.boolean().default(false),
  headers: z.record(z.string(), z.string()).optional(),
  /** Version complète annoncée par le fournisseur (information). */
  fullVersion: z.string().optional(),
});
export type JavaSource = z.infer<typeof javaSourceSchema>;

export const javaInstallSchema = z.object({
  taskId: taskIdSchema,
  majorVersion: z.int().positive(),
  sources: z.array(javaSourceSchema).min(1),
});
export const javaInstallResultSchema = z.object({
  runtime: javaRuntimeSchema,
  /** Source effectivement utilisée (index dans `sources`). */
  sourceIndex: z.int().nonnegative(),
  vendor: javaVendorSchema,
  emulated: z.boolean(),
  /** Sources ayant échoué avant celle retenue (`{ index, code, message }`). */
  failures: z
    .array(z.object({ index: z.int().nonnegative(), code: z.string(), message: z.string() }))
    .default([]),
});

/** Supprime un JRE **géré** par l'agent (jamais une JVM système). */
export const javaRemoveSchema = z.object({ path: z.string().min(1) });
export const javaRemoveResponseSchema = z.object({ removed: z.boolean() });
