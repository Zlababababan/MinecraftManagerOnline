import { describe, expect, it } from 'vitest';

import { SelfMeter } from './self.js';

describe('SelfMeter — coût du processus agent', () => {
  it('RSS au premier relevé, puis CPU en cœurs depuis le delta de cpuUsage', () => {
    let now = 1000;
    let cpu = { user: 0, system: 0 };
    const meter = new SelfMeter(
      () => now,
      () => cpu,
      () => 96 * 1048576,
    );
    expect(meter.read()).toEqual({ rssMb: 96 });
    // 2 s écoulées, 500 ms de CPU (300 user + 200 system) : un quart de cœur.
    now = 3000;
    cpu = { user: 300_000, system: 200_000 };
    expect(meter.read()).toEqual({ rssMb: 96, cpuPct: 25 });
    // Une seconde de plus, 1,5 s de CPU (deux fils) : 150 = un cœur et demi, jamais borné à 100.
    now = 4000;
    cpu = { user: 1_500_000, system: 500_000 };
    expect(meter.read()).toEqual({ rssMb: 96, cpuPct: 150 });
  });

  it('horloge immobile ou compteur qui recule : RSS seul, jamais un CPU négatif', () => {
    let now = 1000;
    let cpu = { user: 500_000, system: 0 };
    const meter = new SelfMeter(
      () => now,
      () => cpu,
      () => 10 * 1048576,
    );
    meter.read();
    expect(meter.read()).toEqual({ rssMb: 10 });
    now = 2000;
    cpu = { user: 100_000, system: 0 };
    expect(meter.read()).toEqual({ rssMb: 10, cpuPct: 0 });
  });

  it('sur le vrai processus : un RSS positif et un CPU fini', async () => {
    const meter = new SelfMeter();
    meter.read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const usage = meter.read();
    expect(usage.rssMb).toBeGreaterThan(0);
    expect(Number.isFinite(usage.cpuPct)).toBe(true);
  });
});
