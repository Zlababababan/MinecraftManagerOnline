/**
 * Critère phase 7 (doc 07) : « graphiques exacts après 48 h de données synthétiques » — le
 * downsampling brut → 1 min → 1 h reproduit exactement moyennes/extrema, la purge respecte les
 * rétentions, les rejeux tardifs sont réagrégés, les écritures sont groupées.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openMetricsDatabase, type OpenedDatabase, type MetricsDatabase } from '../db/client.js';
import { HOUR, MINUTE, MetricsService, autoResolution, type MetricsSample } from './metrics.js';

const T0 = 1_787_300_000_000 - (1_787_300_000_000 % HOUR); // heure ronde
const STEP = 15_000;

/** Fonctions synthétiques déterministes (périodiques, exactes en arithmétique flottante raisonnable). */
function synth(i: number) {
  return {
    cpu: 10 + (i % 8) * 5, // 10..45 par période de 8 échantillons (2 min)
    ram: 1000 + (i % 240) * 4, // rampe par heure
    tps: 20 - (i % 4) * 0.5, // 20, 19.5, 19, 18.5
    players: i % 3, // 0,1,2
    mcpu: (i % 16) * 2.5,
    mram: 8000 + (i % 60) * 10,
  };
}

function sampleAt(i: number): MetricsSample {
  const s = synth(i);
  return {
    ts: T0 + i * STEP,
    machine: {
      cpuPct: s.mcpu,
      ramUsedMb: s.mram,
      ramTotalMb: 32_768,
      diskUsedGb: 100,
      diskTotalGb: 500,
    },
    servers: [
      {
        serverId: 'srv_a',
        cpuPct: s.cpu,
        rssMb: s.ram,
        tps: s.tps,
        mspt: 50 - s.tps,
        tpsSource: 'forge',
        players: s.players,
      },
      { serverId: 'srv_b', rssMb: 512, players: 0 },
    ],
    cpuSource: 'cycles',
  };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

describe('MetricsService — downsampling et purge (doc 04 §7)', () => {
  let opened: OpenedDatabase<MetricsDatabase>;
  let now: number;
  let service: MetricsService;
  const broadcasts: string[] = [];

  beforeEach(() => {
    opened = openMetricsDatabase(':memory:');
    now = T0;
    broadcasts.length = 0;
    service = new MetricsService({
      sqlite: opened.sqlite,
      now: () => now,
      flushIntervalMs: 0,
      onSample: (machineId) => {
        broadcasts.push(machineId);
      },
    });
  });
  afterEach(() => {
    service.close();
    opened.close();
  });

  function count(table: string, where = '1=1'): number {
    return (
      opened.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as {
        n: number;
      }
    ).n;
  }

  it('50 h de données synthétiques, job horaire : 1 min et 1 h exacts, brut purgé à 48 h', () => {
    const hours = 50;
    const total = (hours * HOUR) / STEP;
    for (let i = 0; i < total; i++) {
      now = T0 + i * STEP;
      service.ingest('m1', sampleAt(i));
      // Le job tourne toutes les heures (comme `runMaintenance`).
      if (i % (HOUR / STEP) === 0) service.maintain(now);
    }
    now = T0 + hours * HOUR;
    const result = service.maintain(now);
    expect(result.purged).toBeGreaterThan(0);
    expect(broadcasts).toHaveLength(total);

    // Brut : exactement les 48 dernières heures (le dernier échantillon date de now − 15 s), 2 serveurs
    expect(count('metrics_server_raw', "server_id = 'srv_a'")).toBe((48 * HOUR) / STEP);
    expect(count('metrics_machine_raw')).toBe((48 * HOUR) / STEP);
    // 1 min : toutes les minutes complètes (le dernier échantillon tombe sur une minute ronde non close)
    expect(count('metrics_server_1m', "server_id = 'srv_a'")).toBe(hours * 60);
    expect(count('metrics_server_1m', "server_id = 'srv_b'")).toBe(hours * 60);
    expect(count('metrics_machine_1m')).toBe(hours * 60);
    // 1 h : 50 heures complètes
    expect(count('metrics_server_1h', "server_id = 'srv_a'")).toBe(hours);
    expect(count('metrics_machine_1h')).toBe(hours);

    // Exactitude d'une minute arbitraire (la 7e minute de la 3e heure)
    const minuteIndex = 3 * 60 + 7;
    const first = minuteIndex * 4;
    const window = [0, 1, 2, 3].map((k) => synth(first + k));
    const m = opened.sqlite
      .prepare(`SELECT * FROM metrics_server_1m WHERE server_id = 'srv_a' AND ts = ?`)
      .get(T0 + minuteIndex * MINUTE) as Record<string, number>;
    expect(m.samples).toBe(4);
    expect(m.cpu_avg).toBeCloseTo(mean(window.map((w) => w.cpu)), 9);
    expect(m.cpu_max).toBe(Math.max(...window.map((w) => w.cpu)));
    expect(m.ram_avg).toBe(Math.round(mean(window.map((w) => w.ram))));
    expect(m.ram_max).toBe(Math.max(...window.map((w) => w.ram)));
    expect(m.tps_avg).toBeCloseTo(mean(window.map((w) => w.tps)), 9);
    expect(m.tps_min).toBe(Math.min(...window.map((w) => w.tps)));
    expect(m.players_max).toBe(Math.max(...window.map((w) => w.players)));

    // Exactitude d'une heure (la 3e), y compris une heure dont le brut a été purgé (la 1re)
    for (const hour of [0, 2, 49]) {
      const firstSample = hour * 240;
      const win = Array.from({ length: 240 }, (_, k) => synth(firstSample + k));
      const h = opened.sqlite
        .prepare(`SELECT * FROM metrics_server_1h WHERE server_id = 'srv_a' AND ts = ?`)
        .get(T0 + hour * HOUR) as Record<string, number>;
      expect(h.samples).toBe(240);
      expect(h.cpu_avg).toBeCloseTo(mean(win.map((w) => w.cpu)), 9);
      expect(h.cpu_max).toBe(Math.max(...win.map((w) => w.cpu)));
      expect(h.ram_avg).toBe(Math.round(mean(win.map((w) => w.ram))));
      expect(h.tps_avg).toBeCloseTo(mean(win.map((w) => w.tps)), 9);
      expect(h.tps_min).toBe(18.5);
      expect(h.players_max).toBe(2);
      const mh = opened.sqlite
        .prepare(`SELECT * FROM metrics_machine_1h WHERE machine_id = 'm1' AND ts = ?`)
        .get(T0 + hour * HOUR) as Record<string, number>;
      expect(mh.cpu_avg).toBeCloseTo(mean(win.map((w) => w.mcpu)), 9);
      expect(mh.ram_max).toBe(Math.max(...win.map((w) => w.mram)));
      expect(mh.disk_total_gb).toBe(500);
    }
    // srv_b n'a jamais eu de CPU/TPS : agrégats NULL, pas de division par zéro
    const b = opened.sqlite
      .prepare(`SELECT * FROM metrics_server_1h WHERE server_id = 'srv_b' AND ts = ?`)
      .get(T0 + 2 * HOUR) as Record<string, number | null>;
    expect(b.cpu_avg).toBeNull();
    expect(b.tps_avg).toBeNull();
    expect(b.ram_avg).toBe(512);

    // Idempotence : un second passage ne change rien
    const before = {
      m: count('metrics_server_1m'),
      h: count('metrics_server_1h'),
      r: count('metrics_server_raw'),
    };
    service.maintain(now);
    expect({
      m: count('metrics_server_1m'),
      h: count('metrics_server_1h'),
      r: count('metrics_server_raw'),
    }).toEqual(before);

    // Lectures : résolution automatique et plages
    const raw = service.queryServer('srv_a', { from: now - HOUR });
    expect(raw.resolution).toBe('raw');
    expect(raw.points).toHaveLength(HOUR / STEP);
    expect(raw.points[0]).toMatchObject({ ts: now - HOUR, cpu: synth(total - 240).cpu });
    expect(raw.tpsSource).toBe('forge');
    expect(raw.cpuSource).toBe('cycles');
    expect(raw.latest).toMatchObject({
      ts: T0 + (total - 1) * STEP,
      players: synth(total - 1).players,
    });
    const minutes = service.queryServer('srv_a', { from: now - 24 * HOUR });
    expect(minutes.resolution).toBe('1m');
    expect(minutes.points).toHaveLength(24 * 60);
    expect(minutes.points[0]?.samples).toBe(4);
    const hoursQ = service.queryServer('srv_a', { from: now - 7 * 24 * HOUR, to: now });
    expect(hoursQ.resolution).toBe('1h');
    expect(hoursQ.points).toHaveLength(hours);
    expect(hoursQ.points.map((p) => p.ts)).toEqual(
      Array.from({ length: hours }, (_, i) => T0 + i * HOUR),
    );
    const forced = service.queryServer('srv_a', { from: now - 2 * HOUR, resolution: '1h' });
    expect(forced.points).toHaveLength(2);
    const machine = service.queryMachine('m1', { from: now - 30 * MINUTE });
    expect(machine.resolution).toBe('raw');
    expect(machine.points).toHaveLength((30 * MINUTE) / STEP);
    expect(machine.latest).toMatchObject({ diskTotalGb: 500 });
    expect(service.queryServer('nope', { from: 0 })).toMatchObject({ points: [], latest: null });
  });

  it('rejeu tardif (tampon agent) : les minutes et heures concernées sont réagrégées', () => {
    for (let i = 0; i < 480; i++) service.ingest('m1', sampleAt(i)); // 2 h, sans l'échantillon 479 en double
    now = T0 + 2 * HOUR + MINUTE;
    service.maintain(now);
    expect(count('metrics_server_1h', "server_id = 'srv_a'")).toBe(2);
    // On retire artificiellement une minute de la 1re heure puis on la rejoue plus tard
    opened.sqlite
      .prepare(`DELETE FROM metrics_server_1m WHERE server_id = 'srv_a' AND ts = ?`)
      .run(T0 + 10 * MINUTE);
    opened.sqlite
      .prepare(`DELETE FROM metrics_server_raw WHERE ts >= ? AND ts < ?`)
      .run(T0 + 10 * MINUTE, T0 + 11 * MINUTE);
    service.maintain(now);
    const hourBefore = opened.sqlite
      .prepare(`SELECT samples FROM metrics_server_1h WHERE server_id = 'srv_a' AND ts = ?`)
      .get(T0) as { samples: number };
    expect(hourBefore.samples).toBe(240); // l'heure n'est pas réagrégée sans rejeu
    for (let k = 0; k < 4; k++) service.ingest('m1', sampleAt(40 + k)); // minute 10 rejouée
    service.maintain(now);
    expect(
      count('metrics_server_1m', `server_id = 'srv_a' AND ts = ${String(T0 + 10 * MINUTE)}`),
    ).toBe(1);
    const hourAfter = opened.sqlite
      .prepare(`SELECT samples FROM metrics_server_1h WHERE server_id = 'srv_a' AND ts = ?`)
      .get(T0) as { samples: number };
    expect(hourAfter.samples).toBe(240);
  });

  it('écritures groupées : rien en base avant flush, une transaction pour tout le lot', () => {
    const batched = new MetricsService({
      sqlite: opened.sqlite,
      now: () => now,
      flushIntervalMs: 60_000,
      flushBatchSize: 1000,
    });
    for (let i = 0; i < 50; i++) batched.ingest('m1', sampleAt(i));
    expect(batched.pendingCount).toBe(50);
    expect(count('metrics_server_raw')).toBe(0);
    expect(batched.flush()).toBe(50);
    expect(count('metrics_server_raw')).toBe(100);
    expect(count('metrics_machine_raw')).toBe(50);
    // Un échantillon identique (même ts) remplace au lieu de dupliquer
    batched.ingest('m1', sampleAt(0));
    batched.flush();
    expect(count('metrics_machine_raw')).toBe(50);
    // Le seuil de lot déclenche l'écriture sans attendre le délai
    const eager = new MetricsService({
      sqlite: opened.sqlite,
      now: () => now,
      flushIntervalMs: 60_000,
      flushBatchSize: 3,
    });
    eager.ingest('m2', sampleAt(0));
    eager.ingest('m2', sampleAt(1));
    expect(count('metrics_machine_raw', "machine_id = 'm2'")).toBe(0);
    eager.ingest('m2', sampleAt(2));
    expect(count('metrics_machine_raw', "machine_id = 'm2'")).toBe(3);
    batched.close();
    eager.close();
    // Suppression d'un serveur : toutes ses lignes disparaissent
    service.deleteServer('srv_a');
    expect(count('metrics_server_raw', "server_id = 'srv_a'")).toBe(0);
    expect(count('metrics_server_raw', "server_id = 'srv_b'")).toBe(50);
  });

  it('autoResolution : brut ≤ 3 h, 1 min ≤ 3 j, sinon 1 h', () => {
    expect(autoResolution(HOUR)).toBe('raw');
    expect(autoResolution(3 * HOUR)).toBe('raw');
    expect(autoResolution(24 * HOUR)).toBe('1m');
    expect(autoResolution(4 * 24 * HOUR)).toBe('1h');
  });
});

describe('metrics.db — auto_vacuum (doc 04 §7)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mmo-metrics-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Régression : `auto_vacuum` était posé APRÈS `journal_mode = WAL`, qui fige la valeur à 0 —
  // même sur une base sans aucune table. `incremental_vacuum` ne rendait donc jamais un octet.
  // Le test doit porter sur un vrai fichier : une base `:memory:` ne passe pas en WAL.
  it('une base neuve est créée en INCREMENTAL, et en WAL', () => {
    const opened = openMetricsDatabase(path.join(dir, 'metrics.db'));
    expect(opened.sqlite.pragma('auto_vacuum', { simple: true })).toBe(2);
    expect(opened.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    opened.close();
  });

  it('une base existante restée en auto_vacuum=0 est rattrapée une seule fois par maintain()', () => {
    const file = path.join(dir, 'metrics.db');
    // Reproduit une base d'avant le correctif : schéma en place, auto_vacuum à 0.
    openMetricsDatabase(file).close();
    const legacy = new DatabaseSync(file);
    legacy.exec('PRAGMA auto_vacuum = NONE');
    legacy.exec('VACUUM');
    expect(legacy.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 0 });
    legacy.close();

    const opened = openMetricsDatabase(file);
    const service = new MetricsService({
      sqlite: opened.sqlite,
      now: () => T0,
      flushIntervalMs: 0,
    });
    const first = service.maintain(T0);
    expect(first.compactedMs).toBeGreaterThanOrEqual(0);
    expect(opened.sqlite.pragma('auto_vacuum', { simple: true })).toBe(2);

    // Une seule tentative par démarrage : le passage suivant ne recompacte pas.
    const second = service.maintain(T0 + 2 * HOUR);
    expect(second.compactedMs).toBeUndefined();
    service.close();
    opened.close();
  });
});
