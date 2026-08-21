/** Briques de schémas réutilisées par tout le catalogue (alignées sur doc 04). */
import { z } from 'zod';

/** Timestamps : toujours epoch en millisecondes (décision verrouillée). */
export const epochMsSchema = z.int().nonnegative();
export type EpochMs = z.infer<typeof epochMsSchema>;

/** ULID : 26 caractères Crockford base32. */
export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export const serverIdSchema = z.string().min(1);
export const portSchema = z.int().min(1).max(65535);

export const loaderSchema = z.enum(['vanilla', 'forge', 'neoforge', 'fabric', 'unknown']);
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

export const logLevelSchema = z.enum(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const osSchema = z.enum(['windows', 'linux', 'macos']);
export type Os = z.infer<typeof osSchema>;
export const archSchema = z.enum(['x64', 'arm64']);

/** Capacités optionnelles annoncées dans `auth.hello` (chaîne libre ; valeurs connues documentées). */
export const KNOWN_CAPABILITIES = ['rcon', 'zstd', 'direct-transfer'] as const;
export const capabilitySchema = z.string().min(1);

/** Compression des flux volumineux : zstd par défaut si la capacité est annoncée, gzip en repli (spike n°3). */
export const compressionSchema = z.enum(['none', 'gzip', 'zstd']);
export type Compression = z.infer<typeof compressionSchema>;

/** Source de la mesure CPU (spike n°2) : `ticks` = potentiellement sous-évaluée, l'UI avertit. */
export const cpuSourceSchema = z.enum(['cycles', 'proc', 'ticks']);
export type CpuSource = z.infer<typeof cpuSourceSchema>;

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
});

/** Objet vide tolérant : `{}` accepté, champs inconnus ignorés. */
export const emptyPayloadSchema = z.object({});
