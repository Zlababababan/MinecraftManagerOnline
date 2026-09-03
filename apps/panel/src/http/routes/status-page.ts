/**
 * Lot 8 — page de statut publique : le réglage par serveur (opérateur : lire, activer, publier ou
 * non les pseudos, changer de lien) et la SEULE route publique du lot, `GET /api/status/:token`.
 *
 * La route publique ne dit jamais pourquoi elle refuse : jeton inconnu, page désactivée, serveur
 * archivé ou supprimé donnent le même 404. Elle passe par le limiteur public par adresse, posé en
 * `preValidation` comme les autres surfaces anonymes — un scan de jetons doit coûter, même quand
 * les jetons sont mal formés.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { STATUS_TOKEN_LENGTH, statusPageInputSchema } from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { notFound } from '../../errors.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });
/** Le jeton a une longueur fixe : tout le reste est refusé sans requête. */
const tokenParams = z.object({
  token: z
    .string()
    .min(1)
    .max(STATUS_TOKEN_LENGTH * 2),
});

export function registerStatusPageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/servers/:id/status-page',
    { config: { role: 'operator' }, schema: { params: idParams } },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      return { statusPage: ctx.statusPages.configOf(row.id) ?? null };
    },
  );

  r.put(
    '/api/servers/:id/status-page',
    { config: { role: 'operator' }, schema: { params: idParams, body: statusPageInputSchema } },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      const statusPage = ctx.statusPages.set(row.id, request.body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.statusPage',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        // Jamais le jeton : le journal d'audit est lisible par tout administrateur, et le lien
        // qu'il contiendrait vaudrait accès sans expiration.
        details: { enabled: statusPage.enabled, showPlayers: statusPage.showPlayers },
      });
      return { statusPage };
    },
  );

  r.post(
    '/api/servers/:id/status-page/rotate',
    { config: { role: 'operator' }, schema: { params: idParams } },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      const statusPage = ctx.statusPages.rotate(row.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.statusPageRotated',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { enabled: statusPage.enabled },
      });
      return { statusPage };
    },
  );

  r.get(
    '/api/status/:token',
    {
      config: { public: true },
      schema: { params: tokenParams },
      preValidation: ctx.rateLimits.hook('status'),
    },
    async (request, reply) => {
      const status = await ctx.statusPages.status(request.params.token);
      if (status === undefined) throw notFound('status page');
      // Un cache partagé (proxy, navigateur) ne doit pas servir un état figé plus longtemps que
      // le cache du panel lui-même.
      return reply.header('cache-control', 'no-store').send({ status });
    },
  );
}
