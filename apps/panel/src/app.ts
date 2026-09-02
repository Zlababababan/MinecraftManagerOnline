/**
 * Construction de l'instance Fastify (sans écouter) : cookies, WebSocket, validation Zod, auth,
 * routes REST et WS. Utilisée par `main.ts` et par les tests (`inject`, `listen` sur port libre).
 */
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { ulid } from '@mmo/protocol';

import { defaultConfig, type PanelConfig } from './config.js';
import { registerAccessLog } from './http/access-log.js';
import { createContext, type AppContext, type ContextOptions } from './context.js';
import { registerAuth } from './http/auth.js';
import { registerErrorHandler } from './http/errors.js';
import { registerFileRoutes } from './http/routes/files.js';
import { registerGroupRoutes } from './http/routes/groups.js';
import { registerMachineRoutes } from './http/routes/machines.js';
import { registerMiscRoutes } from './http/routes/misc.js';
import { registerPhase9Routes } from './http/routes/phase9.js';
import { registerPhase10Routes } from './http/routes/phase10.js';
import { registerPhase11Routes } from './http/routes/phase11.js';
import { registerServerRoutes } from './http/routes/servers.js';
import { registerSetupAndAuthRoutes } from './http/routes/setup-auth.js';
import { registerTaskRoutes } from './http/routes/tasks.js';
import { registerSecurityHeaders } from './http/security.js';
import { registerStatic } from './http/static.js';
import { registerUserRoutes } from './http/routes/users.js';
import { registerWebhookRoutes } from './http/routes/webhooks.js';
import { registerWsRoutes } from './http/routes/ws.js';
import { runMaintenance } from './services/maintenance.js';

export interface AppOptions extends Partial<Omit<ContextOptions, 'config' | 'logger'>> {
  config?: Partial<PanelConfig>;
  /** `true` = pino vers stdout ; objet = options pino (`stream` : destination) ; défaut `false` (tests). */
  logger?: boolean | { level: string; stream?: { write(chunk: string): void } };
  /** Journal d'accès : seuil `warn` (défaut 1 s ; 0 en test pour forcer la branche lente). */
  accessLog?: { slowMs?: number };
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
    // Journal d'accès maison (`http/access-log.ts`) : une ligne par réponse, avec l'utilisateur et
    // la durée, plutôt que les deux lignes anonymes de Fastify.
    logController: new LogController({ disableRequestLogging: true }),
    // Identifiant de requête ULID : unique entre redémarrages (le défaut `req-N` ne l'est pas), et
    // c'est celui qu'une erreur 500 renvoie dans `details.requestId`.
    genReqId: () => ulid(),
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
    ...(options.schedulerTickMs === undefined ? {} : { schedulerTickMs: options.schedulerTickMs }),
    ...(options.transferReconnectWaitMs === undefined
      ? {}
      : { transferReconnectWaitMs: options.transferReconnectWaitMs }),
    ...(options.migrationTtlMs === undefined ? {} : { migrationTtlMs: options.migrationTtlMs }),
    ...(options.groupWait === undefined ? {} : { groupWait: options.groupWait }),
    ...(options.access === undefined ? {} : { access: options.access }),
    ...(options.logFile === undefined ? {} : { logFile: options.logFile }),
    ...(options.publicRateLimit === undefined ? {} : { publicRateLimit: options.publicRateLimit }),
    ...(options.backpressure === undefined ? {} : { backpressure: options.backpressure }),
    ...(options.webhooks === undefined ? {} : { webhooks: options.webhooks }),
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

  // Front buildé (si présent) : fichiers statiques + fallback SPA hors /api et /ws.
  const webServed = await registerStatic(app, config.webDir);
  registerErrorHandler(app, { spaFallback: webServed });
  registerSecurityHeaders(app, ctx);
  registerAuth(app, ctx);
  registerAccessLog(app, options.accessLog ?? {});
  registerMiscRoutes(app, ctx);
  registerSetupAndAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerMachineRoutes(app, ctx);
  registerServerRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerPhase9Routes(app, ctx);
  registerPhase10Routes(app, ctx);
  registerPhase11Routes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerWsRoutes(app, ctx);

  // Phase 10 : après `listen`, le listener HTTPS du mode direct délègue au serveur HTTP de Fastify.
  app.addHook('onListen', () => {
    ctx.access.start(app.server);
  });
  // Phase 11 : manifeste de distribution présent (archive du panel) → release d'agent publiée.
  await ctx.distribution.syncRelease().then(
    (published) => {
      if (published) logger.info('agent release published from distribution manifest');
    },
    (error: unknown) => {
      logger.warn({ err: error }, 'distribution manifest: release sync failed');
    },
  );

  // Maintenance horaire (doc 04 §8.3/§8.6) : purges par rétention, métriques, sauvegarde du
  // panel, compaction bornée, VACUUM hebdomadaire — voir `services/maintenance.ts`.
  const maintenance = setInterval(() => {
    try {
      runMaintenance(ctx);
    } catch (error) {
      logger.warn({ err: error }, 'maintenance failed');
    }
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();

  ctx.scheduler.start();

  // Alertes : évaluées bien plus souvent que la maintenance horaire — un serveur tombé doit se
  // savoir en minutes, pas au prochain passage de ménage. Le moteur est idempotent, un tick de
  // plus ne produit pas une notification de plus.
  const alertsTick = setInterval(() => {
    try {
      ctx.alerts.evaluate();
    } catch (error) {
      logger.warn({ err: error }, 'alerts evaluation failed');
    }
  }, ALERTS_INTERVAL_MS);
  alertsTick.unref();

  // Bannière « version X disponible » : timer dédié plutôt que `runMaintenance` — les tests
  // appellent runMaintenance directement et un appel au démarrage ferait sortir chaque panel de
  // test sur GitHub. Aucun panel de test ne vit 30 min ; le service s'auto-limite à 6 h.
  const updateTick = setInterval(() => {
    void ctx.updateCheck.checkIfStale().catch((error: unknown) => {
      logger.warn({ err: error }, 'panel update check failed');
    });
  }, UPDATE_TICK_MS);
  updateTick.unref();

  app.addHook('onClose', () => {
    clearInterval(maintenance);
    clearInterval(alertsTick);
    clearInterval(updateTick);
    ctx.close();
  });

  return {
    app,
    ctx,
    close: () => app.close(),
  };
}

/** Cadence d'évaluation des alertes : assez fine pour être utile, assez lâche pour être gratuite. */
const ALERTS_INTERVAL_MS = 60_000;
/** Cadence du tick de vérification de version (le service ne sort réellement qu'une fois par 6 h). */
const UPDATE_TICK_MS = 30 * 60_000;

export { runMaintenance };
