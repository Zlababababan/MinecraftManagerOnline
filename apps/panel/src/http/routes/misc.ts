/** Santé, événements, audit, réglages. */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { PROTOCOL_VERSION } from '@mmo/protocol';
import {
  eventsQuerySchema,
  settingsPatchSchema,
  uiEventsPostSchema,
  uiEventsQuerySchema,
} from '@mmo/protocol/client';
import { PROJECT_NAME } from '@mmo/shared';

import type { AppContext } from '../../context.js';
import { AppError } from '../../errors.js';
import { coerceOrigin } from '../../util/origin.js';
import { PANEL_VERSION } from '../../version.js';
import { auditMeta } from './setup-auth.js';

export function registerMiscRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/health', { config: { public: true } }, () => ({
    ok: true,
    name: PROJECT_NAME,
    version: PANEL_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    time: ctx.now(),
    agentsConnected: ctx.registry.all().length,
  }));

  r.get('/api/events', { schema: { querystring: eventsQuerySchema } }, (request) => ({
    events: ctx.events.list(request.query),
  }));

  r.get(
    '/api/audit',
    {
      config: { role: 'admin' },
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().positive().max(1000).optional() }),
      },
    },
    (request) => ({ audit: ctx.audit.list(request.query.limit ?? 200) }),
  );

  // Parcours UI : ingestion par lots (tout utilisateur connecté), lecture admin (diagnostic).
  r.post('/api/ui-events', { schema: { body: uiEventsPostSchema } }, (request, reply) => {
    ctx.uiEvents.record(
      { userId: request.user?.id ?? null, username: request.user?.username ?? null },
      request.body.events,
    );
    return reply.code(204).send();
  });

  r.get(
    '/api/ui-events',
    { config: { role: 'admin' }, schema: { querystring: uiEventsQuerySchema } },
    (request) => ({ events: ctx.uiEvents.list(request.query.limit ?? 200) }),
  );

  r.get('/api/settings', { config: { role: 'admin' } }, () => ({
    settings: ctx.settings.public(),
  }));

  r.patch(
    '/api/settings',
    { config: { role: 'admin' }, schema: { body: settingsPatchSchema } },
    async (request) => {
      for (const [key, value] of Object.entries(request.body)) {
        if (key === 'panel.publicUrl') {
          // Origine stricte (injectée dans les scripts d'installation et les push) ; vide = effacer.
          const origin = value.trim() === '' ? '' : coerceOrigin(value);
          if (origin === undefined) {
            throw new AppError('E_VALIDATION', 'panel.publicUrl must be an http(s) origin', {
              details: { key },
            });
          }
          ctx.settings.set(key, origin);
          continue;
        }
        ctx.settings.set(key, value);
      }
      ctx.audit.record({
        ...auditMeta(request),
        action: 'settings.updated',
        details: request.body,
      });
      // Réglages poussés aux agents (restoreOnBoot, intervalle métriques).
      await Promise.all(ctx.registry.all().map((s) => s.pushConfig()));
      return { settings: ctx.settings.public() };
    },
  );
}
