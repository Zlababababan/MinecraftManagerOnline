/**
 * Lot 8 — le côté opérateur des demandes de whitelist en libre-service : lister, accepter,
 * refuser, oublier. La saisie, elle, est anonyme et vit dans `routes/status-page.ts`.
 *
 * Accepter est le SEUL moment où quelque chose bouge sur le serveur, et cela passe par la chaîne
 * existante : `player.action whitelistAdd`, que l'agent route lui-même — commande RCON/stdin si le
 * serveur tourne, `whitelist.json` sinon, avec la résolution du pseudo qu'il fait déjà (usercache,
 * Mojang si `privacy.mojangLookup` l'autorise, UUID hors ligne sinon). Rien n'est réécrit ici.
 *
 * L'ordre compte : l'action d'abord, la décision ensuite. Si l'agent est absent ou refuse, la
 * demande reste en attente — une ligne « acceptée » dont personne ne serait sur la liste blanche
 * serait un mensonge que l'opérateur ne découvrirait qu'à la connexion de son ami.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AppContext } from '../../context.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const params = z.object({ id: z.string().min(1), requestId: z.string().min(1) });

export function registerWhitelistRequestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/servers/:id/whitelist-requests',
    { schema: { params: z.object({ id: z.string().min(1) }) } },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      return { requests: ctx.whitelistRequests.list(row.id) };
    },
  );

  r.post(
    '/api/servers/:id/whitelist-requests/:requestId/accept',
    { config: { role: 'operator' }, schema: { params } },
    async (request) => {
      const user = requireUser(request);
      const server = ctx.servers.require(request.params.id);
      const pending = ctx.whitelistRequests.require(server.id, request.params.requestId);
      const res = await ctx.registry
        .require(server.machineId)
        .peer.request(
          'player.action',
          { serverId: server.id, action: 'whitelistAdd', target: pending.name },
          { userId: user.id },
        );
      const decided = ctx.whitelistRequests.decide(server.id, pending.id, 'accepted', user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'whitelist.accepted',
        targetType: 'server',
        targetId: server.id,
        targetLabel: server.name,
        details: { name: pending.name, applied: res.applied, warnings: res.warnings },
      });
      return { request: decided, applied: res.applied, warnings: res.warnings };
    },
  );

  r.post(
    '/api/servers/:id/whitelist-requests/:requestId/reject',
    { config: { role: 'operator' }, schema: { params } },
    (request) => {
      const user = requireUser(request);
      const server = ctx.servers.require(request.params.id);
      const pending = ctx.whitelistRequests.require(server.id, request.params.requestId);
      const decided = ctx.whitelistRequests.decide(server.id, pending.id, 'rejected', user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'whitelist.rejected',
        targetType: 'server',
        targetId: server.id,
        targetLabel: server.name,
        details: { name: pending.name },
      });
      return { request: decided };
    },
  );

  /** Oublier une demande : elle disparaît de la liste, et la personne peut en refaire une. */
  r.delete(
    '/api/servers/:id/whitelist-requests/:requestId',
    { config: { role: 'operator' }, schema: { params } },
    (request, reply) => {
      const server = ctx.servers.require(request.params.id);
      const removed = ctx.whitelistRequests.remove(server.id, request.params.requestId);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'whitelist.requestDeleted',
        targetType: 'server',
        targetId: server.id,
        targetLabel: server.name,
        details: { name: removed.name, status: removed.status },
      });
      return reply.code(204).send();
    },
  );
}
