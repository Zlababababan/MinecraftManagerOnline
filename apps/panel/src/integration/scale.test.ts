/**
 * Phase 12 — test d'échelle (doc 07) : ~56 serveurs détectés par un agent réel (fixtures de
 * détection dupliquées), 4 serveurs fake démarrés simultanément avec métriques temps réel, puis
 * 48 h de métriques synthétiques pour les 56 serveurs (11 520 échantillons × 56 = 645 k lignes)
 * passées par l'ingestion + le job de maintenance horaire : agrégats, purge du brut, latence des
 * requêtes API sous bornes. Les copies réelles (`D:\mmo-test\scale`, miroir de 55 dossiers) ont
 * été jouées à la main avec `mmo-agent scan` — 53 détectés en 8 s.
 */
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerDto } from '@mmo/protocol/client';

import { Agent } from '../../../agent/src/agent.js';
import { Logger } from '../../../agent/src/log.js';
import { HOUR, RETENTION } from '../services/metrics.js';
import {
  createTestPanel,
  freePort,
  setupAdmin,
  tmpDir,
  waitFor,
  type TestPanel,
} from '../test/helpers.js';

const FAKE_SERVER = path.resolve(import.meta.dirname, '../../../agent/test/fake-java-server.mjs');
const FIXTURES = path.resolve(
  import.meta.dirname,
  '../../../../packages/shared/test/fixtures/servers',
);
const TARGET = 56;
const STEP = 15_000;

describe('phase 12 — échelle', () => {
  let panel: TestPanel;
  let admin: string;
  let agent: Agent | undefined;
  let cleanups: (() => Promise<void>)[] = [];
  let root: string;

  beforeEach(async () => {
    const data = await tmpDir('mmo-scale-data-');
    const servers = await tmpDir('mmo-scale-servers-');
    cleanups = [data.cleanup, servers.cleanup];
    root = servers.dir;
    panel = await createTestPanel({
      now: () => Date.now(),
      config: { heartbeatIntervalSec: 1, offlineAfterMs: 10_000, dataDir: data.dir },
      schedulerTickMs: 0,
    });
    await panel.listen();
    admin = await setupAdmin(panel);
  });
  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
    await panel.close();
    for (const c of cleanups) await c();
  });

  const api = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    panel.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: { cookie: admin },
    });

  /** Duplique les fixtures qualifiées jusqu'à `TARGET` dossiers, ports distincts. */
  async function populate(): Promise<string[]> {
    const names = (await readdir(FIXTURES, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('not-a-server'))
      .map((e) => e.name)
      .sort();
    const created: string[] = [];
    let port = 30_000;
    for (let i = 0; created.length < TARGET; i++) {
      const src = names[i % names.length]!;
      const name = `${src}-${String(Math.floor(i / names.length) + 1)}`;
      const dest = path.join(root, name);
      await cp(path.join(FIXTURES, src), dest, { recursive: true });
      const props = path.join(dest, 'server.properties');
      const existing = await readFile(props, 'utf8').catch(() => '');
      const lines = existing.split(/\r?\n/).filter((l) => !l.startsWith('server-port='));
      lines.push(`server-port=${String(port++)}`);
      await writeFile(props, `${lines.join('\n')}\n`);
      await writeFile(path.join(dest, 'eula.txt'), 'eula=true\n');
      created.push(name);
    }
    return created;
  }

  it('56 serveurs détectés, 4 fake simultanés avec métriques, 48 h de métriques agrégées sous bornes', async () => {
    const names = await populate();
    expect(names).toHaveLength(TARGET);

    // --- Agent réel, scan de la racine ------------------------------------------------------
    let res = await api('POST', '/api/machines', { name: 'Grosse machine' });
    const { machine, pairing } = res.json<{
      machine: { id: string };
      pairing: { code: string };
    }>();
    const state = await tmpDir('mmo-scale-state-');
    cleanups.push(state.cleanup);
    const rconFrom = await freePort();
    agent = new Agent({
      stateDir: state.dir,
      panelUrl: `${panel.wsUrl}/ws/agent`,
      pairCode: pairing.code,
      logger: new Logger('agent', { stderr: false }),
      scanIntervalMs: 0,
      trashPurgeIntervalMs: 0,
      metricsIntervalMs: 500,
      backupSchedulerTickMs: 0,
      restrictPermissions: false,
      backoff: { baseMs: 50, maxMs: 200 },
      manager: {
        commandBuilder: (ctx) => ({
          file: process.execPath,
          args: [FAKE_SERVER, '--done-after', '50', '--tps'],
          cwd: ctx.config.path,
          cmdlineKey: 'fake-java-server.mjs',
          files: [],
        }),
        javaResolver: () =>
          Promise.resolve({
            majorVersion: 21,
            vendor: 'fake',
            path: process.execPath,
            managed: false,
          }),
        totalRamMb: () => 65_536,
        rconPortRange: [rconFrom, 65000],
        rconProbeIntervalMs: 200,
        exitPollMs: 100,
      },
    });
    await agent.start();
    await waitFor(() => panel.ctx.registry.isConnected(machine.id), 10_000);
    res = await api('POST', `/api/machines/${machine.id}/directories`, { path: root });
    expect(res.statusCode).toBe(201);

    const t0 = performance.now();
    res = await api('POST', `/api/machines/${machine.id}/scan`, {});
    const scanMs = performance.now() - t0;
    expect(res.statusCode).toBe(200);
    const scanned = res.json<{ servers: ServerDto[] }>().servers;
    expect(scanned).toHaveLength(TARGET);
    expect(scanMs).toBeLessThan(30_000);
    // Tous ont un loader et une version (les fixtures sont des installations réelles).
    for (const s of scanned) {
      expect(s.loader, s.name).not.toBe('unknown');
      expect(s.mcVersion, s.name).toBeTruthy();
    }
    // Liste complète et page machine rapides (< 250 ms) ; aucun conflit.
    const t1 = performance.now();
    res = await api('GET', '/api/servers');
    expect(res.json<{ servers: ServerDto[] }>().servers).toHaveLength(TARGET);
    expect(performance.now() - t1).toBeLessThan(250);
    res = await api('GET', '/api/servers/conflicts');
    expect(res.json<{ conflicts: unknown[] }>().conflicts).toHaveLength(0);
    // Un second scan ne crée rien (ré-identification par marqueur).
    res = await api('POST', `/api/machines/${machine.id}/scan`, {});
    expect(res.json<{ servers: ServerDto[] }>().servers).toHaveLength(TARGET);
    expect(panel.ctx.servers.list()).toHaveLength(TARGET);
    await waitFor(() => Object.keys(agent!.store.get().servers).length === TARGET, 10_000);

    // --- 4 démarrages simultanés ----------------------------------------------------------------
    const four = scanned.slice(0, 4).map((s) => s.id);
    const starts = await Promise.all(four.map((id) => api('POST', `/api/servers/${id}/start`)));
    for (const r of starts) expect(r.statusCode, r.body).toBe(200);
    await waitFor(
      () => four.every((id) => panel.ctx.servers.require(id).runState === 'running'),
      20_000,
    );
    // Métriques temps réel pour les 4 (RSS/CPU par serveur) et la machine. 60 s : le premier RSS
    // attend le démarrage du sidecar Windows, lent sur les runners CI chargés (4 serveurs, 2 cœurs).
    await waitFor(() => {
      const now = Date.now();
      return four.every((id) => {
        const q = panel.ctx.metricsService.queryServer(id, { from: now - 60_000 });
        return q.latest !== null && q.latest.ram !== null;
      });
    }, 60_000);
    const machineNow = panel.ctx.metricsService.queryMachine(machine.id, {
      from: Date.now() - 60_000,
    });
    expect(machineNow.latest).not.toBeNull();
    const stops = await Promise.all(four.map((id) => api('POST', `/api/servers/${id}/stop`)));
    for (const r of stops) expect(r.statusCode, r.body).toBe(200);
    await waitFor(
      () => four.every((id) => panel.ctx.servers.require(id).runState === 'stopped'),
      20_000,
    );

    // --- 48 h de métriques synthétiques pour les 56 serveurs ------------------------------------
    const end = Date.now();
    const begin = end - RETENTION.rawMs;
    const all = panel.ctx.servers.list().map((s) => s.id);
    const t2 = performance.now();
    let samples = 0;
    for (let ts = begin; ts < end; ts += STEP) {
      const i = samples++;
      panel.ctx.metricsService.ingest(machine.id, {
        ts,
        machine: { cpuPct: (i % 100) + 0.5, ramUsedMb: 20_000 + (i % 1000), ramTotalMb: 65_536 },
        servers: all.map((serverId, k) => ({
          serverId,
          cpuPct: ((i + k) % 50) + 1,
          rssMb: 2048 + ((i + k) % 512),
          tps: 20 - ((i + k) % 4) * 0.25,
          tpsSource: 'forge' as const,
          players: (i + k) % 8,
        })),
      });
      // Le job tourne toutes les heures comme `runMaintenance` (flush groupé + agrégats).
      if (i % (HOUR / STEP) === 0) panel.ctx.metricsService.maintain(ts);
    }
    panel.ctx.metricsService.flush();
    const result = panel.ctx.metricsService.maintain(end + 1);
    const ingestMs = performance.now() - t2;
    expect(samples).toBe(RETENTION.rawMs / STEP);
    expect(result.hours).toBeGreaterThan(0);
    // Ingestion + agrégation de 645 k lignes serveur en moins de 2 min sur la machine de test.
    expect(ingestMs).toBeLessThan(120_000);

    // Requêtes API : 48 h (1 min ⇒ 2 880 points max), 7 j (1 h), brut 1 h — chacune < 500 ms.
    const target = all[TARGET - 1]!;
    const timings: Record<string, number> = {};
    const q = async (label: string, query: string) => {
      const t = performance.now();
      const r = await api('GET', `/api/servers/${target}/metrics?${query}`);
      timings[label] = performance.now() - t;
      expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
      return r.json<{ resolution: string; points: unknown[]; latest: unknown }>();
    };
    const day2 = await q('48h', `from=${String(begin)}&to=${String(end)}`);
    expect(day2.resolution).toBe('1m');
    expect(day2.points.length).toBeGreaterThan(2_800);
    expect(day2.points.length).toBeLessThanOrEqual(2_880);
    const week = await q('7d', `from=${String(end - 7 * 24 * HOUR)}&to=${String(end)}`);
    expect(week.resolution).toBe('1h');
    expect(week.points.length).toBeGreaterThanOrEqual(47);
    const raw = await q('1h', `from=${String(end - HOUR)}&to=${String(end)}`);
    expect(raw.resolution).toBe('raw');
    expect(raw.points.length).toBeGreaterThan(200);
    for (const [label, ms] of Object.entries(timings)) expect(ms, label).toBeLessThan(500);

    // Purge : rien de brut avant `end - 48 h` après maintenance (les toutes premières lignes).
    const oldest = panel.ctx.metricsSqlite
      .prepare('SELECT MIN(ts) AS ts FROM metrics_server_raw')
      .get() as { ts: number | null };
    expect(oldest.ts === null || oldest.ts >= end + 1 - RETENTION.rawMs).toBe(true);
  }, 240_000);
});
