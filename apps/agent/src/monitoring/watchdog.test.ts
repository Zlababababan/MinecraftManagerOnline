import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError, type RunState } from '@mmo/protocol';

import { Logger } from '../log.js';
import { Watchdog, type WatchdogAlert, type WatchdogPolicy } from './watchdog.js';

const logger = new Logger('test', { stderr: false });

function harness(policy: Partial<WatchdogPolicy> = {}) {
  const alerts: WatchdogAlert[] = [];
  const restarts: string[] = [];
  let state: RunState = 'running';
  let probeFails = false;
  let probeError: 'E_TIMEOUT' | 'E_INTERRUPTED' | 'E_IO' = 'E_TIMEOUT';
  let alive = true;
  const kills: string[] = [];
  const watchdog = new Watchdog({
    logger,
    policy: () => ({
      autoRestart: true,
      crashLoopMax: 2,
      freezeTimeoutSec: 3,
      freezeAction: 'kill_restart',
      ...policy,
    }),
    view: () => ({
      state: () => state,
      pid: 4242,
      probe: () =>
        probeFails
          ? Promise.reject(new ProtocolError(probeError, 'probe failed'))
          : Promise.resolve(),
      alive: () => alive,
      kill: (reason) => {
        kills.push(reason);
        state = 'crashed';
        return Promise.resolve();
      },
    }),
    restart: (serverId) => {
      restarts.push(serverId);
      return Promise.resolve();
    },
    alert: (a) => {
      alerts.push(a);
    },
    crashWindowMs: 60_000,
    restartDelayMs: 100,
    restartDelayMaxMs: 1000,
    minProbeIntervalMs: 100,
  });
  return {
    watchdog,
    alerts,
    restarts,
    kills,
    setState: (s: RunState) => {
      state = s;
    },
    setProbeError: (code: 'E_TIMEOUT' | 'E_INTERRUPTED' | 'E_IO') => {
      probeError = code;
    },
    setProbeFails: (v: boolean) => {
      probeFails = v;
    },
    setAlive: (v: boolean) => {
      alive = v;
    },
  };
}

describe('Watchdog (doc 06 §4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('crash → alerte restart puis relance après délai croissant, bornée par crashLoopMax', async () => {
    const h = harness({ crashLoopMax: 2 });
    h.watchdog.onStateChanged('s1', 'crashed', {
      exitReason: 'crash',
      crashSignal: 'out_of_memory',
    });
    expect(h.alerts).toEqual([
      expect.objectContaining({
        kind: 'crash',
        action: 'restart',
        attempt: 1,
        detail: 'out_of_memory',
      }),
    ]);
    expect(h.restarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.restarts).toEqual(['s1']);

    h.watchdog.onStateChanged('s1', 'starting');
    h.watchdog.onStateChanged('s1', 'crashed', { exitReason: 'crash' });
    expect(h.alerts[1]).toMatchObject({ kind: 'crash', action: 'restart', attempt: 2 });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.restarts).toEqual(['s1', 's1']);

    // Troisième crash dans la fenêtre : on renonce
    h.watchdog.onStateChanged('s1', 'crashed', { exitReason: 'crash' });
    expect(h.alerts[2]).toMatchObject({ kind: 'crash_loop', action: 'gave_up', attempt: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.restarts).toHaveLength(2);

    // Fenêtre écoulée : le compteur repart
    vi.advanceTimersByTime(61_000);
    h.watchdog.onStateChanged('s1', 'crashed', { exitReason: 'crash' });
    expect(h.alerts[3]).toMatchObject({ kind: 'crash', action: 'restart', attempt: 1 });
  });

  it('autoRestart désactivé : alerte crash sans action', async () => {
    const h = harness({ autoRestart: false });
    h.watchdog.onStateChanged('s1', 'crashed', { crashReportPath: '/x/crash-1.txt' });
    expect(h.alerts).toEqual([
      expect.objectContaining({
        kind: 'crash',
        action: 'none',
        attempt: 0,
        detail: '/x/crash-1.txt',
      }),
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.restarts).toEqual([]);
  });

  it('crashLoopMax = 0 : jamais de relance automatique', () => {
    const h = harness({ crashLoopMax: 0 });
    h.watchdog.onStateChanged('s1', 'crashed');
    expect(h.alerts[0]).toMatchObject({ kind: 'crash_loop', action: 'gave_up', attempt: 0 });
  });

  it('cancel() annule une relance en attente (arrêt demandé par l’utilisateur)', async () => {
    const h = harness();
    h.watchdog.onStateChanged('s1', 'crashed');
    h.watchdog.cancel('s1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.restarts).toEqual([]);
    expect(h.watchdog.attempts('s1')).toBe(0);
  });

  it('freeze : 3 sondes RCON en échec, processus vivant ⇒ alerte + kill_restart', async () => {
    const h = harness({ freezeTimeoutSec: 3 });
    // freezeTimeoutSec 3 ⇒ sonde toutes les 1 s, freeze après 3 échecs consécutifs
    h.watchdog.onStateChanged('s1', 'running');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.alerts).toEqual([]);
    h.setProbeFails(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.alerts).toEqual([]); // 2 échecs
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.alerts).toEqual([
      expect.objectContaining({ kind: 'freeze', action: 'kill_restart', attempt: 1 }),
    ]);
    expect(h.kills).toEqual(['freeze']);
    // L'exit `freeze_kill` arrive ensuite par ServerProcess → relance comptée comme un crash
    h.watchdog.onStateChanged('s1', 'crashed', { exitReason: 'freeze_kill' });
    expect(h.alerts[1]).toMatchObject({
      kind: 'crash',
      action: 'restart',
      attempt: 1,
      detail: 'freeze_kill',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.restarts).toEqual(['s1']);
  });

  it('phase 12 : une connexion RCON fermée/refusée n’est pas un gel (seul E_TIMEOUT compte)', async () => {
    const h = harness({ freezeTimeoutSec: 3 });
    h.watchdog.onStateChanged('s1', 'running');
    h.setProbeError('E_INTERRUPTED');
    h.setProbeFails(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.alerts).toEqual([]);
    expect(h.kills).toEqual([]);
    h.setProbeError('E_IO');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.alerts).toEqual([]);
    // Puis de vraies expirations : 3 consécutives ⇒ gel.
    h.setProbeError('E_TIMEOUT');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'freeze', action: 'kill_restart' })]);
  });

  it('freeze : action none ⇒ une seule alerte tant que la sonde ne répond pas ; processus mort ⇒ rien', async () => {
    const h = harness({ freezeAction: 'none', freezeTimeoutSec: 3 });
    h.watchdog.onStateChanged('s1', 'running');
    h.setProbeFails(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.alerts).toEqual([
      expect.objectContaining({ kind: 'freeze', action: 'none', attempt: 0 }),
    ]);
    expect(h.kills).toEqual([]);
    // Réponse revenue puis nouveau gel : nouvelle alerte
    h.setProbeFails(false);
    await vi.advanceTimersByTimeAsync(1000);
    h.setProbeFails(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.alerts).toHaveLength(2);

    const dead = harness({ freezeAction: 'none' });
    dead.watchdog.onStateChanged('s2', 'running');
    dead.setProbeFails(true);
    dead.setAlive(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(dead.alerts).toEqual([]);
  });

  it('garde-fou RAM : une alerte par session de démarrage', () => {
    const h = harness();
    h.watchdog.onRamExceeded('s1', 9000, 4096);
    h.watchdog.onRamExceeded('s1', 9500, 4096);
    expect(h.alerts).toEqual([
      expect.objectContaining({
        kind: 'ram',
        action: 'none',
        detail: 'rss 9000 MB > 4096 MB (maxRamMb)',
      }),
    ]);
    h.watchdog.onStateChanged('s1', 'starting');
    h.watchdog.onRamExceeded('s1', 9000, 4096);
    expect(h.alerts).toHaveLength(2);
  });
});
