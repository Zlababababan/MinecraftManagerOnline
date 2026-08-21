import { readFile, stat, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tmpDir } from '../test/helpers.js';
import { StateStore, emptyState } from './store.js';

describe('agent-state.json', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tmpDir());
  });
  afterEach(async () => {
    await cleanup();
  });

  it('démarre vide, persiste atomiquement et recharge', async () => {
    const store = new StateStore(dir, { restrictPermissions: false });
    expect(await store.load()).toEqual(emptyState());
    await store.update((s) => {
      s.agentId = 'agt_1';
      s.agentSecret = 'x'.repeat(64);
      s.watchedDirectories.push({ id: 'd1', path: '/srv', enabled: true });
    });
    expect(store.nextSeq('console:a')).toBe(1);
    expect(store.nextSeq('console:a')).toBe(2);
    await store.flush();
    const again = new StateStore(dir, { restrictPermissions: false });
    const state = await again.load();
    expect(state.agentId).toBe('agt_1');
    expect(state.seqs['console:a']).toBe(2);
    expect(state.watchedDirectories).toHaveLength(1);
    await expect(stat(`${store.file}.tmp`)).rejects.toThrow();
  });

  it('coalesce les écritures concurrentes sans corrompre le fichier', async () => {
    const store = new StateStore(dir, { restrictPermissions: false });
    await store.load();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.update((s) => {
          s.seqs[`c${String(i)}`] = i;
        }),
      ),
    );
    const json = JSON.parse(await readFile(store.file, 'utf8')) as { seqs: Record<string, number> };
    expect(Object.keys(json.seqs)).toHaveLength(20);
  });

  it('met de côté un fichier corrompu plutôt que de l’écraser', async () => {
    const store = new StateStore(dir, { restrictPermissions: false });
    await writeFile(store.file, '{ not json');
    expect(await store.load()).toEqual(emptyState());
    await expect(readFile(store.file, 'utf8')).rejects.toThrow();
  });

  it('restreint les permissions du fichier (POSIX : 600)', async () => {
    const store = new StateStore(dir);
    await store.load();
    await store.save();
    if (process.platform !== 'win32') {
      const mode = (await stat(store.file)).mode & 0o777;
      expect(mode).toBe(0o600);
    } else {
      await expect(readFile(store.file, 'utf8')).resolves.toContain('"version": 1');
    }
  });
});
