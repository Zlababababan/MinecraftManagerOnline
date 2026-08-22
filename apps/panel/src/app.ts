/**
 * Construction de l'instance Fastify (sans écouter) : cookies, WebSocket, validation Zod, auth,
 * routes REST et WS. Utilisée par `main.ts` et par les tests (`inject`, `listen` sur port libre).
 */
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { defaultConfig, type PanelConfig } from './config.js';
import { createContext, type AppContext, type ContextOptions } from './context.js';
import { registerAuth } from './http/auth.js';
import { registerErrorHandler } from './http/errors.js';
import { registerFileRoutes } from './http/routes/files.js';
import { registerMachineRoutes } from './http/routes/machines.js';
import { registerMiscRoutes } from './http/routes/misc.js';
import { registerServerRoutes } from './http/routes/servers.js';
import { registerSetupAndAuthRoutes } from './http/routes/setup-auth.js';
import { registerTaskRoutes } from './http/routes/tasks.js';
import { registerStatic } from './http/static.js';
import { registerUserRoutes } from './http/routes/users.js';
import { registerWsRoutes } from './http/routes/ws.js';

export interface AppOptions extends Partial<Omit<ContextOptions, 'config' | 'logger'>> {
  config?: Partial<PanelConfig>;
  /** `true` = pino vers stdout ; objet = options pino ; défaut `false` (tests). */
  logger?: boolean | { level: string };
}

export interface PanelApp {
  app: FastifyInstance;
  ctx: AppContext;
  close(): Promise<void>;
}

const MAINTENANCE_INTERVAL_MS = 3_600_000;

export async function buildApp(options: AppOptions = {}): Promise<PanelApp> {
  const config = defaultConfig(options.config);
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: 'loopback',
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const logger: FastifyBaseLogger = app.log;
  const ctx = createContext({
    config,
    logger,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.dbFile === undefined ? {} : { dbFile: options.dbFile }),
    ...(options.metricsFile === undefined ? {} : { metricsFile: options.metricsFile }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

  // Front buildé (si présent) : fichiers statiques + fallback SPA hors /api et /ws.
  const webServed = await registerStatic(app, config.webDir);
  registerErrorHandler(app, { spaFallback: webServed });
  registerAuth(app, ctx);
  registerMiscRoutes(app, ctx);
  registerSetupAndAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerMachineRoutes(app, ctx);
  registerServerRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerWsRoutes(app, ctx);

  // Purges planifiées (doc 04 §8.6) : sessions, codes d'appairage, événements, audit, dédup.
  const maintenance = setInterval(() => {
    try {
      runMaintenance(ctx);
    } catch (error) {
      logger.warn({ err: error }, 'maintenance failed');
    }
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();

  ctx.scheduler.start();

  app.addHook('onClose', () => {
    clearInterval(maintenance);
    ctx.close();
  });

  return {
    app,
    ctx,
    close: () => app.close(),
  };
}

export function runMaintenance(ctx: AppContext): void {
  const day = 24 * 3_600_000;
  const t = ctx.now();
  ctx.sessions.purgeExpired();
  ctx.machines.purgeExpiredPairingCodes();
  ctx.processed.purgeOlderThan(t - day);
  ctx.events.purgeOlderThan(t - ctx.settings.getInt('retention.eventsDays', 90) * day);
  ctx.audit.purgeOlderThan(t - ctx.settings.getInt('retention.auditDays', 365) * day);
  ctx.tasks.purgeOlderThan(t - 30 * day);
  ctx.sqlite.pragma('wal_checkpoint(PASSIVE)');
  // Sauvegarde quotidienne du panel lui-même (`VACUUM INTO`, doc 07 phase 8).
  try {
    ctx.panelBackup.backupIfStale();
  } catch (error) {
    ctx.logger.warn({ err: error }, 'panel self-backup failed');
  }
  // Métriques (doc 04 §7) : downsampling brut → 1 min → 1 h, purge, checkpoint du second fichier.
  ctx.metricsService.maintain(t);
  ctx.metricsSqlite.pragma('wal_checkpoint(PASSIVE)');
}
