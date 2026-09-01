import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { Logger } from '../log.js';
import { sleep, testBudget } from '../test/helpers.js';
import {
  PlatformSampler,
  ProcSampler,
  PsSampler,
  TicksSampler,
  WindowsCyclesSampler,
  parsePsTime,
} from './sampler.js';

const logger = new Logger('test', { stderr: false });

describe('échantillonneurs CPU/RSS (spike n°2)', () => {
  it('parsePsTime : mm:ss, hh:mm:ss, dd-hh:mm:ss, fractions', () => {
    expect(parsePsTime('0:01.23')).toBe(1230);
    expect(parsePsTime('12:34')).toBe(754_000);
    expect(parsePsTime('1:02:03')).toBe(3_723_000);
    expect(parsePsTime('2-01:00:00')).toBe(176_400_000);
    expect(parsePsTime('n/a')).toBeUndefined();
  });

  it('PsSampler (macOS) : temps CPU cumulé → % d’un cœur entre deux relevés', async () => {
    let cpu = '0:01.00';
    const sampler = new PsSampler(() => Promise.resolve(`  4242  20480 ${cpu}\n`));
    const first = await sampler.sample([4242]);
    expect(first.cpuSource).toBe('proc');
    expect(first.processes.get(4242)).toEqual({ cpuPct: undefined, rssMb: 20 });
    await sleep(120);
    cpu = '0:01.10'; // +100 ms CPU en ~120 ms
    const second = await sampler.sample([4242]);
    const pct = second.processes.get(4242)?.cpuPct ?? 0;
    expect(pct).toBeGreaterThan(30);
    expect(pct).toBeLessThanOrEqual(100);
  });

  it('TicksSampler : charge machine seule, aucune mesure par processus', async () => {
    const sampler = new TicksSampler();
    await sampler.sample([process.pid]);
    await sleep(20);
    const s = await sampler.sample([process.pid]);
    expect(s.cpuSource).toBe('ticks');
    expect(s.processes.get(process.pid)).toEqual({ cpuPct: undefined, rssMb: undefined });
    expect(s.machineCpuPct === undefined || s.machineCpuPct >= 0).toBe(true);
  });

  it('PlatformSampler : repli ticks si la méthode principale échoue (plateforme sans implémentation)', async () => {
    const sampler = new PlatformSampler(logger, 'freebsd');
    const s = await sampler.sample([]);
    expect(s.cpuSource).toBe('ticks');
    sampler.close();
  });

  it('PlatformSampler : le repli ticks est temporaire, le primaire est retenté après le backoff', async () => {
    let fail = true;
    let closed = false;
    const primary = {
      sample: (pids: number[]) => {
        if (fail) return Promise.reject(new Error('metrics sidecar start timeout'));
        const processes = new Map(pids.map((pid) => [pid, { cpuPct: 12, rssMb: 34 }]));
        return Promise.resolve({
          ts: Date.now(),
          cpuSource: 'cycles' as const,
          machineCpuPct: 5,
          processes,
        });
      },
      close: () => {
        closed = true;
      },
    };
    // Deux délais, deux échantillonneurs, aucune horloge dans les assertions : un backoff court
    // suivi d'un `sleep` supposerait que les deux appels tiennent dedans — ce qui est faux dès que
    // la machine est chargée (vu rouge sur cette suite). Ici, « pendant le backoff » c'est une
    // minute (jamais atteinte) et « après le backoff » c'est zéro (toujours atteint).
    const pendant = new PlatformSampler(logger, 'win32', { primary, retryDelaysMs: [60_000] });
    const degraded = await pendant.sample([42]);
    expect(degraded.cpuSource).toBe('ticks');
    expect(degraded.processes.get(42)).toEqual({ cpuPct: undefined, rssMb: undefined });
    expect(closed).toBe(false); // le primaire n'est pas jeté : la panne peut être passagère

    // Le primaire remarcherait, mais le backoff court toujours : on ne le retente pas.
    fail = false;
    expect((await pendant.sample([42])).cpuSource).toBe('ticks');
    pendant.close();

    // Backoff écoulé : le primaire est retenté, et repris.
    fail = true;
    const apres = new PlatformSampler(logger, 'win32', { primary, retryDelaysMs: [0] });
    expect((await apres.sample([42])).cpuSource).toBe('ticks');
    fail = false;
    const recovered = await apres.sample([42]);
    expect(recovered.cpuSource).toBe('cycles');
    expect(recovered.processes.get(42)).toEqual({ cpuPct: 12, rssMb: 34 });
    apres.close();
  });

  it('PlatformSampler : PowerShell introuvable = panne définitive, le primaire est fermé', async () => {
    let closed = false;
    const primary = {
      sample: () => Promise.reject(new Error('powershell unavailable: spawn ENOENT')),
      close: () => {
        closed = true;
      },
    };
    const sampler = new PlatformSampler(logger, 'win32', { primary, retryDelaysMs: [0] });
    expect((await sampler.sample([42])).cpuSource).toBe('ticks');
    expect(closed).toBe(true);
    sampler.close();
  });

  // Le sidecar lui-même, exercé jusque sur les runners CI (contrairement au « burner » ci-dessous) :
  // c'est son démarrage qui, trop lent, faisait disparaître le RSS des métriques Windows. Le premier
  // relevé paie en plus la construction du compteur de performance (des secondes à froid), d'où le
  // budget large : ce test dit « le sidecar finit par répondre », les délais fins sont journalisés.
  it.runIf(process.platform === 'win32')(
    'WindowsCyclesSampler : démarre et rend le RSS du processus courant',
    async () => {
      const sampler = new WindowsCyclesSampler({ logger });
      try {
        const started = Date.now();
        const s = await sampler.sample([process.pid]);
        console.log(
          `[sidecar] poignée de main + premier relevé : ${String(Date.now() - started)} ms`,
        );
        expect(['cycles', 'ticks']).toContain(s.cpuSource);
        expect(s.processes.get(process.pid)?.rssMb ?? 0).toBeGreaterThan(0);
      } finally {
        sampler.close();
      }
    },
    testBudget(150_000),
  );

  it.runIf(process.platform === 'linux')(
    'ProcSampler : le processus courant a un RSS',
    async () => {
      const sampler = new ProcSampler();
      const s = await sampler.sample([process.pid]);
      expect(s.cpuSource).toBe('proc');
      expect(s.processes.get(process.pid)?.rssMb ?? 0).toBeGreaterThan(0);
    },
  );

  // Test « burner » du spike n°2 : un process qui sature un cœur doit être mesuré > 80 % par cycles,
  // là où la comptabilité par ticks donne ~2 % sous Hyper-V. Pas sur les runners CI partagés : la
  // saturation d'un cœur n'y est pas garantie (contention), la mesure devient non déterministe.
  it.runIf(process.platform === 'win32' && process.env.CI === undefined)(
    'WindowsCyclesSampler : burner mesuré > 80 % d’un cœur, RSS > 0, PID inconnu ignoré',
    async () => {
      const sampler = new WindowsCyclesSampler({ logger });
      const burner = spawn(
        process.execPath,
        ['-e', 'const t=Date.now();while(Date.now()-t<25000){}'],
        { stdio: 'ignore' },
      );
      try {
        const pid = burner.pid ?? 0;
        const first = await sampler.sample([pid, 999_999]);
        expect(first.processes.get(999_999)).toEqual({ cpuPct: undefined, rssMb: undefined });
        expect(first.processes.get(pid)?.rssMb ?? 0).toBeGreaterThan(0);
        await sleep(1500);
        const second = await sampler.sample([pid]);
        if (second.cpuSource === 'cycles') {
          expect(second.processes.get(pid)?.cpuPct ?? 0).toBeGreaterThan(80);
        } else {
          // Add-Type indisponible sur cette machine : mode ticks signalé franchement
          expect(second.cpuSource).toBe('ticks');
        }
        expect(second.machineCpuPct).toBeGreaterThanOrEqual(0);
      } finally {
        burner.kill();
        sampler.close();
      }
    },
    60_000,
  );
});
