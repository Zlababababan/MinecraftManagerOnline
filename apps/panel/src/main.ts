/**
 * Point d'entrée du panel.
 *   MMO_DATA_DIR (défaut ./data) · MMO_HOST (défaut 127.0.0.1, jamais 0.0.0.0) · MMO_PORT (3000)
 *   MMO_COOKIE_SECURE (0/1, sinon déduit de panel.publicUrl) · MMO_MOJANG_MANIFEST (0 = table statique)
 *   MMO_WEB_DIR (défaut apps/web/dist : front servi avec fallback SPA si le dossier existe)
 *   MMO_DIST_DIR (défaut <data>/dist : archives d'installation de l'agent servies par le panel, phase 11)
 */
import { buildApp } from './app.js';
import { configFromEnv } from './config.js';

const config = configFromEnv();
const { app, ctx } = await buildApp({
  config,
  logger: { level: process.env.MMO_LOG_LEVEL ?? 'info' },
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { dataDir: config.dataDir, webDir: config.webDir, users: ctx.users.count() },
    ctx.users.count() === 0
      ? 'first run: open the panel to create the admin account'
      : 'panel ready',
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

const shutdown = (signal: string): void => {
  app.log.info({ signal }, 'shutting down');
  void app.close().then(() => {
    process.exit(0);
  });
};
process.once('SIGINT', () => {
  shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});
