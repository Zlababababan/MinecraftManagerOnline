/**
 * Groupes de démarrage (lot 7) : CRUD (admin) + action ordonnée start/stop/restart (operator,
 * 202 — l'exécution est séquentielle en arrière-plan, les états serveurs diffusés par le hub en
 * donnent la progression). L'appartenance se règle par `PATCH /api/servers/:id`.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { groupActionSchema, serverGroupInputSchema } from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { forbidden } from '../../errors.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });

export function registerGroupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/groups', () => ({
    groups: ctx.groups.list().map((g) => ctx.groups.toDto(g)),
  }));

  r.post(
    '/api/groups',
    { config: { role: 'admin' }, schema: { body: serverGroupInputSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = ctx.groups.create(request.body.name, user.id);
      return reply.code(201).send({ group: ctx.groups.toDto(row) });
    },
  );

  r.patch(
    '/api/groups/:id',
    { config: { role: 'admin' }, schema: { params: idParams, body: serverGroupInputSchema } },
    (request) => {
      const user = requireUser(request);
      const row = ctx.groups.rename(request.params.id, request.body.name, user.id);
      return { group: ctx.groups.toDto(row) };
    },
  );

  r.delete(
    '/api/groups/:id',
    { config: { role: 'admin' }, schema: { params: idParams } },
    async (request, reply) => {
      const user = requireUser(request);
      ctx.groups.delete(request.params.id, user.id);
      return reply.code(204).send();
    },
  );

  r.post(
    '/api/groups/:id/action',
    {
      config: { role: 'operator' },
      schema: { params: idParams, body: groupActionSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const group = ctx.groups.require(request.params.id);
      // Lot 8 : l'action touche chaque serveur du groupe — il faut être opérateur sur chacun.
      const snapshot = ctx.permissions.snapshotFor(user);
      const members = ctx.servers.listByGroup(group.id);
      if (
        !members.every((s) =>
          ctx.permissions.can(snapshot, { kind: 'server', id: s.id }, 'operator'),
        )
      ) {
        throw forbidden('role operator required on every server of the group');
      }
      ctx.groups.run(group.id, request.body.action, user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: `group.${request.body.action}`,
        targetType: 'group',
        targetId: group.id,
        targetLabel: group.name,
        details: { servers: ctx.servers.listByGroup(group.id).map((s) => s.id) },
      });
      return reply.code(202).send({ accepted: true });
    },
  );
}
