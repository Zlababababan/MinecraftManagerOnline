/** Monitoring : métriques, watchdog, conflits de ports, Java, acquittements (doc 05 §6). */
import { z } from 'zod';

import {
  cpuSourceSchema,
  epochMsSchema,
  javaRuntimeSchema,
  portSchema,
  serverIdSchema,
  tpsSourceSchema,
  ulidSchema,
} from '../common.js';

export const metricsConfigureSchema = z.object({
  /** Défaut 15 s ; 5 s = mode inspection temporaire, non persisté en brut. */
  intervalSec: z.int().positive(),
});

export const machineMetricsSchema = z.object({
  cpuPct: z.number().min(0).optional(),
  ramUsedMb: z.int().nonnegative().optional(),
  ramTotalMb: z.int().positive().optional(),
  diskUsedGb: z.number().nonnegative().optional(),
  diskTotalGb: z.number().positive().optional(),
});

export const serverMetricsSchema = z.object({
  serverId: serverIdSchema,
  cpuPct: z.number().min(0).optional(),
  rssMb: z.int().nonnegative().optional(),
  tps: z.number().min(0).optional(),
  mspt: z.number().min(0).optional(),
  /** Phase 7 : méthode ayant fourni `tps`/`mspt` (absente = indisponible, affiché franchement). */
  tpsSource: tpsSourceSchema.optional(),
  players: z.int().nonnegative().optional(),
});

export const metricsSampleSchema = z.object({
  ts: epochMsSchema,
  machine: machineMetricsSchema,
  servers: z.array(serverMetricsSchema),
  /** Spike n°2 : `ticks` ⇒ valeur potentiellement sous-évaluée (Windows sans PowerShell). */
  cpuSource: cpuSourceSchema.optional(),
});

export const watchdogAlertSchema = z.object({
  eventId: ulidSchema,
  serverId: serverIdSchema,
  ts: epochMsSchema,
  /** Phase 7 : `ram` = garde-fou mémoire (RSS très au-dessus de `maxRamMb`), action toujours `none`. */
  kind: z.enum(['crash', 'freeze', 'crash_loop', 'ram']),
  action: z.enum(['none', 'restart', 'kill_restart', 'gave_up']),
  attempt: z.int().nonnegative(),
  detail: z.string().optional(),
});

export const portConflictSchema = z.object({
  ts: epochMsSchema,
  port: portSchema,
  serverId: serverIdSchema.optional(),
  /** Processus détenteur si identifiable (nom/pid). */
  holder: z.string().optional(),
});

export const javaListResponseSchema = z.object({ runtimes: z.array(javaRuntimeSchema) });

/** Acquittement batché des événements critiques (doc 05 §6 « Tasks et événements fiables »). */
export const eventAckSchema = z.object({ eventIds: z.array(ulidSchema).min(1) });
