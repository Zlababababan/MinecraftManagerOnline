import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

  it('toute la chaîne échoue ⇒ indisponible, sans réessai avant retryAfterMs', async () => {
    let now = 0;
    const commands: string[] = [];
    const probe = new TpsProbe({
      serverDir: dir,
      loader: 'vanilla',
      mcVersion: '1.20.4',
      exec: (command) => {
        commands.push(command);
        return Promise.reject(new Error('timeout'));
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
