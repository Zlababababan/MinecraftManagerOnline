/** Briques de schémas réutilisées par tout le catalogue (alignées sur doc 04). */
import { z } from 'zod';

/** Timestamps : toujours epoch en millisecondes (décision verrouillée). */
export const epochMsSchema = z.int().nonnegative();
export type EpochMs = z.infer<typeof epochMsSchema>;

/** ULID : 26 caractères Crockford base32. */
export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export const serverIdSchema = z.string().min(1);
export const portSchema = z.int().min(1).max(65535);

/** `velocity` = proxy (pas de version Minecraft, pas d'EULA Mojang, pas de RCON). */
export const loaderSchema = z.enum([
  'vanilla',
  'forge',
  'neoforge',
  'fabric',
  'velocity',
  'unknown',
]);
export type Loader = z.infer<typeof loaderSchema>;

export const runStateSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'crashed']);
export type RunState = z.infer<typeof runStateSchema>;

export const desiredStateSchema = z.enum(['stopped', 'running']);
export const attachModeSchema = z.enum(['attached', 'detached']);
export type AttachMode = z.infer<typeof attachModeSchema>;
export const provisioningSchema = z.enum([
  'installing',
  'install_failed',
  'ready',
  'archived',
  'migrating',
]);
export const exitReasonSchema = z.enum(['stop', 'kill', 'crash', 'freeze_kill']);
export type ExitReason = z.infer<typeof exitReasonSchema>;

/**
 * Priorité CPU du processus Java d'un serveur. Remontée d'usage : un modpack qui démarre prend
 * tous les cœurs et rend la machine inutilisable le temps de la génération du monde.
 *
 * Les valeurs sont celles que `os.setPriority` sait rendre des deux côtés (aucun module natif) :
 * `normal` = 0, `below_normal` = 10, `low` = 19 — sous Windows NORMAL / BELOW_NORMAL / IDLE, sous
 * Unix le `nice` du même nom. `low` n'est PAS le réglage à recommander : le serveur n'y tourne
 * plus que sur les restes, TPS compris ; `below_normal` suffit à rendre la main au navigateur.
 */
export const cpuPrioritySchema = z.enum(['normal', 'below_normal', 'low']);
export type CpuPriority = z.infer<typeof cpuPrioritySchema>;

export const logLevelSchema = z.enum(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const osSchema = z.enum(['windows', 'linux', 'macos']);
export type Os = z.infer<typeof osSchema>;
export const archSchema = z.enum(['x64', 'arm64']);

/** Capacités optionnelles annoncées dans `auth.hello` (chaîne libre ; valeurs connues documentées). */
export const KNOWN_CAPABILITIES = [
  'rcon',
  'zstd',
  'direct-transfer',
  'tasks',
  'backups',
  'transfers',
  'migration',
  'java',
  'update',
  /** Lot 9 : `agent.diagnostics` (journal fichier + état borné). */
  'diagnostics',
  /** Lot 4 : `backup.browse` + `backup.restorePaths` (restauration partielle). */
  'partial-restore',
  /** Lot 4 : `backup.receive` (copie hors-site d'une archive vers cette machine). */
  'replication',
  /** Lot 5 : `server.install` (créer un serveur dans un dossier vide, ou finir une installation). */
  'server-install',
  /** Lot 5 : étape `remove` d'un plan `server.install` (installeurs Forge et NeoForge, retirés après usage). */
  'install-remove',
  /** Lot 5 : étape `fetchMany` (fichiers d'un modpack, doc 06 §6quinquies). */
  'install-fetch-many',
  /** Lot 5 : étape `extract` + `install.archives`/`install.archiveInspect` (serveur depuis un zip, doc 06 §6sexies). */
  'install-extract',
  /** 1.0.13 : l'archive d'un `extract` peut être n'importe quel zip de la machine (chemin absolu), plus seulement à la racine d'un répertoire surveillé. */
  'install-archive-path',
] as const;
export const capabilitySchema = z.string().min(1);

/** Compression des flux volumineux : zstd par défaut si la capacité est annoncée, gzip en repli (spike n°3). */
export const compressionSchema = z.enum(['none', 'gzip', 'zstd']);
export type Compression = z.infer<typeof compressionSchema>;

/** Source de la mesure CPU (spike n°2) : `ticks` = potentiellement sous-évaluée, l'UI avertit. */
export const cpuSourceSchema = z.enum(['cycles', 'proc', 'ticks']);
export type CpuSource = z.infer<typeof cpuSourceSchema>;

/** Méthode ayant fourni le TPS (doc 06 §6, chaîne de fallback) ; absent ⇒ « TPS indisponible ». */
export const tpsSourceSchema = z.enum(['neoforge', 'forge', 'spark', 'tick_query']);
export type TpsSource = z.infer<typeof tpsSourceSchema>;

export const confidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof confidenceSchema>;

/** Champ détecté : valeur + score de confiance + source (doc 06 §2, étape 6). */
export function detectedFieldSchema<T extends z.ZodType>(value: T) {
  return z.object({ value, confidence: confidenceSchema, source: z.string() });
}
export interface DetectedField<T> {
  value: T;
  confidence: Confidence;
  source: string;
}

/** Indice de détection : code (traduit par l'UI) + détail brut optionnel. */
export const evidenceSchema = z.object({ code: z.string(), detail: z.string().optional() });
export type Evidence = z.infer<typeof evidenceSchema>;

export const javaRuntimeSchema = z.object({
  id: z.string().optional(),
  majorVersion: z.int().positive(),
  fullVersion: z.string().optional(),
  vendor: z.string(),
  path: z.string(),
  managed: z.boolean(),
});
export type JavaRuntime = z.infer<typeof javaRuntimeSchema>;

export const machineInfoSchema = z.object({
  hostname: z.string(),
  os: osSchema,
  arch: archSchema,
  cpuModel: z.string().optional(),
  cpuCores: z.int().positive().optional(),
  ramTotalMb: z.int().positive().optional(),
  /**
   * Phase 10 : adresses utiles pour « l'adresse à donner aux amis » (doc 03 §5). `tailnet` =
   * interfaces 100.64.0.0/10 et fd7a:115c:a1e0::/48 ; `global` = IPv6 unicast globale (2000::/3)
   * et IPv4 publique. Jamais présumé : listes vides si rien n'est détecté.
   */
  addresses: z
    .object({
      tailnet: z.array(z.string()).default([]),
      global: z.array(z.string()).default([]),
    })
    .optional(),
});

/** Objet vide tolérant : `{}` accepté, champs inconnus ignorés. */
export const emptyPayloadSchema = z.object({});
