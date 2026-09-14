import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
    const content = await waitForContent(stream.file!, 'ligne 2');
    expect(content).toContain('ligne 1');
    expect(content).toContain('ligne 2');
    stream.close();
  });

  it('le journal d’accès va au fichier et pas à la console (sauf avertissement)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-log-'));
    const written: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      });
    // Rendu lisible forcé (les tests n'ont pas de terminal), filtre au réglage par défaut.
    vi.stubEnv('MMO_LOG_FORMAT', 'pretty');
    vi.stubEnv('MMO_LOG_CONSOLE', '');
    try {
      const stream = createPanelLogStream(dir, () => Date.UTC(2026, 8, 12, 12));
      const NL = String.fromCharCode(10);
      const ok = JSON.stringify({
        level: 30,
        time: 1,
        msg: 'request',
        method: 'GET',
        route: '/api/servers',
        status: 200,
        durationMs: 3,
      });
      const slow = JSON.stringify({
        level: 40,
        time: 2,
        msg: 'request',
        method: 'GET',
        route: '/api/events',
        status: 200,
        durationMs: 1500,
      });
      const ready = JSON.stringify({ level: 30, time: 3, msg: 'panel ready' });
      stream.write([ok, slow, ready].join(NL) + NL);
      const content = await waitForContent(stream.file!, 'panel ready');
      stream.close();
      // Le fichier garde tout : c'est lui que `mmo-panel report` relit.
      expect(content).toContain('"route":"/api/servers"');
      const shown = written.join('');
      expect(shown).not.toContain('/api/servers');
      expect(shown).toContain('/api/events');
      expect(shown).toContain('panel ready');
    } finally {
      stdout.mockRestore();
      vi.unstubAllEnvs();
    }
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
    expect(
      await waitForContent(path.join(dir, 'logs', 'panel-2026-08-25.log'), 'veille'),
    ).toContain('veille');
    expect(await waitForContent(stream.file!, 'lendemain')).toContain('lendemain');
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
      expect(await waitForContent(stream.file!, 'bbb')).toContain('bbb');
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

/**
 * Un `WriteStream` écrit de façon asynchrone : attendre le contenu plutôt qu'un délai fixe — 50 ms
 * ne suffisaient pas sous un `pnpm check` complet (cinq paquets de tests en parallèle), le
 * fichier était encore vide à la lecture.
 */
async function waitForContent(file: string, needle: string): Promise<string> {
  const deadline = Date.now() + 5000;
  let content = readOrEmpty(file);
  while (!content.includes(needle) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    content = readOrEmpty(file);
  }
  return content;
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
