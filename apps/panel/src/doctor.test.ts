/**
 * `mmo-panel doctor` : chaque contrôle correspond à une panne d'installation réellement rencontrée
 * ou redoutée. Le test vérifie surtout que le diagnostic **distingue** les cas — un doctor qui
 * répondrait « ok » partout serait pire qu'inutile.
 */
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkDataDir,
  checkDatabase,
  checkNativeModules,
  checkPort,
  checkRuntime,
  checkWebDir,
  formatChecks,
} from './doctor.js';
import { openSqliteFile } from './db/sqlite.js';

describe('doctor', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mmo-doctor-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('le runtime et les modules chargés dynamiquement sont sains ici', () => {
    expect(checkRuntime()).toMatchObject({ code: 'runtime.ok', level: 'ok' });
    expect(checkNativeModules().map((c) => c.code)).toEqual(['sqlite.ok', 'argon2.ok']);
  });

  describe('dossier de données', () => {
    it('crée le dossier absent et le déclare inscriptible', () => {
      const target = path.join(dir, 'data');
      expect(checkDataDir(target)).toMatchObject({ code: 'data.ok', level: 'ok' });
    });

    it('signale un dossier impossible à créer', () => {
      const file = path.join(dir, 'occupé');
      writeFileSync(file, 'je suis un fichier');
      expect(checkDataDir(path.join(file, 'data'))).toMatchObject({
        code: 'data.not_creatable',
        level: 'error',
      });
    });
  });

  describe('base de données', () => {
    it('une base absente est un premier démarrage, pas une erreur', () => {
      expect(checkDatabase(dir)).toMatchObject({ code: 'db.absent', level: 'ok' });
    });

    it('une base saine passe le quick_check', () => {
      openSqliteFile(path.join(dir, 'mmo.db')).close();
      expect(checkDatabase(dir)).toMatchObject({ code: 'db.ok', level: 'ok' });
    });

    it('un fichier qui n’est pas une base est signalé, pas ignoré', () => {
      writeFileSync(path.join(dir, 'mmo.db'), 'ceci n’est pas une base SQLite');
      const check = checkDatabase(dir);
      expect(check.level).toBe('error');
      expect(['db.corrupt', 'db.unopenable']).toContain(check.code);
    });
  });

  describe('port', () => {
    let server: Server | undefined;
    afterEach(() => {
      server?.close();
      server = undefined;
    });

    it('distingue un port libre d’un port déjà pris', async () => {
      server = createServer();
      const port = await new Promise<number>((resolve) => {
        server?.listen(0, '127.0.0.1', () => {
          resolve((server?.address() as { port: number }).port);
        });
      });
      expect(await checkPort('127.0.0.1', port)).toMatchObject({
        code: 'port.in_use',
        level: 'error',
      });
      server.close();
      server = undefined;
      expect(await checkPort('127.0.0.1', port)).toMatchObject({ code: 'port.ok', level: 'ok' });
    });
  });

  describe('front', () => {
    it('distingue « pas de front », « front servi » et « dossier vide »', () => {
      expect(checkWebDir(undefined)).toMatchObject({ code: 'web.absent', level: 'ok' });
      const web = path.join(dir, 'web');
      mkdirSync(web);
      expect(checkWebDir(web)).toMatchObject({ code: 'web.empty', level: 'warn' });
      writeFileSync(path.join(web, 'index.html'), '<!doctype html>');
      expect(checkWebDir(web)).toMatchObject({ code: 'web.ok', level: 'ok' });
    });
  });

  it('la sortie porte le niveau de chaque contrôle', () => {
    const text = formatChecks([
      { code: 'a', level: 'ok', message: 'tout va bien' },
      { code: 'b', level: 'warn', message: 'attention' },
      { code: 'c', level: 'error', message: 'cassé' },
    ]);
    expect(text).toContain('[  ok  ] tout va bien');
    expect(text).toContain('[ warn ] attention');
    expect(text).toContain('[ERROR ] cassé');
  });
});
