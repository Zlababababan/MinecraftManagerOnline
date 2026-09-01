import { spawn, type ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProtocolError } from '@mmo/protocol';

import { FAKE_SERVER, freePort, testBudget, waitFor } from '../test/helpers.js';
import { RconClient, decodeRconPackets, encodeRconPacket, parseListResponse } from './rcon.js';

/**
 * Attend que le faux serveur ANNONCE son listener RCON, au lieu de sonder le port : un port occupé
 * ne dit pas PAR QUI. Sur un runner chargé, un autre worker peut prendre le port que `freePort()`
 * vient de rendre ; le faux serveur meurt alors sur EADDRINUSE, la sonde de port réussit quand même
 * et le test attend une connexion RCON vers un inconnu jusqu'à expiration (vécu en CI Windows).
 */
async function waitForRconReady(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes('RCON running')) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(`faux serveur terminé (code ${String(code)}) avant d'ouvrir RCON :\n${output}`),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`faux serveur : pas de listener RCON après ${String(timeoutMs)} ms :\n${output}`),
      );
    }, testBudget(timeoutMs));
    child.stdout?.on('data', onData);
    child.on('exit', onExit);
  });
}

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
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    await waitForRconReady(child);
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

  it('lecture « vanilla » (un paquet par lecture, sinon coupure) : commande et junk jamais coalescés', async () => {
    // Vanilla `RconClient.run` coupe la connexion si une lecture TCP ne contient pas exactement un
    // paquet : le client doit envoyer le junk seulement après le premier fragment de réponse.
    const strictPort = await freePort();
    const strict = spawn(
      process.execPath,
      [
        FAKE_SERVER,
        '--done-after',
        '50',
        '--rcon-port',
        String(strictPort),
        '--rcon-password',
        password,
        '--rcon-delay',
        '0',
        '--rcon-strict-read',
        '--big-response',
        '9000',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    try {
      await waitForRconReady(strict);
      const rcon = new RconClient({ port: strictPort, password });
      await waitFor(async () => {
        try {
          await rcon.connect();
          return true;
        } catch {
          return false;
        }
      });
      for (let i = 0; i < 20; i++) {
        const list = await rcon.exec('list');
        expect(list.length).toBe(9000);
        expect(rcon.isConnected).toBe(true);
      }
      expect(await rcon.exec('accent')).toBe('éèàç');
      expect(await rcon.exec('say hi')).toBe('');
      rcon.close();
    } finally {
      strict.kill('SIGKILL');
    }
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
