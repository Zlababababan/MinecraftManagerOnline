import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRotatingLog, purgeRotatedLogs, tailRotatedLog } from './rotating-log.js';

/** Un `WriteStream` écrit de façon asynchrone : attendre le contenu plutôt qu'un délai fixe. */
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

describe('rotating-log', () => {
  let dir: string;
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('écrit dans <prefix>-<date>.log et purge les fichiers au-delà de la rétention à l’ouverture', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-rlog-'));
    const now = Date.UTC(2026, 7, 25, 12);
    const old = path.join(dir, 'agent-2026-01-01.log');
    const recent = path.join(dir, 'agent-2026-08-20.log');
    const foreign = path.join(dir, 'panel-2026-01-01.log');
    for (const f of [old, recent, foreign]) fs.writeFileSync(f, 'x\n');
    fs.utimesSync(old, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
    fs.utimesSync(foreign, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)));

    const log = createRotatingLog({ dir, prefix: 'agent', now: () => now });
    expect(log.file).toBe(path.join(dir, 'agent-2026-08-25.log'));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    // Un autre préfixe n'est jamais touché, même périmé.
    expect(fs.existsSync(foreign)).toBe(true);

    log.write('ligne 1\n');
    log.write('ligne 2\n');
    const content = await waitForContent(log.file!, 'ligne 2');
    expect(content).toContain('ligne 1');
    log.close();
  });

  it('bascule au changement de date, puis sur un suffixe numéroté au-delà du plafond', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-rlog-'));
    let now = Date.UTC(2026, 7, 25, 23, 59);
    const log = createRotatingLog({ dir, prefix: 'agent', now: () => now, maxBytes: 64 });
    log.write('veille\n');
    expect(log.file).toBe(path.join(dir, 'agent-2026-08-25.log'));

    now = Date.UTC(2026, 7, 26, 0, 1);
    log.write(`${'a'.repeat(60)}\n`);
    expect(log.file).toBe(path.join(dir, 'agent-2026-08-26.log'));
    log.write(`${'b'.repeat(60)}\n`);
    expect(log.file).toBe(path.join(dir, 'agent-2026-08-26-1.log'));
    expect(await waitForContent(path.join(dir, 'agent-2026-08-25.log'), 'veille')).toContain(
      'veille',
    );
    expect(await waitForContent(log.file!, 'bbb')).toContain('bbb');
    log.close();

    // Fermé = définitif : une écriture après `close()` tombant sur un changement de date ne
    // rouvre pas de fichier (sinon un agent arrêté continuerait d'écrire dans son journal).
    now = Date.UTC(2026, 7, 27, 0, 1);
    log.write('fantôme\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.existsSync(path.join(dir, 'agent-2026-08-27.log'))).toBe(false);
    expect(log.file).toBe(path.join(dir, 'agent-2026-08-26-1.log'));
  });

  it('reste utilisable si le dossier est inaccessible', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-rlog-'));
    const file = path.join(dir, 'pas-un-dossier');
    fs.writeFileSync(file, 'x');
    const log = createRotatingLog({ dir: path.join(file, 'logs'), prefix: 'agent' });
    expect(log.file).toBeUndefined();
    expect(() => {
      log.write('console seulement\n');
    }).not.toThrow();
  });

  it('purgeRotatedLogs rend le nombre de fichiers supprimés, 0 sans dossier', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-rlog-'));
    const now = Date.UTC(2026, 8, 2);
    const aged = (name: string, days: number) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, 'x');
      const t = new Date(now - days * 86_400_000);
      fs.utimesSync(f, t, t);
    };
    aged('agent-2026-08-01.log', 32);
    aged('agent-2026-08-01-1.log', 32);
    aged('agent-2026-09-01.log', 1);
    aged('notes.txt', 40);
    expect(purgeRotatedLogs(dir, 'agent', 14, now)).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(['agent-2026-09-01.log', 'notes.txt']);
    expect(purgeRotatedLogs(path.join(dir, 'absent'), 'agent', 14, now)).toBe(0);
  });

  it('tailRotatedLog lit le fichier le plus récent, borné en lignes ET en octets', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-rlog-'));
    // `-10` doit passer après `-9` : un tri lexical le mettrait avant.
    fs.writeFileSync(path.join(dir, 'agent-2026-09-01.log'), 'ancien\n');
    for (let i = 1; i <= 10; i++) {
      fs.writeFileSync(
        path.join(dir, `agent-2026-09-02-${String(i)}.log`),
        `suffixe ${String(i)}\n`,
      );
    }
    fs.writeFileSync(path.join(dir, 'agent-2026-09-02.log'), 'base\n');
    const lines = Array.from({ length: 50 }, (_, i) => `ligne ${String(i + 1).padStart(2, '0')}`);
    fs.writeFileSync(path.join(dir, 'agent-2026-09-02-10.log'), `${lines.join('\n')}\n`);

    const byLines = tailRotatedLog(dir, 'agent', { lines: 3, maxBytes: 1_000_000 });
    expect(byLines.file).toBe('agent-2026-09-02-10.log');
    expect(byLines.lines).toEqual(['ligne 48', 'ligne 49', 'ligne 50']);
    expect(byLines.truncated).toBe(true);

    // Fenêtre d'octets : la première ligne, coupée, est écartée ; jamais plus que la fenêtre.
    const byBytes = tailRotatedLog(dir, 'agent', { lines: 100, maxBytes: 25 });
    expect(byBytes.lines).toEqual(['ligne 49', 'ligne 50']);
    expect(byBytes.truncated).toBe(true);

    const all = tailRotatedLog(dir, 'agent', { lines: 100, maxBytes: 1_000_000 });
    expect(all.lines).toHaveLength(50);
    expect(all.truncated).toBe(false);

    expect(tailRotatedLog(path.join(dir, 'absent'), 'agent', { lines: 5, maxBytes: 100 })).toEqual({
      lines: [],
      truncated: false,
    });
  });
});
