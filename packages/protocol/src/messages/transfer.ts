/**
 * Jalon C — transferts binaires (doc 05 §8). Contrôle en JSON (ces messages), données en frames
 * binaires sur le même WebSocket (`transfer/frame.ts`) : `[1 o version][16 o transferId]
 * [8 o offset u64 BE][données]`. Chunks 1 Mo, fenêtre 8 chunks non acquittés, reprise par offset,
 * SHA-256 du fichier complet vérifié à la fin (`fs.transfer.done`). Les offsets désignent toujours
 * la position dans le fichier **non compressé** (la compression est par chunk).
 */
import { z } from 'zod';

import { compressionSchema, epochMsSchema, serverIdSchema } from '../common.js';
import { relativePathSchema } from './fs.js';

/** 16 octets en hexadécimal (32 caractères). */
export const transferIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const TRANSFER_CHUNK_SIZE = 1024 * 1024;
export const TRANSFER_WINDOW_CHUNKS = 8;

/** Téléchargement (agent → panel) d'un fichier du serveur ou d'une archive de sauvegarde. */
export const fsDownloadStartSchema = z
  .object({
    transferId: transferIdSchema,
    serverId: serverIdSchema,
    path: relativePathSchema.optional(),
    backupId: z.string().min(1).optional(),
    /** Reprise : premier octet attendu. */
    offset: z.int().nonnegative().default(0),
    compression: compressionSchema.optional(),
    chunkSize: z
      .int()
      .positive()
      .max(8 * 1024 * 1024)
      .optional(),
  })
  .refine((v) => (v.path === undefined) !== (v.backupId === undefined), {
    message: 'exactly one of path / backupId expected',
  });
export const fsDownloadStartResponseSchema = z.object({
  size: z.int().nonnegative(),
  modifiedAt: epochMsSchema.optional(),
  chunkSize: z.int().positive(),
  compression: compressionSchema,
  /** Nom de fichier suggéré (archive de sauvegarde). */
  fileName: z.string().optional(),
});

/** Téléversement (panel → agent) dans le dossier du serveur ; `.part` nommé par `transferId`. */
export const fsUploadStartSchema = z.object({
  transferId: transferIdSchema,
  serverId: serverIdSchema,
  path: relativePathSchema,
  size: z.int().nonnegative(),
  overwrite: z.boolean().default(false),
  compression: compressionSchema.optional(),
  chunkSize: z
    .int()
    .positive()
    .max(8 * 1024 * 1024)
    .optional(),
});
export const fsUploadStartResponseSchema = z.object({
  /** Octets déjà reçus pour ce `transferId` (reprise) : l'émetteur repart de là. */
  offset: z.int().nonnegative(),
  chunkSize: z.int().positive(),
  compression: compressionSchema,
});

/** Acquittement du récepteur : tout est reçu jusqu'à `offset` exclu (non compressé). */
export const fsTransferAckSchema = z.object({
  transferId: transferIdSchema,
  offset: z.int().nonnegative(),
});

/** Fin d'émission : le récepteur vérifie taille et SHA-256 puis finalise (`E_CHECKSUM_MISMATCH` sinon). */
export const fsTransferDoneSchema = z.object({
  transferId: transferIdSchema,
  size: z.int().nonnegative(),
  sha256: z.string().length(64),
});
export const fsTransferDoneResponseSchema = z.object({ verified: z.literal(true) });

export const fsTransferCancelSchema = z.object({
  transferId: transferIdSchema,
  reason: z.string().optional(),
});
