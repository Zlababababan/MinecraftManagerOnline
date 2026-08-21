/**
 * Enveloppe des messages (doc 05 §2). Trois genres : `req` (attend une réponse), `res` (corrélée
 * par `re`), `event` (sans réponse). `ts` = epoch ms informatif, jamais un élément de sécurité.
 */
import { z } from 'zod';

import { epochMsSchema, ulidSchema } from './common.js';
import { protocolErrorSchema } from './errors.js';

const base = {
  v: z.int().positive(),
  type: z.string().min(1),
  ts: epochMsSchema,
};

export const requestEnvelopeSchema = z.object({
  ...base,
  kind: z.literal('req'),
  id: ulidSchema,
  deadlineMs: z.int().positive().optional(),
  /** Utilisateur initiateur côté panel (audit des deux côtés, doc 05 §12). */
  userId: z.string().optional(),
  payload: z.unknown(),
});

export const responseEnvelopeSchema = z.object({
  ...base,
  kind: z.literal('res'),
  re: ulidSchema,
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: protocolErrorSchema.optional(),
});

export const eventEnvelopeSchema = z.object({
  ...base,
  kind: z.literal('event'),
  /** Présent sur les événements critiques acquittables (`event.ack`). */
  id: ulidSchema.optional(),
  payload: z.unknown(),
});

export const envelopeSchema = z.discriminatedUnion('kind', [
  requestEnvelopeSchema,
  responseEnvelopeSchema,
  eventEnvelopeSchema,
]);

export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;
export type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type MessageKind = Envelope['kind'];
