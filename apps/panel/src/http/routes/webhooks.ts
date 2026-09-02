/**
 * Lot 4 — webhooks sortants (admin) : liste, création (secret renvoyé UNE fois pour le genre
 * `json`), modification, suppression, envoi de test, rotation du secret. La garde SSRF s'applique
 * à la saisie (400 `E_VALIDATION`, `details.reason` traduit par l'UI) et à chaque envoi
 * (`services/webhooks.ts`). L'audit ne consigne que l'URL masquée, jamais le secret.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { webhookCreateSchema, webhookPatchSchema } from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/webhooks', { config: { role: 'admin' } }, () => ({
    webhooks: ctx.webhooks.list(),
  }));

  r.post(
    '/api/webhooks',
    { config: { role: 'admin' }, schema: { body: webhookCreateSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const { webhook, secret } = await ctx.webhooks.create(request.body, {
        locale: user.locale,
      });
      ctx.audit.record({
        ...auditMeta(request),
        action: 'webhook.created',
        targetType: 'webhook',
        targetId: webhook.id,
        targetLabel: webhook.name,
        details: { kind: webhook.kind, url: webhook.url, types: webhook.types },
      });
      return reply.code(201).send({ webhook, secret });
    },
  );

  r.patch(
    '/api/webhooks/:id',
    { config: { role: 'admin' }, schema: { params: idParams, body: webhookPatchSchema } },
    async (request) => {
      const webhook = await ctx.webhooks.update(request.params.id, request.body);
      const { url: _url, ...rest } = request.body;
      ctx.audit.record({
        ...auditMeta(request),
        action: 'webhook.updated',
        targetType: 'webhook',
        targetId: webhook.id,
        targetLabel: webhook.name,
        details: { ...rest, ...(request.body.url === undefined ? {} : { url: webhook.url }) },
      });
      return { webhook };
    },
  );

  r.delete(
    '/api/webhooks/:id',
    { config: { role: 'admin' }, schema: { params: idParams } },
    (request) => {
      const webhook = ctx.webhooks.get(request.params.id);
      ctx.webhooks.remove(webhook.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'webhook.deleted',
        targetType: 'webhook',
        targetId: webhook.id,
        targetLabel: webhook.name,
      });
      return { removed: true };
    },
  );

  r.post(
    '/api/webhooks/:id/test',
    { config: { role: 'admin' }, schema: { params: idParams } },
    async (request) => {
      const result = await ctx.webhooks.test(request.params.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'webhook.tested',
        targetType: 'webhook',
        targetId: request.params.id,
        details: { ok: result.ok, status: result.status, error: result.error },
      });
      return { result };
    },
  );

  r.post(
    '/api/webhooks/:id/secret',
    { config: { role: 'admin' }, schema: { params: idParams } },
    (request) => {
      const secret = ctx.webhooks.rotateSecret(request.params.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'webhook.secretRotated',
        targetType: 'webhook',
        targetId: request.params.id,
      });
      return { secret };
    },
  );
}
