/**
 * Démarrage du panel : construction de l'application, écoute, arrêt propre.
 *
 * Séparé de `main.ts` pour que le point d'entrée puisse contrôler l'environnement AVANT d'importer
 * quoi que ce soit de l'application : sur un runtime inadapté, l'échec se produit pendant la
 * construction du graphe de modules, donc avant la première ligne exécutable — et l'utilisateur
 * n'a droit qu'à une stack.
 */
import { buildApp } from './app.js';
import type { PanelConfig } from './config.js';
import { DOCTOR_HINT } from './doctor.js';
import { createPanelLogStream } from './util/log-file.js';

export async function boot(config: PanelConfig): Promise<void> {
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
          `MMO_DATA_DIR at a writable location. ${DOCTOR_HINT}.`,
      );
      process.exit(1);
    }
    throw error;
  });

  if (config.allowAnyInterface) {
    app.log.warn(
      { host: config.host },
      'MMO_ALLOW_ANY_INTERFACE is set: the panel may listen on ALL interfaces — meant for containers, where port publishing is the access layer; anywhere else, prefer 127.0.0.1 and the access layer (doc §3)',
    );
  }

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
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(
        `${config.host}:${String(config.port)} is already in use — another panel is probably ` +
          `running, or set MMO_PORT. ${DOCTOR_HINT}.`,
      );
    }
    process.exit(1);
  }

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => {
      logStream.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}
