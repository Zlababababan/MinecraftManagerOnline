/** Console et logs (doc 05 §6 « Console et logs », §7 flux avec `seq`). */
import { z } from 'zod';

import { epochMsSchema, logLevelSchema, serverIdSchema } from '../common.js';

export const consoleLineSchema = z.object({
  seq: z.int().nonnegative(),
  ts: epochMsSchema,
  level: logLevelSchema,
  text: z.string(),
});
export type ConsoleLine = z.infer<typeof consoleLineSchema>;

export const consoleSubscribeSchema = z.object({
  serverId: serverIdSchema,
  sinceSeq: z.int().nonnegative().optional(),
});
export const consoleSubscribeResponseSchema = z.object({
  lines: z.array(consoleLineSchema),
  /** Trou trop grand pour le ring buffer : l'UI signale et complète via `logs.search`. */
  truncated: z.boolean(),
  oldestSeq: z.int().nonnegative().optional(),
  latestSeq: z.int().nonnegative(),
});

export const consoleLinesSchema = z.object({
  serverId: serverIdSchema,
  lines: z.array(consoleLineSchema).min(1),
});

export const logsSearchSchema = z.object({
  serverId: serverIdSchema,
  query: z.string().min(1),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  /** Restreint aux fichiers listés (`latest.log`, `2026-08-21-1.log.gz`…). */
  files: z.array(z.string()).optional(),
  limit: z.int().positive().optional(),
});
export const logsSearchResponseSchema = z.object({
  matches: z.array(
    z.object({
      file: z.string(),
      line: z.int().positive(),
      text: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

export const logsListFilesResponseSchema = z.object({
  files: z.array(
    z.object({
      name: z.string(),
      sizeBytes: z.int().nonnegative(),
      modifiedAt: epochMsSchema,
    }),
  ),
});
