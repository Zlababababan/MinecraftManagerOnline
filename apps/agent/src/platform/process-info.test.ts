import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { FAKE_SERVER, sleep } from '../test/helpers.js';
import { getProcessInfo, isProcessAlive, verifyProcessIdentity } from './process-info.js';

describe('informations processus (ré-adoption, doc 05 §4)', () => {
  it('lit l’heure de démarrage et la ligne de commande du processus courant', async () => {
    const info = await getProcessInfo(process.pid);
    expect(info).toBeDefined();
    expect(info?.pid).toBe(process.pid);
    const approxStart = Date.now() - process.uptime() * 1000;
    expect(info?.startedAt).toBeDefined();
    expect(Math.abs((info?.startedAt ?? 0) - approxStart)).toBeLessThan(5000);
    expect(info?.cmdline?.toLowerCase()).toContain('node');
  });

  it('PID inexistant → non vivant', async () => {
    // PID hors plage réaliste : jamais alloué
    expect(isProcessAlive(2_147_483_646)).toBe(false);
    expect(await getProcessInfo(2_147_483_646)).toBeUndefined();
  });

  it('vérifie l’identité d’un enfant détaché : heure + clé de commande', async () => {
    const child = spawn(process.execPath, [FAKE_SERVER, '--done-after', '50'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    const pid = child.pid!;
    const startedAt = Date.now();
    try {
      await sleep(200);
      const ok = await verifyProcessIdentity(pid, {
        startedAt,
        cmdlineKey: 'fake-java-server.mjs',
      });
      expect(ok.alive).toBe(true);
      if (ok.alive) expect(ok.matches).toBe(true);
      const wrongCmd = await verifyProcessIdentity(pid, {
        startedAt,
        cmdlineKey: 'other-program.jar',
      });
      expect(wrongCmd).toMatchObject({ alive: true, matches: false, reason: 'cmdline' });
      const wrongTime = await verifyProcessIdentity(pid, {
        startedAt: startedAt - 3_600_000,
        cmdlineKey: 'fake-java-server.mjs',
      });
      expect(wrongTime).toMatchObject({ alive: true, matches: false, reason: 'start_time' });
    } finally {
      child.kill('SIGKILL');
    }
  });
});
