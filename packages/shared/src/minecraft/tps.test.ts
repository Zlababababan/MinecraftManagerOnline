import { describe, expect, it } from 'vitest';

import { parseForgeTps, parseSparkTps, parseTickQuery, parseTpsResponse, tpsChain } from './tps.js';

describe('parsing TPS (doc 06 §6)', () => {
  it('forge ≤ 1.20 : « Mean tick time … Mean TPS »', () => {
    const text =
      'Dim minecraft:overworld (Overworld): Mean tick time: 3.456 ms. Mean TPS: 20.000\n' +
      'Overall: Mean tick time: 12,345 ms. Mean TPS: 19,8';
    expect(parseForgeTps(text)).toEqual({ tps: 19.8, mspt: 12.345 });
  });

  it('neoforge / forge récent : « Overall: 20.000 TPS (2.3 ms/tick) » avec codes couleur', () => {
    const text = '§aOverall§r: §a20.000 TPS§r (§e2.3 ms/tick§r)';
    expect(parseForgeTps(text)).toEqual({ tps: 20, mspt: 2.3 });
  });

  it('forge : sans ligne Overall, la première dimension fait foi', () => {
    expect(parseForgeTps('Dim 0 (overworld): Mean tick time: 50.0 ms. Mean TPS: 20.000')).toEqual({
      tps: 20,
      mspt: 50,
    });
    expect(parseForgeTps('rien à voir')).toBeUndefined();
  });

  it('spark : TPS à 10 s et médiane des durées de tick', () => {
    const text =
      '§8[§e⚡§8] §7TPS from last 5s, 10s, 1m, 5m, 15m:\n' +
      '§8[§e⚡§8] §a*20.0, §a*19.6, §a*20.0, §a*20.0, §a*20.0\n' +
      '§8[§e⚡§8] §7Tick durations (min/med/95%ile/max ms) from last 10s, 1m:\n' +
      '§8[§e⚡§8] §a1.2/§a2.3/§a4.5/§a9.8;  §a1.1/§a2.2/§a4.1/§e12.0';
    expect(parseSparkTps(text)).toEqual({ tps: 19.6, mspt: 2.3 });
    expect(parseSparkTps('')).toBeUndefined();
  });

  it('tick query (≥ 1.20.3) : TPS borné par la cible', () => {
    const ok =
      'Target tick rate: 20.0 per second.\nAverage time per tick: 2.4ms (Target: 50.0ms)\nPercentiles: P50: 2.3ms P95: 3.5ms P99: 6.2ms, sample: 100';
    expect(parseTickQuery(ok)).toEqual({ tps: 20, mspt: 2.4 });
    const slow =
      'Target tick rate: 20.0 per second.\nAverage time per tick: 80.0ms (Target: 50.0ms)';
    expect(parseTickQuery(slow)).toEqual({ tps: 12.5, mspt: 80 });
    expect(parseTickQuery('Unknown or incomplete command')).toBeUndefined();
  });

  it('parseTpsResponse : commande inconnue ⇒ undefined', () => {
    expect(parseTpsResponse('forge', 'Unknown or incomplete command, see below')).toBeUndefined();
    expect(parseTpsResponse('tick_query', '')).toBeUndefined();
    expect(parseTpsResponse('spark', 'TPS from last 5s, 10s: 20.0, 18.5')).toEqual({
      tps: 18.5,
      mspt: undefined,
    });
  });

  it('chaîne de fallback selon le loader', () => {
    expect(
      tpsChain({ loader: 'neoforge', mcVersion: '1.21.1', sparkInstalled: false }).map(
        (m) => m.source,
      ),
    ).toEqual(['neoforge', 'forge', 'tick_query']);
    expect(
      tpsChain({ loader: 'forge', mcVersion: '1.16.5', sparkInstalled: true }).map((m) => m.source),
    ).toEqual(['forge', 'spark']);
    expect(tpsChain({ loader: 'fabric', mcVersion: '1.20.1', sparkInstalled: false })).toEqual([]);
    expect(tpsChain({ loader: 'vanilla', mcVersion: '1.20.4', sparkInstalled: false })).toEqual([
      { source: 'tick_query', command: 'tick query' },
    ]);
    expect(tpsChain({ loader: 'vanilla', mcVersion: '1.12.2', sparkInstalled: false })).toEqual([]);
    // Version inconnue : on tente tick query, l'échec est silencieux.
    expect(
      tpsChain({ loader: 'fabric', mcVersion: undefined, sparkInstalled: true }).map(
        (m) => m.source,
      ),
    ).toEqual(['spark', 'tick_query']);
  });
});
