/**
 * Lot 5 — `server.install` (doc 05 §6 « Installation », doc 06 §6bis/§6ter) : **un seul message**,
 * ajouté sans bump de version. Le panel décide entièrement du plan et l'agent l'exécute : une suite
 * d'étapes en union discriminée, dont l'agent ignore la provenance (vanilla, Fabric, plus tard un
 * modpack). `taskKind` et `phase` étant des chaînes libres, un panel N-1 affiche la task telle
 * quelle ; un agent N-1 répond `E_UNSUPPORTED_TYPE`, d'où la capacité `server-install`.
 *
 * Deux invariants portés par le message plutôt que par la discipline de l'appelant :
 *
 * 1. **L'EULA n'est pas une étape** mais un drapeau appliqué à la toute fin. Le lanceur Fabric
 *    installe puis DÉMARRE le serveur, et ne s'arrête que parce que `eula.txt` manque (mesuré,
 *    doc 06 §6ter) : écrire l'EULA avant lui laisserait un serveur en marche au milieu d'une
 *    installation. L'ordre est donc structurellement impossible à inverser depuis le panel.
 * 2. **Le dossier doit être vide**, sauf en mode `repair` (finir un installeur déjà présent, ou
 *    réparer une installation interrompue) — le seul cas où l'on écrit dans un dossier peuplé.
 */
import { z } from 'zod';

import { loaderSchema, serverIdSchema } from '../common.js';
import { relativePathSchema } from './fs.js';
import { detectedServerSchema } from './server.js';
import { taskIdSchema } from './tasks.js';

/** Nombre d'étapes d'un plan (garde-fou : un plan légitime en compte moins de dix). */
export const MAX_INSTALL_STEPS = 50;
/** Durée maximale d'un `runJar` (un installeur moddé sur ligne lente se compte en minutes). */
export const INSTALL_RUN_TIMEOUT_MAX_SEC = 3600;
export const INSTALL_RUN_TIMEOUT_DEFAULT_SEC = 1800;

/** Source de repli d'un téléchargement (miroir, ou relais du panel pour une machine sans Internet). */
export const installSourceSchema = z.object({
  url: z.url(),
  kind: z.enum(['direct', 'relay']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const installStepSchema = z.discriminatedUnion('kind', [
  /** Télécharge un fichier dans le dossier du serveur (reprise `Range`, empreinte vérifiée). */
  z.object({
    kind: z.literal('download'),
    path: relativePathSchema.refine((p) => p !== '', { message: 'path expected' }),
    url: z.url(),
    sources: z.array(installSourceSchema).max(8).optional(),
    sha1: z.string().length(40).optional(),
    sha256: z.string().length(64).optional(),
    size: z.int().nonnegative().optional(),
    /** Libellé humain de l'étape (l'UI traduit la phase, pas ceci). */
    label: z.string().max(120).optional(),
  }),
  /**
   * Exécute un JAR **dans** le dossier du serveur : installeur Forge/NeoForge, ou lanceur Fabric.
   * Processus non détaché (à l'inverse des serveurs), sans shell, sortie NON relayée en console
   * (7 580 lignes mesurées pour NeoForge, doc 06 §6bis) — seule la fin est jointe à un échec.
   */
  z.object({
    kind: z.literal('runJar'),
    jar: relativePathSchema.refine((p) => p !== '', { message: 'jar expected' }),
    args: z.array(z.string()).max(32).default([]),
    /**
     * Version majeure de Java à utiliser ; absente ⇒ n'importe quel JRE disponible. L'installation
     * n'est PAS soumise à la contrainte du serveur (mesuré doc 06 §6bis) : le bon Java n'est résolu
     * qu'au premier démarrage.
     */
    javaMajor: z.int().positive().optional(),
    timeoutSec: z
      .int()
      .positive()
      .max(INSTALL_RUN_TIMEOUT_MAX_SEC)
      .default(INSTALL_RUN_TIMEOUT_DEFAULT_SEC),
    /** Fichiers/dossiers attendus au terme de l'étape : leur absence est un échec explicite. */
    expect: z.array(relativePathSchema).max(16).default([]),
    label: z.string().max(120).optional(),
  }),
  /** Écrit un fichier texte (UTF-8) — jamais `eula.txt`, qui passe par `acceptEula`. */
  z.object({
    kind: z.literal('writeText'),
    path: relativePathSchema.refine((p) => p !== '', { message: 'path expected' }),
    content: z.string().max(64 * 1024),
    /** N'écrit que si le fichier est absent (ne pas écraser ce qu'un installeur vient de produire). */
    ifAbsent: z.boolean().default(false),
  }),
  /** Fusionne des clés dans un fichier Java Properties (clés inconnues préservées). */
  z.object({
    kind: z.literal('setProperties'),
    path: relativePathSchema.default('server.properties'),
    values: z.record(z.string(), z.string()),
  }),
]);
export type InstallStep = z.infer<typeof installStepSchema>;

export const serverInstallSchema = z.object({
  taskId: taskIdSchema,
  serverId: serverIdSchema,
  /** Dossier absolu de destination (le panel en est l'autorité, comme pour une migration). */
  path: z.string().min(1),
  steps: z.array(installStepSchema).min(1).max(MAX_INSTALL_STEPS),
  /** Ce que le panel croit installer — sert au nommage et au journal, jamais à la détection. */
  loader: loaderSchema,
  mcVersion: z.string().optional(),
  loaderVersion: z.string().optional(),
  /** Écrit `eula=true` APRÈS toutes les étapes (voir l'invariant en tête de fichier). */
  acceptEula: z.boolean().default(false),
  /** Mode « réparer » : le dossier peut être peuplé, et rien n'y est supprimé en cas d'échec. */
  repair: z.boolean().default(false),
});

export const serverInstallResultSchema = z.object({
  serverId: serverIdSchema,
  path: z.string(),
  /** Détection du dossier installé : le panel met sa ligne à jour comme sur `server.detected`. */
  detected: detectedServerSchema.optional(),
  steps: z.int().nonnegative(),
  files: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  eulaAccepted: z.boolean(),
  durationMs: z.int().nonnegative(),
});
export type ServerInstallResult = z.infer<typeof serverInstallResultSchema>;

/** Phases publiées par `task.progress` (codes stables, traduits par l'UI). */
export const INSTALL_PHASES = [
  'preparing',
  'downloading',
  'running',
  'writing',
  'detecting',
  'done',
] as const;
