/**
 * Point d'entrée du panel : contrôle de l'environnement, puis sous-commande.
 *
 *   mmo-panel                      démarre le panel
 *   mmo-panel doctor               diagnostic de l'installation (runtime, données, base, port)
 *   mmo-panel restore <fichier>    restaure une sauvegarde `VACUUM INTO`, panel arrêté
 *
 * Variables d'environnement :
 *   MMO_DATA_DIR (défaut ./data) · MMO_HOST (défaut 127.0.0.1, jamais 0.0.0.0) · MMO_PORT (3000)
 *   MMO_COOKIE_SECURE (0/1, sinon déduit de panel.publicUrl) · MMO_MOJANG_MANIFEST (0 = table statique)
 *   MMO_WEB_DIR (défaut apps/web/dist : front servi avec fallback SPA si le dossier existe)
 *   MMO_DIST_DIR (défaut <data>/dist : archives d'installation de l'agent servies par le panel)
 *
 * ⚠ Ce fichier ne doit RIEN importer de l'application au niveau module : sur un runtime trop
 * ancien, `node:sqlite` n'existe pas et le graphe de modules explose avant la première ligne
 * exécutable — l'utilisateur n'a alors qu'une stack de chargeur, sans même un journal. Tout le
 * reste est chargé par `await import()`, après le contrôle ci-dessous.
 */
import { configFromEnv } from './config.js';

const MIN_NODE_MAJOR = 24;

if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
  console.error(
    `node ${process.versions.node} is too old: the panel needs node ${String(MIN_NODE_MAJOR)}+ ` +
      '(node:sqlite). Start it with the runtime shipped in the archive — mmo-panel.cmd on ' +
      'Windows, ./mmo-panel.sh on Linux and macOS — rather than a system node.',
  );
  process.exit(2);
}

const config = configFromEnv();
const command = process.argv[2];

if (command === 'doctor') {
  const { doctor } = await import('./doctor.js');
  process.exit(await doctor(config));
}

if (command === 'restore') {
  const file = process.argv[3];
  if (file === undefined) {
    console.error('usage: mmo-panel restore <fichier .db>');
    process.exit(2);
  }
  const { restorePanelBackup } = await import('./services/panel-backup.js');
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

if (command !== undefined && !command.startsWith('-')) {
  console.error(`unknown command: ${command}\nusage: mmo-panel [doctor | restore <fichier .db>]`);
  process.exit(2);
}

const { boot } = await import('./boot.js');
await boot(config);
