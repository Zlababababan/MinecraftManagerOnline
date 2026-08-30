import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ProtocolError } from '@mmo/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tmpDir } from '../test/helpers.js';
import { TpsProbe, detectSpark } from './tps.js';

describe('TpsProbe (chaîne de fallback doc 06 §6)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tmpDir('mmo-tps-'));
  });
  afterEach(async () => {
    await cleanup();
  });

  it('mémorise la méthode qui répond, ne réessaie les autres qu’en cas d’échec', async () => {
    const commands: string[] = [];
    const probe = new TpsProbe({
      serverDir: dir,
      loader: 'neoforge',
      mcVersion: '1.21.1',
      exec: (command) => {
        commands.push(command);
        if (command === 'neoforge tps') return Promise.resolve('Unknown or incomplete command');
        if (command === 'forge tps') return Promise.resolve('Overall: 19.5 TPS (12.3 ms/tick)');
        return Promise.resolve('');
      },
    });
    expect(await probe.read()).toEqual({ tps: 19.5, mspt: 12.3, source: 'forge' });
    expect(commands).toEqual(['neoforge tps', 'forge tps']);
    expect(await probe.read()).toMatchObject({ source: 'forge' });
    expect(commands).toEqual(['neoforge tps', 'forge tps', 'forge tps']);
    expect(probe.source).toBe('forge');
  });

  // Le serveur RÉPOND mais ne connaît aucune commande : insister spammerait sa console.
  it('commande inconnue sur toute la chaîne ⇒ verrou long, sans réessai avant retryAfterMs', async () => {
    let now = 0;
    const commands: string[] = [];
    const probe = new TpsProbe({
      serverDir: dir,
      loader: 'vanilla',
      mcVersion: '1.20.4',
      exec: (command) => {
        commands.push(command);
        return Promise.resolve('Unknown or incomplete command, see below for error');
      },
      retryAfterMs: 1000,
      now: () => now,
    });
    expect(await probe.read()).toBeUndefined();
    expect(commands).toEqual(['tick query']);
    expect(await probe.read()).toBeUndefined();
    expect(commands).toHaveLength(1);
    now = 1000;
    expect(await probe.read()).toBeUndefined();
    expect(commands).toHaveLength(2);
  });

  // Régression (bug masqué par la tolérance [flaky-ci]) : un échec de TRANSPORT était traité
  // comme « commande inconnue » et armait le verrou de 10 minutes. Sur un runner lent, le seul
  // ECONNREFUSED du démarrage suffisait à ce que le TPS ne soit plus jamais échantillonné.
  it('RCON pas encore prêt ⇒ backoff court et croissant, puis lecture dès qu’il répond', async () => {
    let now = 0;
    const commands: string[] = [];
    let failures = 3;
    const probe = new TpsProbe({
      serverDir: dir,
      loader: 'forge',
      mcVersion: '1.20.1', // chaîne à une seule méthode, comme le test d'intégration
      exec: (command) => {
        commands.push(command);
        if (failures-- > 0) {
          return Promise.reject(new ProtocolError('E_IO', 'rcon connect failed: ECONNREFUSED'));
        }
        return Promise.resolve('Overall: Mean tick time: 54.054 ms. Mean TPS: 18.500');
      },
      retryAfterMs: 600_000,
      transportRetryBaseMs: 100,
      now: () => now,
    });
    expect(await probe.read()).toBeUndefined();
    expect(commands).toEqual(['forge tps']);
    // Le verrou est court, pas de 10 minutes : la sonde retente au fil du backoff (100, 200, 400).
    now = 100;
    expect(await probe.read()).toBeUndefined();
    now = 300;
    expect(await probe.read()).toBeUndefined();
    now = 700;
    expect(await probe.read()).toMatchObject({ tps: 18.5, mspt: 54.054, source: 'forge' });
    expect(commands).toHaveLength(4);
  });

  it('un hoquet de transport n’efface pas la méthode apprise', async () => {
    let now = 0;
    const commands: string[] = [];
    let broken = false;
    const probe = new TpsProbe({
      serverDir: dir,
      loader: 'neoforge',
      mcVersion: '1.21.1',
      exec: (command) => {
        commands.push(command);
        if (broken) return Promise.reject(new ProtocolError('E_TIMEOUT', 'rcon timeout'));
        if (command === 'neoforge tps') return Promise.resolve('Unknown or incomplete command');
        if (command === 'forge tps') return Promise.resolve('Overall: 19.5 TPS (12.3 ms/tick)');
        return Promise.resolve('');
      },
      transportRetryBaseMs: 100,
      now: () => now,
    });
    expect(await probe.read()).toMatchObject({ source: 'forge' });
    broken = true;
    now = 10;
    expect(await probe.read()).toBeUndefined();
    // Une seule commande envoyée (le tuyau est commun), et la méthode apprise est conservée :
    // sinon chaque hoquet renverrait « neoforge tps » à un serveur Forge, dans sa console.
    expect(commands.at(-1)).toBe('forge tps');
    expect(probe.source).toBe('forge');
    broken = false;
    now = 200;
    expect(await probe.read()).toMatchObject({ source: 'forge' });
    expect(commands.at(-1)).toBe('forge tps');
  });

  it('transport durablement cassé ⇒ bascule sur le verrou long (pas de sonde perpétuelle)', async () => {
    let now = 0;
    const commands: string[] = [];
    const probe = new TpsProbe({
      serverDir: dir,
      loader: 'forge',
      mcVersion: '1.20.1',
      exec: (command) => {
        commands.push(command);
        return Promise.reject(new ProtocolError('E_CONFLICT', 'rcon unavailable'));
      },
      retryAfterMs: 600_000,
      transportRetryBaseMs: 100,
      now: () => now,
    });
    for (let i = 0; i < 25; i++) {
      now += 60_000;
      await probe.read();
    }
    // 20 tentatives au maximum, puis bascule sur le verrou long : pas de sonde perpétuelle sur un
    // serveur sans RCON ou dont le mot de passe est refusé.
    expect(commands).toHaveLength(20);
    now += 60_000;
    expect(await probe.read()).toBeUndefined();
    expect(commands).toHaveLength(20);
  });

  it('le déblocage à « running » relance immédiatement sans réapprendre la chaîne', async () => {
    const now = 0;
    const commands: string[] = [];
    let broken = true;
    const probe = new TpsProbe({
      serverDir: dir,
      loader: 'forge',
      mcVersion: '1.20.1',
      exec: (command) => {
        commands.push(command);
        if (broken) return Promise.reject(new ProtocolError('E_IO', 'ECONNREFUSED'));
        return Promise.resolve('Overall: Mean tick time: 54.054 ms. Mean TPS: 18.500');
      },
      transportRetryBaseMs: 30_000,
      now: () => now,
    });
    expect(await probe.read()).toBeUndefined();
    broken = false;
    // Sans unlock(), il faudrait attendre 30 s ; le serveur vient d'annoncer qu'il tourne.
    expect(await probe.read()).toBeUndefined();
    probe.unlock();
    expect(await probe.read()).toMatchObject({ source: 'forge' });
  });

  it('vanilla < 1.20.3 ou fabric sans spark : chaîne vide, aucune commande envoyée', async () => {
    const commands: string[] = [];
    const exec = (command: string) => {
      commands.push(command);
      return Promise.resolve('');
    };
    expect(
      await new TpsProbe({ serverDir: dir, loader: 'vanilla', mcVersion: '1.12.2', exec }).read(),
    ).toBeUndefined();
    expect(
      await new TpsProbe({ serverDir: dir, loader: 'fabric', mcVersion: '1.20.1', exec }).read(),
    ).toBeUndefined();
    expect(commands).toEqual([]);
  });

  it('spark détecté dans mods/ ⇒ `spark tps` tenté', async () => {
    await mkdir(path.join(dir, 'mods'));
    await writeFile(path.join(dir, 'mods', 'spark-1.10.53-fabric.jar'), '');
    expect(await detectSpark(dir)).toBe(true);
    const probe = new TpsProbe({
      serverDir: dir,
      loader: 'fabric',
      mcVersion: '1.20.1',
      exec: (command) =>
        Promise.resolve(
          command === 'spark tps'
            ? 'TPS from last 5s, 10s, 1m, 5m, 15m:\n*20.0, *18.0, *20.0, *20.0, *20.0'
            : '',
        ),
    });
    expect(await probe.read()).toEqual({ tps: 18, mspt: undefined, source: 'spark' });
  });
});
