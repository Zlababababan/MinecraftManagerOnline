/**
 * Lot 5 — créer un serveur depuis le panel.
 *
 * **Qui a le droit ?** (le huitième chantier du lot 8, tranché ici parce que c'est le lot 5 qui
 * pose la question.) Créer un serveur exige le rôle **opérateur sur la MACHINE** : les routes
 * vivent sous `/api/machines/:id`, donc la portée par machine du lot 8 s'y applique telle quelle,
 * et une machine accordée couvre déjà ses serveurs présents **et futurs** — celui qu'on crée est
 * exactement l'un d'eux. Une portée limitée à des serveurs ne donne aucun droit de création.
 *
 * Ce qui rend ce droit sûr, c'est que le chemin n'est pas libre : l'appelant choisit un
 * **répertoire surveillé** de la machine et un **nom de dossier**, le panel compose le reste.
 * `POST /api/servers` (adopter un dossier arbitraire) reste réservé aux administrateurs : lui
 * donne un jail de fichiers sur un chemin choisi, ce qui est une tout autre autorisation.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  createInstallSchema,
  installLoaderSchema,
  installPrecheckRequestSchema,
} from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });
const catalogQuery = z.object({ loader: installLoaderSchema });

export function registerInstallRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Versions installables, telles que les fournisseurs les publient (cache côté panel). */
  r.get(
    '/api/install/catalog',
    { config: { role: 'operator' }, schema: { querystring: catalogQuery } },
    async (request) => ({
      loader: request.query.loader,
      versions: await ctx.installCatalog.versions(request.query.loader),
    }),
  );

  /** Ce que l'assistant montre avant de s'engager : chemin final, port, place, JRE. */
  r.post(
    '/api/machines/:id/install/precheck',
    {
      config: { role: 'operator' },
      schema: { params: idParams, body: installPrecheckRequestSchema },
    },
    async (request) => ({
      precheck: await ctx.installs.precheck({ ...request.body, machineId: request.params.id }),
    }),
  );

  r.post(
    '/api/machines/:id/install',
    { config: { role: 'operator' }, schema: { params: idParams, body: createInstallSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const { server, taskId } = await ctx.installs.create(
        { ...request.body, machineId: request.params.id },
        user.id,
      );
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.install',
        targetType: 'server',
        targetId: server.id,
        targetLabel: server.name,
        details: {
          machineId: server.machineId,
          path: server.path,
          loader: server.loader,
          mcVersion: server.mcVersion,
          loaderVersion: server.loaderVersion,
          // Qui a accepté l'EULA, et quand : c'est le seul endroit où cela se lit après coup.
          eulaAcceptedBy: user.username,
          taskId,
        },
      });
      return reply
        .code(202)
        .send({ server: ctx.servers.toDto(server, ctx.registry.isConnected(server.machineId)) });
    },
  );

  /** Rejoue le plan d'une installation ratée ou interrompue, dans le dossier tel qu'il est. */
  r.post(
    '/api/servers/:id/install/retry',
    { config: { role: 'operator' }, schema: { params: idParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      const { taskId } = await ctx.installs.repair(row.id, user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.installRetry',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { taskId },
      });
      return reply.code(202).send({ taskId });
    },
  );
}
