import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tmpDir } from '../test/helpers.js';
import { formatUuid, offlineUuid, resolvePlayers, type FetchLike } from './players.js';

describe('identité des joueurs (doc 06 §7)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tmpDir());
  });
  afterEach(() => cleanup());

  it('UUID hors ligne = nameUUIDFromBytes("OfflinePlayer:" + name) (valeurs de référence)', () => {
    // Valeurs calculées par un serveur vanilla en online-mode=false.
    expect(offlineUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f');
    // Version 3 (MD5) et variante RFC 4122.
    expect(offlineUuid('Steve')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(offlineUuid('notch')).not.toBe(offlineUuid('Notch'));
    expect(formatUuid('069A79F444E94726A5BEFCA90E38AAF5')).toBe(
      '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    );
  });

  it('usercache.json prime, puis Mojang (online) ou hors ligne, noms inconnus → null', async () => {
    await writeFile(
      path.join(dir, 'usercache.json'),
      JSON.stringify([
        { name: 'Alice', uuid: '11111111-1111-4111-8111-111111111111', expiresOn: 'x' },
      ]),
    );
    const calls: string[][] = [];
    const fetchImpl: FetchLike = (_url, init) => {
      const names = JSON.parse(init?.body ?? '[]') as string[];
      calls.push(names);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            names
              .filter((n) => n === 'Notch')
              .map((n) => ({ id: '069a79f444e94726a5befca90e38aaf5', name: n })),
          ),
      });
    };
    const online = await resolvePlayers(['alice', 'Notch', 'Nobody_Here'], {
      serverDir: dir,
      onlineMode: true,
      fetchImpl,
    });
    expect(online).toEqual([
      { name: 'Alice', uuid: '11111111-1111-4111-8111-111111111111', source: 'usercache' },
      { name: 'Notch', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', source: 'mojang' },
      { name: 'Nobody_Here', uuid: null, source: 'unknown' },
    ]);
    expect(calls).toEqual([['Notch', 'Nobody_Here']]);

    const offline = await resolvePlayers(['Bob'], { serverDir: dir, onlineMode: false, fetchImpl });
    expect(offline).toEqual([{ name: 'Bob', uuid: offlineUuid('Bob'), source: 'offline' }]);
    expect(calls).toHaveLength(1);
  });

  it('réseau en panne : résolution dégradée sans exception', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('offline'));
    const r = await resolvePlayers(['Zed'], { serverDir: dir, onlineMode: true, fetchImpl });
    expect(r).toEqual([{ name: 'Zed', uuid: null, source: 'unknown' }]);
  });

  // Vie privée (lot 9) : Mojang coupé → le usercache sert encore, l'API n'est jamais appelée.
  it('allowMojang: false — usercache seulement, aucun appel sortant, inconnus non résolus', async () => {
    await writeFile(
      path.join(dir, 'usercache.json'),
      JSON.stringify([
        { name: 'Alice', uuid: '11111111-1111-4111-8111-111111111111', expiresOn: 'x' },
      ]),
    );
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.reject(new Error('must not be called'));
    };
    const r = await resolvePlayers(['alice', 'Notch'], {
      serverDir: dir,
      onlineMode: true,
      fetchImpl,
      allowMojang: false,
    });
    expect(r).toEqual([
      { name: 'Alice', uuid: '11111111-1111-4111-8111-111111111111', source: 'usercache' },
      { name: 'Notch', uuid: null, source: 'unknown' },
    ]);
    expect(calls).toBe(0);
  });
});
