/**
 * Gestion des comptes (admin). Lot 8 : `scoped` et les portées accordées
 * (`GET|PUT /api/users/:id/grants`) — un compte limité ne voit que ses serveurs et machines.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { createUserSchema, updateUserSchema, userGrantsInputSchema } from '@mmo/protocol/client';

import { CLOSE_PERMISSIONS_CHANGED } from '../../clients/hub.js';
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
        details: { role: user.role, scoped: user.scoped === 1 },
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
      if (
        id === me.id &&
        (body.role !== undefined || body.isActive === false || body.scoped !== undefined)
      ) {
        throw conflict('use another admin account to change your own role or status');
      }
      const user = await ctx.users.update(id, body);
      // Rôle abaissé : les portées accordées au-dessus redescendent avec lui.
      if (body.role !== undefined) {
        ctx.permissions.clampToRole(id, body.role);
        // Ses clés d'API aussi : une clé ne garde jamais un rôle que son propriétaire n'a plus.
        ctx.apiKeys.clampToRole(id, body.role);
      }
      if (
        body.isActive === false ||
        body.password !== undefined ||
        body.role !== undefined ||
        body.scoped !== undefined
      ) {
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

  /** Lot 8 : déconnecter un compte de tous ses appareils (mot de passe compromis, ami parti). */
  r.delete(
    '/api/users/:id/sessions',
    { config: { role: 'admin' }, schema: { params: idParams } },
    (request, reply) => {
      const { id } = request.params;
      const target = ctx.users.require(id);
      ctx.sessions.revokeAllForUser(id);
      ctx.hub.disconnectUser(id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'user.sessionsRevoked',
        targetType: 'user',
        targetId: id,
        targetLabel: target.username,
      });
      return reply.code(204).send();
    },
  );

  // --- Lot 8 : portées accordées à un compte limité --------------------------------------------

  r.get(
    '/api/users/:id/grants',
    { config: { role: 'admin' }, schema: { params: idParams } },
    (request) => {
      ctx.users.require(request.params.id);
      return { grants: ctx.permissions.grantsOf(request.params.id) };
    },
  );

  r.put(
    '/api/users/:id/grants',
    { config: { role: 'admin' }, schema: { params: idParams, body: userGrantsInputSchema } },
    (request) => {
      const { id } = request.params;
      const target = ctx.users.require(id);
      const grants = ctx.permissions.setGrants(
        id,
        request.body,
        (serverId) => ctx.servers.get(serverId) !== undefined,
      );
      // Ses navigateurs se reconnectent aussitôt : listes relues, abonnements console rejugés.
      ctx.hub.disconnectUser(id, 'permissions changed', CLOSE_PERMISSIONS_CHANGED);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'user.grantsUpdated',
        targetType: 'user',
        targetId: id,
        targetLabel: target.username,
        details: { servers: grants.servers, machines: grants.machines },
      });
      return { grants };
    },
  );
}
