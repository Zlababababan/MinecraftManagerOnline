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

import {
  STATUS_TOKEN_LENGTH,
  statusPageInputSchema,
  whitelistRequestInputSchema,
} from '@mmo/protocol/client';

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
        details: {
          enabled: statusPage.enabled,
          showPlayers: statusPage.showPlayers,
          allowWhitelist: statusPage.allowWhitelist,
        },
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

  /**
   * Demande de whitelist en libre-service (lot 8). Deuxième et dernière route anonyme du lot :
   * elle réutilise le jeton de la page de statut plutôt que d'ouvrir une surface de plus, et son
   * limiteur est bien plus serré que la lecture (dix par minute et par adresse) — c'est une
   * écriture. Elle n'appelle ni l'agent ni Mojang : elle range une ligne, rien d'autre.
   */
  r.post(
    '/api/status/:token/whitelist',
    {
      config: { public: true },
      schema: { params: tokenParams, body: whitelistRequestInputSchema },
      preValidation: ctx.rateLimits.hook('whitelist'),
    },
    (request, reply) => {
      const server = ctx.statusPages.resolveForWhitelist(request.params.token);
      if (server === undefined) throw notFound('status page');
      const state = ctx.whitelistRequests.submit(server, request.body);
      return reply.header('cache-control', 'no-store').send({ state });
    },
  );
}
