import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPanelLogStream } from './log-file.js';

describe('createPanelLogStream', () => {
  let dir: string;
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recopie les lignes dans data/logs/panel-<date>.log et purge les fichiers anciens', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-log-'));
    const now = Date.UTC(2026, 7, 25, 12);
    const logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const old = path.join(logsDir, 'panel-2026-01-01.log');
    const recent = path.join(logsDir, 'panel-2026-08-20.log');
    fs.writeFileSync(old, 'vieux\n');
    fs.utimesSync(old, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
    fs.writeFileSync(recent, 'récent\n');

    const stream = createPanelLogStream(dir, () => now);
    expect(stream.file).toBe(path.join(logsDir, 'panel-2026-08-25.log'));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);

    stream.write('{"msg":"ligne 1"}\n');
    stream.write('{"msg":"ligne 2"}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const content = fs.readFileSync(stream.file!, 'utf8');
    expect(content).toContain('ligne 1');
    expect(content).toContain('ligne 2');
    stream.close();
  });

  // Le fichier était choisi UNE FOIS au démarrage : un service qui tourne trois semaines écrivait
  // tout dans le journal du jour de son démarrage, et la rétention ne s'appliquait jamais.
  it('bascule de fichier au changement de date', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-log-'));
    let now = Date.UTC(2026, 7, 25, 23, 59);
    const stream = createPanelLogStream(dir, () => now);
    stream.write('{"msg":"veille"}\n');
    expect(stream.file).toBe(path.join(dir, 'logs', 'panel-2026-08-25.log'));

    now = Date.UTC(2026, 7, 26, 0, 1);
    stream.write('{"msg":"lendemain"}\n');
    expect(stream.file).toBe(path.join(dir, 'logs', 'panel-2026-08-26.log'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.readFileSync(path.join(dir, 'logs', 'panel-2026-08-25.log'), 'utf8')).toContain(
      'veille',
    );
    expect(fs.readFileSync(stream.file!, 'utf8')).toContain('lendemain');
    stream.close();
  });

  it('bascule sur un suffixe numéroté au-delà du plafond de taille', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-log-'));
    const now = Date.UTC(2026, 7, 25, 12);
    process.env.MMO_LOG_MAX_BYTES = '64';
    try {
      const stream = createPanelLogStream(dir, () => now);
      stream.write(`${'a'.repeat(60)}\n`);
      expect(stream.file).toBe(path.join(dir, 'logs', 'panel-2026-08-25.log'));
      stream.write(`${'b'.repeat(60)}\n`);
      expect(stream.file).toBe(path.join(dir, 'logs', 'panel-2026-08-25-1.log'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.readFileSync(stream.file!, 'utf8')).toContain('bbb');
      stream.close();
    } finally {
      delete process.env.MMO_LOG_MAX_BYTES;
    }
  });

  it('reste utilisable si le dossier de données est inaccessible (console seulement)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-log-'));
    const file = path.join(dir, 'pas-un-dossier');
    fs.writeFileSync(file, 'x');
    // dataDir pointe sur un fichier : mkdir échoue, le flux doit rester fonctionnel sans fichier.
    const stream = createPanelLogStream(path.join(file, 'data'));
    expect(stream.file).toBeUndefined();
    expect(() => {
      stream.write('{"msg":"console seulement"}\n');
    }).not.toThrow();
  });
});
