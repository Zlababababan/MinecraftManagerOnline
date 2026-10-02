/**
 * Les actions REFUSÉES entrent dans l'audit (demande de Yassin, 02/10 : « il faut vraiment tout
 * enregistrer »). Avant, seul un succès laissait une trace : un démarrage refusé parce que le port
 * était pris, une écriture interdite, une saisie invalide n'apparaissaient nulle part, et il
 * fallait deviner ce qui avait été tenté.
 *
 * Une ligne `request.refused` par requête qui modifie quelque chose (tout sauf GET/HEAD/OPTIONS)
 * et que le panel a rejetée (statut ≥ 400) : méthode, motif de route, statut, code d'erreur et ses
 * détails. Le corps de la requête n'est pas recopié (il peut contenir un mot de passe).
 */
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import { auditMeta } from './routes/setup-auth.js';

/** Envoyés par le navigateur en continu, ou déjà audités à part (`auth.loginFailed`). */
const SKIPPED = new Set(['/api/ui-events', '/api/auth/login']);
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_DETAILS = 1500;

export function registerRefusalAudit(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    const route = request.routeOptions.url;
    if (
      reply.statusCode >= 400 &&
      !READ_ONLY.has(request.method) &&
      route !== undefined &&
      route.startsWith('/api/') &&
      !SKIPPED.has(route)
    ) {
      let code: unknown;
      let details: unknown;
      if (typeof payload === 'string') {
        try {
          const body = JSON.parse(payload) as { code?: unknown; details?: unknown };
          code = body.code;
          details = body.details;
        } catch {
          // Réponse non JSON : le statut suffit.
        }
      }
      const params = request.params as Record<string, unknown> | undefined;
      const targetId = typeof params?.id === 'string' ? params.id : undefined;
      const text = details === undefined ? undefined : JSON.stringify(details);
      try {
        ctx.audit.record({
          ...auditMeta(request),
          action: 'request.refused',
          ...(targetId === undefined ? {} : { targetId }),
          details: {
            method: request.method,
            route,
            status: reply.statusCode,
            ...(typeof code === 'string' ? { code } : {}),
            ...(text === undefined || text.length > MAX_DETAILS ? {} : { details }),
          },
        });
      } catch (error) {
        // L'audit d'un refus ne doit jamais transformer ce refus en erreur 500.
        request.log.warn({ err: error }, 'refusal audit failed');
      }
    }
    done(null, payload);
  });
}
