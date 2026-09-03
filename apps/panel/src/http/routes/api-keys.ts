/**
 * Clés d'API (lot 8) : chaque compte gère les siennes, un administrateur voit et révoque celles
 * de tout le monde. Ces routes exigent une SESSION (cookie) : une clé ne crée ni ne révoque de clé
 * — le hook d'auth le garantit (`sessionOnly`).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { apiKeyCreateSchema } from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { forbidden, notFound } from '../../errors.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });

export function registerApiKeyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/api-keys',
    { schema: { querystring: z.object({ all: z.enum(['true', 'false']).optional() }) } },
    (request) => {
      const user = requireUser(request);
      if (request.query.all === 'true') {
        if (user.role !== 'admin') throw forbidden('role admin required');
        return { keys: ctx.apiKeys.listAll() };
      }
      return { keys: ctx.apiKeys.listOf(user.id) };
    },
  );

  r.post('/api/api-keys', { schema: { body: apiKeyCreateSchema } }, (request, reply) => {
    const user = requireUser(request);
    const { key, token } = ctx.apiKeys.create(user, request.body);
    ctx.audit.record({
      ...auditMeta(request),
      action: 'apikey.created',
      targetType: 'apiKey',
      targetId: key.id,
      targetLabel: key.name,
      // Jamais le jeton : le préfixe suffit à reconnaître la clé dans les listes.
      details: { prefix: key.prefix, role: key.role, expiresAt: key.expiresAt },
    });
    return reply.code(201).send({ key, token });
  });

  r.delete('/api/api-keys/:id', { schema: { params: idParams } }, (request, reply) => {
    const user = requireUser(request);
    const { id } = request.params;
    const row = ctx.apiKeys.get(id);
    // La clé d'un autre compte n'existe pas pour qui n'est pas administrateur (aucune énumération).
    if (!row || (row.userId !== user.id && user.role !== 'admin')) throw notFound('apiKey', id);
    ctx.apiKeys.revoke(id);
    ctx.audit.record({
      ...auditMeta(request),
      action: 'apikey.revoked',
      targetType: 'apiKey',
      targetId: id,
      targetLabel: row.name,
      details: { prefix: row.prefix, ownerId: row.userId },
    });
    return reply.code(204).send();
  });
}
