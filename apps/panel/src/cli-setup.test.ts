/**
 * `mmo-panel setup` : le wizard sans navigateur. Ce que ces tests protègent avant tout, c'est que
 * la commande emprunte le MÊME chemin que le wizard HTTP — une seconde implémentation qui
 * oublierait les clés VAPID créerait une installation dont le push est mort en silence.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSetupCommand } from './cli-setup.js';
import { defaultConfig } from './config.js';
import { createContext } from './context.js';
import { openMmoDatabase } from './db/client.js';
import { SETTING_KEYS } from './services/settings.js';

describe('mmo-panel setup', () => {
  let dir: string;
  let out: string[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mmo-setup-'));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      out.push(args.join(' '));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = () => defaultConfig({ dataDir: dir });

  /** Relit la base créée par la commande, comme le ferait le panel au démarrage suivant. */
  function inspect() {
    const opened = openMmoDatabase(path.join(dir, 'mmo.db'));
    const ctx = createContext({
      config: config(),
      logger: { child: () => undefined } as never,
    });
    try {
      return {
        users: ctx.users.count(),
        vapid: ctx.settings.get(SETTING_KEYS.vapidPublicKey),
        publicUrl: ctx.settings.get(SETTING_KEYS.publicUrl),
        completed: ctx.settings.get(SETTING_KEYS.setupCompletedAt),
      };
    } finally {
      ctx.close();
      opened.close();
    }
  }

  it('crée l’admin, les clés VAPID et l’URL publique, puis refuse un second passage', async () => {
    const code = await runSetupCommand(config(), [
      '--username',
      'admin',
      '--random-password',
      '--public-url',
      'panel.exemple.net',
    ]);
    expect(code).toBe(0);
    const state = inspect();
    expect(state.users).toBe(1);
    // Le push serait mort sans un mot si la CLI contournait le service de setup.
    expect(state.vapid).toBeTruthy();
    // L'URL est normalisée (https:// supposé), comme dans le wizard.
    expect(state.publicUrl).toBe('https://panel.exemple.net');
    expect(state.completed).toBeTruthy();
    // Un mot de passe généré doit être imprimé, sinon l'utilisateur ne peut pas se connecter.
    expect(out.join('\n')).toMatch(/password: \S+/);

    expect(await runSetupCommand(config(), ['--username', 'admin', '--random-password'])).toBe(1);
    expect(out.join('\n')).toContain('setup already completed');
  });

  it('lit le mot de passe dans un fichier', async () => {
    const file = path.join(dir, 'pass.txt');
    writeFileSync(file, 'correct horse battery\n');
    expect(
      await runSetupCommand(config(), [
        '--username',
        'admin',
        '--password-file',
        file,
        '--locale',
        'fr',
      ]),
    ).toBe(0);
    expect(inspect().users).toBe(1);
  });

  it('refuse une ligne de commande ambiguë ou incomplète', async () => {
    expect(await runSetupCommand(config(), ['--random-password'])).toBe(2);
    expect(await runSetupCommand(config(), ['--username', 'admin'])).toBe(2);
    // Deux sources de mot de passe : ambigu, on ne devine pas.
    expect(
      await runSetupCommand(config(), [
        '--username',
        'admin',
        '--random-password',
        '--password-file',
        'x',
      ]),
    ).toBe(2);
    expect(
      await runSetupCommand(config(), [
        '--username',
        'admin',
        '--random-password',
        '--locale',
        'de',
      ]),
    ).toBe(2);
    // Aucune de ces tentatives n'a créé quoi que ce soit.
    expect(inspect().users).toBe(0);
  });
});
