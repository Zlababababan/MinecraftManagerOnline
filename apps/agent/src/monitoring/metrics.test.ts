import { describe, expect, it } from 'vitest';

import { Logger } from '../log.js';
import { MetricsCollector, type MetricsSample, type MetricsTarget } from './metrics.js';
import type { ProcessSampler, Sample } from './sampler.js';

const logger = new Logger('test', { stderr: false });

function stubSampler(cpu: Record<number, number | undefined>, rss: Record<number, number>) {
  const calls: number[][] = [];
  const sampler: ProcessSampler = {
    sample: (pids) => {
      calls.push(pids);
      const processes = new Map<
        number,
        { cpuPct: number | undefined; rssMb: number | undefined }
      >();
      for (const pid of pids) processes.set(pid, { cpuPct: cpu[pid], rssMb: rss[pid] });
      const out: Sample = { ts: 1000, cpuSource: 'cycles', machineCpuPct: 12.5, processes };
      return Promise.resolve(out);
    },
    close: () => undefined,
  };
  return { sampler, calls };
}

describe('MetricsCollector (metrics.sample)', () => {
  it('construit un échantillon : machine + serveurs en marche (CPU, RSS, joueurs, TPS et sa source)', async () => {
    const { sampler, calls } = stubSampler({ 11: 42.5, 12: undefined }, { 11: 1500, 12: 300 });
    const emitted: MetricsSample[] = [];
    const targets: MetricsTarget[] = [
      {
        serverId: 'b',
        pid: 12,
        state: 'starting',
        players: 0,
        maxRamMb: 1024,
        readTps: () => Promise.resolve({ tps: 20, mspt: 1, source: 'forge' }),
      },
      {
        serverId: 'a',
        pid: 11,
        state: 'running',
        players: 3,
        maxRamMb: 4096,
        readTps: () => Promise.resolve({ tps: 19.87654, mspt: 12.3456, source: 'tick_query' }),
      },
      { serverId: 'c', pid: undefined, state: 'stopped', players: 0, maxRamMb: 1024 },
    ];
    const collector = new MetricsCollector({
      logger,
      sampler,
      targets: () => targets,
      emit: (s) => emitted.push(s),
      isConnected: () => true,
      now: () => 5000,
    });
    const sample = await collector.collect();
    expect(calls).toEqual([[12, 11]]);
    expect(sample).toMatchObject({
      ts: 5000,
      cpuSource: 'cycles',
      machine: { cpuPct: 12.5 },
      servers: [
        {
          serverId: 'a',
          cpuPct: 42.5,
          rssMb: 1500,
          tps: 19.88,
          mspt: 12.35,
          tpsSource: 'tick_query',
          players: 3,
        },
        // `starting` : pas de lecture TPS, CPU inconnu au premier relevé
        { serverId: 'b', rssMb: 300, players: 0 },
      ],
    });
    expect(sample?.servers[1]).not.toHaveProperty('tps');
    expect(sample?.servers[1]).not.toHaveProperty('cpuPct');
    expect(sample?.machine.ramTotalMb).toBeGreaterThan(0);
    expect(emitted).toHaveLength(1);
    expect(collector.summary).toMatchObject({ ts: 5000, cpuPct: 12.5, cpuSource: 'cycles' });
  });

  it('hors ligne : tampon borné (1 h) rejoué dans l’ordre avec les timestamps d’origine', async () => {
    const { sampler } = stubSampler({}, {});
    const emitted: MetricsSample[] = [];
    let connected = false;
    let now = 0;
    const collector = new MetricsCollector({
      logger,
      sampler,
      targets: () => [],
      emit: (s) => emitted.push(s),
      isConnected: () => connected,
      intervalMs: 15_000,
      bufferMs: 60_000,
      now: () => now,
    });
    for (let i = 0; i < 6; i++) {
      now = (i + 1) * 15_000;
      await collector.collect();
    }
    expect(emitted).toEqual([]);
    expect(collector.buffered).toBe(4); // 60 s / 15 s : les 2 plus anciens sont tombés
    connected = true;
    expect(collector.replay()).toBe(4);
    expect(emitted.map((s) => s.ts)).toEqual([45_000, 60_000, 75_000, 90_000]);
    expect(collector.buffered).toBe(0);
    now = 105_000;
    await collector.collect();
    expect(emitted).toHaveLength(5);
  });

  it('garde-fou RAM : callback une fois quand RSS > 1,5 × maxRamMb + 512, réarmé au redémarrage', async () => {
    const rss: Record<number, number> = { 11: 1000 };
    const { sampler } = stubSampler({}, rss);
    const alerts: [string, number, number][] = [];
    const collector = new MetricsCollector({
      logger,
      sampler,
      targets: () => [{ serverId: 'a', pid: 11, state: 'running', players: 0, maxRamMb: 1024 }],
      emit: () => undefined,
      isConnected: () => true,
      onRamExceeded: (id, r, max) => alerts.push([id, r, max]),
    });
    await collector.collect();
    expect(alerts).toEqual([]);
    rss[11] = 2100;
    await collector.collect();
    await collector.collect();
    expect(alerts).toEqual([['a', 2100, 1024]]);
    collector.resetServer('a');
    await collector.collect();
    expect(alerts).toHaveLength(2);
  });

  it('une erreur de lecture TPS n’empêche pas l’échantillon', async () => {
    const { sampler } = stubSampler({}, { 11: 10 });
    const collector = new MetricsCollector({
      logger,
      sampler,
      targets: () => [
        {
          serverId: 'a',
          pid: 11,
          state: 'running',
          players: 1,
          maxRamMb: 1024,
          readTps: () => Promise.reject(new Error('rcon down')),
        },
      ],
      emit: () => undefined,
      isConnected: () => true,
    });
    const sample = await collector.collect();
    expect(sample?.servers).toEqual([{ serverId: 'a', rssMb: 10, players: 1 }]);
  });
});
