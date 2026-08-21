/**
 * @mmo/protocol — protocole panel↔agent (doc 05).
 * Phase 2 y ajoutera : enveloppe, codes d'erreur, schémas du jalon A, couche RPC typée.
 *
 * Règles (appliquées par ESLint) : jamais `.strict()` sur un schéma — le protocole évolue par ajout,
 * et un pair N/N-1 doit ignorer les champs qu'il ne connaît pas.
 */
import { z } from 'zod';

/** Version courante du protocole. Incrémentée uniquement sur rupture (doc 07, règle 3). */
export const PROTOCOL_VERSION = 1;

/** Versions qu'un panel sait parler : N et N-1. */
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const;

/** Timestamps : toujours epoch en millisecondes (décision verrouillée). */
export const epochMsSchema = z.int().nonnegative();
export type EpochMs = z.infer<typeof epochMsSchema>;
