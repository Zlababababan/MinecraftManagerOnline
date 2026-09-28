/**
 * Intégration FTB (lot 5) — routes du catalogue de modpacks, **retirable** avec le reste de
 * l'intégration (docs/services-tiers.md). Réglage coupé : 404 `FEATURE_DISABLED`, aucun appel à FTB.
 *
 * Mêmes droits que le catalogue de versions : opérateur (créer un serveur l'exige de toute façon).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AppContext } from '../../context.js';

const listQuery = z.object({ q: z.string().max(80).default('') });
const packParams = z.object({ packId: z.coerce.number().int().positive() });

export function registerFtbRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/install/modpacks/ftb',
    { config: { role: 'operator' }, schema: { querystring: listQuery } },
    (request) => ctx.ftb.list(request.query.q),
  );

  r.get(
    '/api/install/modpacks/ftb/:packId',
    { config: { role: 'operator' }, schema: { params: packParams } },
    async (request) => ({ pack: await ctx.ftb.pack(request.params.packId) }),
  );
}
