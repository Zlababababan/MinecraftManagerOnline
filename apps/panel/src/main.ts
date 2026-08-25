/**
 * Point d'entrée du panel.
 *   MMO_DATA_DIR (défaut ./data) · MMO_HOST (défaut 127.0.0.1, jamais 0.0.0.0) · MMO_PORT (3000)
 *   MMO_COOKIE_SECURE (0/1, sinon déduit de panel.publicUrl) · MMO_MOJANG_MANIFEST (0 = table statique)
 *   MMO_WEB_DIR (défaut apps/web/dist : front servi avec fallback SPA si le dossier existe)
 *   MMO_DIST_DIR (défaut <data>/dist : archives d'installation de l'agent servies par le panel, phase 11)
 *   mmo-panel restore <fichier>   (phase 12 : restaure une sauvegarde `VACUUM INTO`, panel arrêté)
 */
import { buildApp } from './app.js';
import { configFromEnv } from './config.js';
import { restorePanelBackup } from './services/panel-backup.js';
import { createPanelLogStream } from './util/log-file.js';

const config = configFromEnv();

if (process.argv[2] === 'restore') {
  const file = process.argv[3];
  if (file === undefined) {
    console.error('usage: mmo-panel restore <fichier .db>');
    process.exit(2);
  }
  try {
    const result = restorePanelBackup(config.dataDir, file);
    console.log(`restored ${result.dbFile}`);
    if (result.previous !== undefined) console.log(`previous database kept as ${result.previous}`);
    process.exit(0);
  } catch (error) {
    console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
// Console + fichier `<data>/logs/panel-<date>.log` (14 jours conservés) : les lignes survivent
// à la fermeture de la fenêtre quand le panel est lancé à la main.
const logStream = createPanelLogStream(config.dataDir);
const { app, ctx } = await buildApp({
  config,
  logger: { level: process.env.MMO_LOG_LEVEL ?? 'info', stream: logStream },
}).catch((error: unknown) => {
  // Écueil réel (archive extraite avec sudo, panel lancé par un autre utilisateur) : le
  // SQLITE_CANTOPEN brut avec sa stack est incompréhensible — on explique le problème de droits.
  if ((error as { code?: string }).code === 'SQLITE_CANTOPEN') {
    console.error(
      `cannot open the database in ${config.dataDir} — make sure this folder exists and is ` +
        'writable by the current user (e.g. sudo chown -R "$USER" <panel folder>), or point ' +
        'MMO_DATA_DIR at a writable location.',
    );
    process.exit(1);
  }
  throw error;
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      dataDir: config.dataDir,
      webDir: config.webDir,
      users: ctx.users.count(),
      ...(logStream.file === undefined ? {} : { logFile: logStream.file }),
    },
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
