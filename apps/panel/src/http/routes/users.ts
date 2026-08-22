/** Gestion des comptes (admin). */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { createUserSchema, updateUserSchema } from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { conflict } from '../../errors.js';
import { toUserDto } from '../../services/users.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/users', { config: { role: 'admin' } }, () => ({
    users: ctx.users.list().map(toUserDto),
  }));

  r.post(
    '/api/users',
    { config: { role: 'admin' }, schema: { body: createUserSchema } },
    async (request, reply) => {
      const user = await ctx.users.create(request.body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'user.created',
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.username,
        details: { role: user.role },
      });
      return reply.code(201).send({ user: toUserDto(user) });
    },
  );

  r.patch(
    '/api/users/:id',
    { config: { role: 'admin' }, schema: { params: idParams, body: updateUserSchema } },
    async (request) => {
      const me = requireUser(request);
      const { id } = request.params;
      const body = request.body;
      if (id === me.id && (body.role !== undefined || body.isActive === false)) {
        throw conflict('use another admin account to change your own role or status');
      }
      const user = await ctx.users.update(id, body);
      if (body.isActive === false || body.password !== undefined || body.role !== undefined) {
        ctx.sessions.revokeAllForUser(id);
        ctx.hub.disconnectUser(id);
      }
      ctx.audit.record({
        ...auditMeta(request),
        action: 'user.updated',
        targetType: 'user',
        targetId: id,
        targetLabel: user.username,
        details: { ...body, password: body.password === undefined ? undefined : '***' },
      });
      return { user: toUserDto(user) };
    },
  );

  r.delete(
    '/api/users/:id',
    { config: { role: 'admin' }, schema: { params: idParams } },
    (request, reply) => {
      const me = requireUser(request);
      const { id } = request.params;
      if (id === me.id) throw conflict('cannot delete your own account');
      const target = ctx.users.require(id);
      ctx.users.delete(id);
      ctx.hub.disconnectUser(id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'user.deleted',
        targetType: 'user',
        targetId: id,
        targetLabel: target.username,
      });
      return reply.code(204).send();
    },
  );
}
