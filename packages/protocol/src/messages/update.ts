/**
 * Phase 9 — mises à jour (doc 03 §3, doc 05 §9). Modèle unique : `agent.update` pousse le **bundle
 * JS universel** `{ version, url (servie par le panel), sha256, signature Ed25519 }`. L'agent vérifie
 * sha256 + signature (clé publique embarquée), écrit `versions/<v>/agent.js`, note `next.json`, sort
 * avec le code 75 ; le launcher bascule, health-check 30 s / 2 crashs, rollback N-1 automatique et
 * signalement par `agent.updateResult` (critique). `runtime.update` : archive Node par plateforme,
 * swap par le launcher au prochain redémarrage.
 */
import { z } from 'zod';

import { archSchema, epochMsSchema, osSchema, ulidSchema } from '../common.js';

export const agentUpdateSchema = z.object({
  version: z.string().min(1),
  /** URL absolue ou relative au panel (`/api/relay/<token>`). */
  url: z.string().min(1),
  sha256: z.string().length(64),
  /** Signature Ed25519 du bundle (base64). */
  signature: z.string().min(1),
  size: z.int().nonnegative().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Version Node recommandée avec ce bundle (information). */
  runtimeVersion: z.string().optional(),
});
export const agentUpdateResponseSchema = z.object({
  accepted: z.literal(true),
  /** Version courante au moment de l'acceptation. */
  currentVersion: z.string(),
  /** `true` si le bundle est déjà la version courante (rien à faire). */
  alreadyCurrent: z.boolean().default(false),
});

export const runtimeUpdateSchema = z.object({
  version: z.string().min(1),
  os: osSchema,
  arch: archSchema,
  url: z.string().min(1),
  sha256: z.string().length(64),
  archive: z.enum(['zip', 'tar.gz']),
  size: z.int().nonnegative().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export const runtimeUpdateResponseSchema = z.object({
  accepted: z.literal(true),
  currentVersion: z.string(),
  /** Le nouveau runtime sera utilisé au prochain redémarrage de l'agent. */
  pending: z.boolean(),
});

/** Issue d'une mise à jour (émis par l'agent après redémarrage, depuis `update-result.json`). */
export const agentUpdateResultSchema = z.object({
  eventId: ulidSchema,
  ts: epochMsSchema,
  kind: z.enum(['agent', 'runtime']),
  status: z.enum(['applied', 'rolled_back']),
  /** Version en place après l'opération. */
  version: z.string(),
  /** Version visée (rollback) ou précédente (applied). */
  otherVersion: z.string().optional(),
  /** `health_timeout` | `crash_loop` | … */
  reason: z.string().optional(),
});
