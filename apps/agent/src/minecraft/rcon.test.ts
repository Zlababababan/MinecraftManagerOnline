import { spawn, type ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProtocolError } from '@mmo/protocol';

import { FAKE_SERVER, freePort, waitFor } from '../test/helpers.js';
import { RconClient, decodeRconPackets, encodeRconPacket, parseListResponse } from './rcon.js';
import { isPortFree } from '../platform/ports.js';

describe('client RCON maison (doc 06 §5)', () => {
  let child: ChildProcess;
  let port: number;
  const password = 's3cret-pass';

  beforeAll(async () => {
    port = await freePort();
    child = spawn(
      process.execPath,
      [
        FAKE_SERVER,
        '--done-after',
        '50',
        '--rcon-port',
        String(port),
        '--rcon-password',
        password,
        '--rcon-delay',
        '0',
        '--join',
        'Alice,Bob',
        '--big-response',
        '9000',
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    await waitFor(async () => !(await isPortFree(port)), 5000);
  });
  afterAll(() => {
    child.kill('SIGKILL');
  });

  it('encode/décode les paquets Source RCON (little-endian, double nul, flux fragmenté)', () => {
    const p = encodeRconPacket(7, 2, 'list');
    expect(p.length).toBe(4 + 4 + 4 + 4 + 2);
    expect(p.readInt32LE(0)).toBe(14);
    const both = Buffer.concat([p, encodeRconPacket(8, 0, 'ok')]);
    const { packets, rest } = decodeRconPackets(both.subarray(0, both.length - 3));
    expect(packets).toEqual([{ id: 7, type: 2, body: 'list' }]);
    expect(rest.length).toBe(16 - 3); // second paquet (12 + 2 + 2 octets) incomplet
  });

  it('authentifie, exécute et réassemble une réponse fragmentée (> 4096) grâce au paquet junk', async () => {
    const rcon = new RconClient({ port, password });
    await waitFor(async () => {
      try {
        await rcon.connect();
        return true;
      } catch {
        return false;
      }
    });
    await waitFor(async () => (await rcon.exec('list')).includes('Alice'));
    const list = await rcon.exec('list');
    expect(list.length).toBe(9000);
    expect(list.startsWith('There are 2 of a max of 20 players online: Alice, Bob')).toBe(true);
    expect(parseListResponse(list.slice(0, 53))).toMatchObject({
      online: 2,
      max: 20,
      players: ['Alice', 'Bob'],
    });
    rcon.close();
  });

  it('sérialise les commandes concurrentes et répond dans l’ordre', async () => {
    const rcon = new RconClient({ port, password });
    const results = await Promise.all([
      rcon.exec('say un'),
      rcon.exec('say deux'),
      rcon.exec('list'),
    ]);
    expect(results[2]).toContain('There are');
    rcon.close();
  });

  it('refuse un mauvais mot de passe avec E_AUTH', async () => {
    const rcon = new RconClient({ port, password: 'wrong' });
    await expect(rcon.exec('list')).rejects.toMatchObject({ code: 'E_AUTH' });
    rcon.close();
  });

  it('E_TIMEOUT sur commande bloquante puis reconnexion automatique', async () => {
    const rcon = new RconClient({ port, password, timeoutMs: 300 });
    await expect(rcon.exec('sleep 1500')).rejects.toSatisfy(
      (e) => e instanceof ProtocolError && e.code === 'E_TIMEOUT',
    );
    await waitFor(async () => {
      try {
        return (await rcon.exec('list')).includes('There are');
      } catch {
        return false;
      }
    }, 5000);
    rcon.close();
  });

  it('port fermé → E_IO (retryable), sans blocage', async () => {
    const closed = await freePort();
    const rcon = new RconClient({ port: closed, password });
    await expect(rcon.exec('list')).rejects.toMatchObject({ code: 'E_IO', retryable: true });
  });

  it('interprète `list` dans ses variantes', () => {
    expect(parseListResponse('There are 0 of a max of 20 players online:')).toEqual({
      online: 0,
      max: 20,
      players: [],
    });
    expect(parseListResponse('There are 1/20 players online:\nNotch')).toBeUndefined();
  });
});
