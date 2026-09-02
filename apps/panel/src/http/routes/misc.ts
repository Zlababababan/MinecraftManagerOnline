/** Santé, événements, audit, réglages. */
import { statSync } from 'node:fs';

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

/** Dix ans : au-delà, la rétention est un « jamais » qui ne dit pas son nom. */
const MAX_RETENTION_DAYS = 3650;

/** Taille d'un fichier de base (WAL compris), 0 pour `:memory:` ou un fichier absent. */
function fileBytes(file: string): number {
  if (file === ':memory:') return 0;
  const size = (f: string): number => {
    try {
      return statSync(f).size;
    } catch {
      return 0;
    }
  };
  return size(file) + size(`${file}-wal`);
}

export function registerMiscRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/health', { config: { public: true } }, (request) => {
    const base = {
      ok: true,
      name: PROJECT_NAME,
      version: PANEL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      time: ctx.now(),
      agentsConnected: ctx.registry.all().length,
      sqlite: {
        driver: 'node:sqlite',
        version: (ctx.sqlite.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
      },
    };
    // Lot 9 : la sonde reste publique et inchangée (installeurs, Docker) ; le diagnostic — chemins,
    // tailles, dernier passage de maintenance — n'est servi qu'à une session administrateur.
    if (request.user?.role !== 'admin') return base;
    const d = ctx.diagnostics;
    return {
      ...base,
      diagnostics: {
        startedAt: d.startedAt,
        uptimeSec: Math.max(0, Math.round((ctx.now() - d.startedAt) / 1000)),
        logFile: d.logFile() ?? null,
        machines: { total: ctx.machines.list().length, connected: ctx.registry.all().length },
        databases: {
          mmo: { file: ctx.files.mmo, bytes: fileBytes(ctx.files.mmo) },
          metrics: { file: ctx.files.metrics, bytes: fileBytes(ctx.files.metrics) },
        },
        maintenance: d.lastMaintenance ?? null,
      },
    };
  });

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
        if (key.startsWith('retention.')) {
          // Jours entiers ≥ 1 : « 0 » viderait la table entière à la maintenance suivante.
          const days = Number(value.trim());
          if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
            throw new AppError(
              'E_VALIDATION',
              `${key} must be a whole number of days between 1 and ${String(MAX_RETENTION_DAYS)}`,
              { details: { key } },
            );
          }
          ctx.settings.set(key, String(days));
          continue;
        }
        if (key.startsWith('privacy.')) {
          // Booléens stricts : `getBool` lirait « yes » comme faux, en silence.
          if (value !== 'true' && value !== 'false') {
            throw new AppError('E_VALIDATION', `${key} must be 'true' or 'false'`, {
              details: { key },
            });
          }
          ctx.settings.set(key, value);
          continue;
        }
        ctx.settings.set(key, value);
      }
      ctx.audit.record({
        ...auditMeta(request),
        action: 'settings.updated',
        details: request.body,
      });
      // Couche d'accès réappliquée à chaud : activer la voie directe (ou changer de mode) arme les
      // timers DynDNS/renouvellement et le listener HTTPS sans redémarrer le panel.
      if (Object.keys(request.body).some((key) => key.startsWith('access.'))) {
        ctx.access.restart();
      }
      // Réglages poussés aux agents (restoreOnBoot, intervalle métriques).
      await Promise.all(ctx.registry.all().map((s) => s.pushConfig()));
      return { settings: ctx.settings.public() };
    },
  );
}
