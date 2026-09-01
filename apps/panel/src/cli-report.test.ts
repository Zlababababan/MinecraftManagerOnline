/**
 * `mmo-panel report` : ce fichier finit sur une issue PUBLIQUE. Les tests portent donc d'abord sur
 * ce qui ne doit pas en sortir — secrets de réglages, chemins personnels, jetons, codes
 * d'appairage, adresses complètes — puis sur le fait que ce qui sert au support y est bien.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildReport, maskLine } from './cli-report.js';
import type { PanelConfig } from './config.js';
import { openSqliteFile } from './db/sqlite.js';

function config(dataDir: string): PanelConfig {
  return {
    dataDir,
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalSec: 15,
    offlineAfterMs: 40_000,
    sessionTtlMs: 1000,
    cookieSecure: undefined,
    mojangManifest: false,
    webDir: undefined,
  } as PanelConfig;
}

/** Une base minimale : le rapport lit en SQL, il n'a besoin que de ces trois tables. */
function seedDatabase(dataDir: string): void {
  const db = openSqliteFile(path.join(dataDir, 'mmo.db'));
  db.exec(`
    CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT, os TEXT, arch TEXT, hostname TEXT,
      agent_version TEXT, protocol_version INTEGER, runtime_version TEXT, status TEXT,
      last_seen_at INTEGER, panel_url TEXT);
    CREATE TABLE servers (id TEXT PRIMARY KEY, machine_id TEXT, name TEXT, path TEXT, loader TEXT,
      mc_version TEXT, provisioning TEXT, desired_state TEXT, run_state TEXT, port INTEGER,
      rcon_enabled INTEGER, detected INTEGER);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    INSERT INTO machines VALUES ('mac_1','Tour du salon','windows','x64','PC-JEAN','1.0.6',1,
      '24.19.0','online',1788000000000,'https://direct.example.net');
    INSERT INTO servers VALUES ('srv_1','mac_1','ATM10','C:\\Users\\Jean\\Minecraft\\ATM10','forge',
      '1.21.1','ready','running','running',25565,1,1);
    INSERT INTO app_settings VALUES ('panel.publicUrl','https://panel.example.net',1),
      ('access.dns.token','tres-secret',1), ('push.vapidPrivateKey','',1);
  `);
  db.close();
}

describe('mmo-panel report', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mmo-report-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('masquage des lignes de journal', () => {
    it('efface le nom d’utilisateur des chemins Windows et POSIX', () => {
      expect(maskLine('EACCES on C:\\Users\\Jean\\Minecraft\\server.properties')).toBe(
        'EACCES on C:\\Users\\<user>\\Minecraft\\server.properties',
      );
      expect(maskLine('scan /home/jean/serveurs/atm10')).toBe('scan /home/<user>/serveurs/atm10');
      expect(maskLine('scan /Users/jean/mc')).toBe('scan /Users/<user>/mc');
    });

    it('efface les jetons, mots de passe et codes d’appairage', () => {
      expect(maskLine('pair code MMOP-4KJ2-9XZ1 issued')).toBe('pair code MMOP-<code> issued');
      expect(maskLine('token=abcdef123456 accepted')).toBe('token=<redacted> accepted');
      expect(maskLine('"password": "hunter2"')).toBe('"password": "<redacted>"');
    });

    it('tronque les adresses sans les rendre inutiles', () => {
      expect(maskLine('client 92.184.100.42 connected')).toBe('client 92.184.100.x connected');
      // La boucle locale reste lisible : la tronquer ne protège personne.
      expect(maskLine('client 127.0.0.1 connected')).toBe('client 127.0.0.1 connected');
      expect(maskLine('listening on 0.0.0.0:3000')).toBe('listening on 0.0.0.0:3000');
      expect(maskLine('client 2a01:e0a:1b2:3c4d:5e6f::1 connected')).toBe(
        'client 2a01:e0a:1b2:… connected',
      );
    });

    it('laisse passer une ligne ordinaire', () => {
      const line = '2026-09-01T10:00:00.000Z INFO server srv_1 started in 12.3s';
      expect(maskLine(line)).toBe(line);
    });
  });

  it('sans base : le rapport le dit au lieu d’échouer', async () => {
    const report = await buildReport(config(dir), { noLog: true });
    expect(report).toContain('mmo.db does not exist yet');
    expect(report).toContain('# MinecraftManagerOnline — diagnostic report');
  });

  it('avec base : machines et serveurs présents, secrets et chemins absents', async () => {
    seedDatabase(dir);
    const report = await buildReport(config(dir), { noLog: true });

    // Ce que le support a besoin de voir.
    expect(report).toContain('Tour du salon');
    expect(report).toContain('1.0.6');
    expect(report).toContain('ATM10');
    expect(report).toContain('forge');
    expect(report).toContain('1.21.1');

    // Ce qui ne doit jamais en sortir.
    expect(report).not.toContain('tres-secret');
    expect(report).toContain('(set, hidden)'); // le secret renseigné est signalé, pas révélé
    expect(report).toContain('(not set)'); // et celui qui ne l'est pas aussi
    expect(report).not.toContain('C:\\Users\\Jean'); // le chemin du serveur n'est pas repris
    expect(report).not.toContain('Minecraft\\ATM10');
  });

  it('le journal est joint masqué, borné au nombre de lignes demandé', async () => {
    mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const lines = [
      'ligne ancienne à ne pas joindre',
      'EACCES on C:\\Users\\Jean\\server.properties',
      'pair code MMOP-4KJ2-9XZ1 issued',
    ];
    writeFileSync(path.join(dir, 'logs', 'panel-2026-09-01.log'), `${lines.join('\n')}\n`);

    const report = await buildReport(config(dir), { logLines: 2 });
    expect(report).toContain('C:\\Users\\<user>\\server.properties');
    expect(report).toContain('MMOP-<code>');
    expect(report).not.toContain('ligne ancienne');
    expect(report).not.toContain('MMOP-4KJ2');
  });

  it('sans dossier de journaux, le rapport reste complet', async () => {
    seedDatabase(dir);
    const report = await buildReport(config(dir));
    expect(report).toContain('no log directory yet');
  });
});
