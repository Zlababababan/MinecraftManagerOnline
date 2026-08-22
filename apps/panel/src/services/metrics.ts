/**
 * Métriques (doc 04 §7) : `metrics.sample` des agents → `metrics.db`, **par lots et transactions
 * groupées** (jamais un INSERT par échantillon) ; job horaire de downsampling brut → 1 min → 1 h
 * (min/max/avg, moyennes pondérées par `samples`) et purge (brut 48 h, 1 min 14 j, 1 h 2 ans),
 * `incremental_vacuum` occasionnel ; lectures par plage avec résolution automatique.
 */
import type Database from 'better-sqlite3';

import type { EventPayload } from '@mmo/protocol';
import type {
  MachineMetricsPoint,
  MachineMetricsResult,
  MetricsQuery,
  MetricsResolution,
  MetricsSampleDto,
  ServerMetricsPoint,
  ServerMetricsResult,
} from '@mmo/protocol/client';

export type MetricsSample = EventPayload<'metrics.sample'>;

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RETENTION = {
  rawMs: 48 * HOUR,
  minuteMs: 14 * DAY,
  hourMs: 2 * 365 * DAY,
} as const;

/** Seuils de résolution automatique : brut ≤ 3 h, 1 min ≤ 3 j, sinon 1 h. */
export function autoResolution(spanMs: number): MetricsResolution {
  if (spanMs <= 3 * HOUR) return 'raw';
  if (spanMs <= 3 * DAY) return '1m';
  return '1h';
}

export interface MetricsServiceOptions {
  sqlite: Database.Database;
  now: () => number;
  /** Délai max entre deux écritures groupées (défaut 5 s) ; 0 = écriture immédiate (tests). */
  flushIntervalMs?: number;
  /** Taille de lot déclenchant une écriture anticipée (défaut 200 échantillons). */
  flushBatchSize?: number;
  onSample?: (machineId: string, sample: MetricsSampleDto) => void;
}

interface PendingSample {
  machineId: string;
  sample: MetricsSample;
}

interface LatestServer {
  point: ServerMetricsPoint;
  tpsSource: ServerMetricsResult['tpsSource'];
  cpuSource: ServerMetricsResult['cpuSource'];
}

interface LatestMachine {
  point: MachineMetricsPoint;
  cpuSource: MachineMetricsResult['cpuSource'];
}

export class MetricsService {
  private pending: PendingSample[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly latestServer = new Map<string, LatestServer>();
  private readonly latestMachine = new Map<string, LatestMachine>();
  private lastVacuumAt = 0;
  /** Plus ancien timestamp ingéré depuis la dernière agrégation (rejeux tardifs : tampon agent 1 h). */
  private dirtySince: number | undefined;
  private readonly stmts;
  private readonly insertBatch: (rows: PendingSample[]) => void;

  constructor(private readonly options: MetricsServiceOptions) {
    const db = options.sqlite;
    this.stmts = {
      serverRaw: db.prepare(
        `INSERT OR REPLACE INTO metrics_server_raw (server_id, ts, cpu_pct, ram_mb, tps, mspt, players)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      machineRaw: db.prepare(
        `INSERT OR REPLACE INTO metrics_machine_raw (machine_id, ts, cpu_pct, ram_used_mb, disk_used_gb, disk_total_gb)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
    };
    this.insertBatch = db.transaction((rows: PendingSample[]) => {
      for (const { machineId, sample } of rows) {
        this.stmts.machineRaw.run(
          machineId,
          sample.ts,
          sample.machine.cpuPct ?? null,
          sample.machine.ramUsedMb ?? null,
          sample.machine.diskUsedGb ?? null,
          sample.machine.diskTotalGb ?? null,
        );
        for (const s of sample.servers) {
          this.stmts.serverRaw.run(
            s.serverId,
            sample.ts,
            s.cpuPct ?? null,
            s.rssMb ?? null,
            s.tps ?? null,
            s.mspt ?? null,
            s.players ?? null,
          );
        }
      }
    });
  }

  // --- Ingestion ------------------------------------------------------------------------------------

  /** Reçoit un échantillon (écrit par lots) et met à jour l'état « maintenant ». */
  ingest(machineId: string, sample: MetricsSample): void {
    this.pending.push({ machineId, sample });
    if (this.dirtySince === undefined || sample.ts < this.dirtySince) this.dirtySince = sample.ts;
    const cpuSource = sample.cpuSource ?? null;
    const previous = this.latestMachine.get(machineId);
    if (previous === undefined || previous.point.ts <= sample.ts) {
      this.latestMachine.set(machineId, {
        point: {
          ts: sample.ts,
          cpu: sample.machine.cpuPct ?? null,
          ram: sample.machine.ramUsedMb ?? null,
          diskUsedGb: sample.machine.diskUsedGb ?? null,
          diskTotalGb: sample.machine.diskTotalGb ?? null,
        },
        cpuSource,
      });
    }
    for (const s of sample.servers) {
      const prev = this.latestServer.get(s.serverId);
      if (prev !== undefined && prev.point.ts > sample.ts) continue;
      this.latestServer.set(s.serverId, {
        point: {
          ts: sample.ts,
          cpu: s.cpuPct ?? null,
          ram: s.rssMb ?? null,
          tps: s.tps ?? null,
          mspt: s.mspt ?? null,
          players: s.players ?? null,
        },
        tpsSource: s.tpsSource ?? null,
        cpuSource,
      });
    }
    this.options.onSample?.(machineId, sample);
    const interval = this.options.flushIntervalMs ?? 5000;
    if (interval <= 0 || this.pending.length >= (this.options.flushBatchSize ?? 200)) {
      this.flush();
      return;
    }
    this.flushTimer ??= setTimeout(() => {
      this.flush();
    }, interval);
    this.flushTimer.unref();
  }

  /** Écrit les échantillons en attente en une transaction. Retourne le nombre d'échantillons écrits. */
  flush(): number {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const rows = this.pending;
    if (rows.length === 0) return 0;
    this.pending = [];
    this.insertBatch(rows);
    return rows.length;
  }

  /** Oublie l'état « maintenant » d'une machine déconnectée (ses serveurs aussi). */
  forgetMachine(machineId: string, serverIds: string[]): void {
    this.latestMachine.delete(machineId);
    for (const id of serverIds) this.latestServer.delete(id);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  // --- Downsampling et purge ----------------------------------------------------------------------

  /**
   * Agrège les tranches **complètes** non encore agrégées (brut → 1 min, 1 min → 1 h) puis purge
   * les tranches expirées. Idempotent ; ré-exécutable à tout moment (`INSERT OR REPLACE`).
   */
  maintain(now = this.options.now()): { minutes: number; hours: number; purged: number } {
    this.flush();
    const db = this.options.sqlite;
    const minuteEnd = Math.floor(now / MINUTE) * MINUTE;
    const hourEnd = Math.floor(now / HOUR) * HOUR;
    const dirty = this.dirtySince;
    this.dirtySince = undefined;
    const run = db.transaction(() => {
      const minutes = this.rollupMinutes(minuteEnd, dirty);
      const hours = this.rollupHours(hourEnd, dirty);
      let purged = 0;
      purged += db
        .prepare('DELETE FROM metrics_server_raw WHERE ts < ?')
        .run(now - RETENTION.rawMs).changes;
      purged += db
        .prepare('DELETE FROM metrics_machine_raw WHERE ts < ?')
        .run(now - RETENTION.rawMs).changes;
      purged += db
        .prepare('DELETE FROM metrics_server_1m WHERE ts < ?')
        .run(now - RETENTION.minuteMs).changes;
      purged += db
        .prepare('DELETE FROM metrics_machine_1m WHERE ts < ?')
        .run(now - RETENTION.minuteMs).changes;
      purged += db
        .prepare('DELETE FROM metrics_server_1h WHERE ts < ?')
        .run(now - RETENTION.hourMs).changes;
      purged += db
        .prepare('DELETE FROM metrics_machine_1h WHERE ts < ?')
        .run(now - RETENTION.hourMs).changes;
      return { minutes, hours, purged };
    });
    const result = run();
    if (now - this.lastVacuumAt >= DAY) {
      this.lastVacuumAt = now;
      db.pragma('incremental_vacuum(200)');
    }
    return result;
  }

  private rollupMinutes(end: number, dirty: number | undefined): number {
    const db = this.options.sqlite;
    // Reprise depuis la dernière tranche agrégée (réagrégée), ou plus tôt si des rejeux tardifs sont arrivés.
    const fromServer = this.resumeFrom('metrics_server_1m', 'metrics_server_raw', MINUTE, dirty);
    const fromMachine = this.resumeFrom('metrics_machine_1m', 'metrics_machine_raw', MINUTE, dirty);
    let n = 0;
    if (fromServer !== undefined && fromServer < end) {
      n += db
        .prepare(
          `INSERT OR REPLACE INTO metrics_server_1m
             (server_id, ts, cpu_avg, cpu_max, ram_avg, ram_max, tps_avg, tps_min, players_max, samples)
           SELECT server_id, (ts / ${String(MINUTE)}) * ${String(MINUTE)},
                  AVG(cpu_pct), MAX(cpu_pct), CAST(ROUND(AVG(ram_mb)) AS INTEGER), MAX(ram_mb),
                  AVG(tps), MIN(tps), MAX(players), COUNT(*)
           FROM metrics_server_raw WHERE ts >= ? AND ts < ?
           GROUP BY server_id, (ts / ${String(MINUTE)})`,
        )
        .run(fromServer, end).changes;
    }
    if (fromMachine !== undefined && fromMachine < end) {
      n += db
        .prepare(
          `INSERT OR REPLACE INTO metrics_machine_1m
             (machine_id, ts, cpu_avg, cpu_max, ram_avg, ram_max, disk_used_gb, disk_total_gb, samples)
           SELECT machine_id, (ts / ${String(MINUTE)}) * ${String(MINUTE)},
                  AVG(cpu_pct), MAX(cpu_pct), CAST(ROUND(AVG(ram_used_mb)) AS INTEGER), MAX(ram_used_mb),
                  MAX(disk_used_gb), MAX(disk_total_gb), COUNT(*)
           FROM metrics_machine_raw WHERE ts >= ? AND ts < ?
           GROUP BY machine_id, (ts / ${String(MINUTE)})`,
        )
        .run(fromMachine, end).changes;
    }
    return n;
  }

  private rollupHours(end: number, dirty: number | undefined): number {
    const db = this.options.sqlite;
    const fromServer = this.resumeFrom('metrics_server_1h', 'metrics_server_1m', HOUR, dirty);
    const fromMachine = this.resumeFrom('metrics_machine_1h', 'metrics_machine_1m', HOUR, dirty);
    let n = 0;
    if (fromServer !== undefined && fromServer < end) {
      n += db
        .prepare(
          `INSERT OR REPLACE INTO metrics_server_1h
             (server_id, ts, cpu_avg, cpu_max, ram_avg, ram_max, tps_avg, tps_min, players_max, samples)
           SELECT server_id, (ts / ${String(HOUR)}) * ${String(HOUR)},
                  SUM(cpu_avg * samples) / SUM(CASE WHEN cpu_avg IS NULL THEN 0 ELSE samples END),
                  MAX(cpu_max),
                  CAST(ROUND(SUM(ram_avg * 1.0 * samples) / SUM(CASE WHEN ram_avg IS NULL THEN 0 ELSE samples END)) AS INTEGER),
                  MAX(ram_max),
                  SUM(tps_avg * samples) / SUM(CASE WHEN tps_avg IS NULL THEN 0 ELSE samples END),
                  MIN(tps_min), MAX(players_max), SUM(samples)
           FROM metrics_server_1m WHERE ts >= ? AND ts < ?
           GROUP BY server_id, (ts / ${String(HOUR)})`,
        )
        .run(fromServer, end).changes;
    }
    if (fromMachine !== undefined && fromMachine < end) {
      n += db
        .prepare(
          `INSERT OR REPLACE INTO metrics_machine_1h
             (machine_id, ts, cpu_avg, cpu_max, ram_avg, ram_max, disk_used_gb, disk_total_gb, samples)
           SELECT machine_id, (ts / ${String(HOUR)}) * ${String(HOUR)},
                  SUM(cpu_avg * samples) / SUM(CASE WHEN cpu_avg IS NULL THEN 0 ELSE samples END),
                  MAX(cpu_max),
                  CAST(ROUND(SUM(ram_avg * 1.0 * samples) / SUM(CASE WHEN ram_avg IS NULL THEN 0 ELSE samples END)) AS INTEGER),
                  MAX(ram_max),
                  MAX(disk_used_gb), MAX(disk_total_gb), SUM(samples)
           FROM metrics_machine_1m WHERE ts >= ? AND ts < ?
           GROUP BY machine_id, (ts / ${String(HOUR)})`,
        )
        .run(fromMachine, end).changes;
    }
    return n;
  }

  /**
   * Début de la prochaine agrégation : dernière tranche agrégée (incluse) — ou la tranche du plus
   * ancien rejeu tardif si elle est antérieure — sinon première donnée source.
   */
  private resumeFrom(
    target: string,
    source: string,
    bucketMs: number,
    dirty: number | undefined,
  ): number | undefined {
    const db = this.options.sqlite;
    const last = db.prepare(`SELECT MAX(ts) AS ts FROM ${target}`).get() as { ts: number | null };
    const dirtyBucket = dirty === undefined ? undefined : Math.floor(dirty / bucketMs) * bucketMs;
    if (last.ts !== null)
      return dirtyBucket === undefined ? last.ts : Math.min(last.ts, dirtyBucket);
    const first = db.prepare(`SELECT MIN(ts) AS ts FROM ${source}`).get() as { ts: number | null };
    if (first.ts === null) return undefined;
    return Math.floor(first.ts / bucketMs) * bucketMs;
  }

  // --- Lectures -----------------------------------------------------------------------------------

  queryServer(serverId: string, query: MetricsQuery): ServerMetricsResult {
    this.flush();
    const to = query.to ?? this.options.now();
    const from = Math.min(query.from, to);
    const resolution = query.resolution ?? autoResolution(to - from);
    const db = this.options.sqlite;
    let points: ServerMetricsPoint[];
    if (resolution === 'raw') {
      points = (
        db
          .prepare(
            `SELECT ts, cpu_pct, ram_mb, tps, mspt, players FROM metrics_server_raw
             WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
          )
          .all(serverId, from, to) as {
          ts: number;
          cpu_pct: number | null;
          ram_mb: number | null;
          tps: number | null;
          mspt: number | null;
          players: number | null;
        }[]
      ).map((r) => ({
        ts: r.ts,
        cpu: r.cpu_pct,
        ram: r.ram_mb,
        tps: r.tps,
        mspt: r.mspt,
        players: r.players,
      }));
    } else {
      const table = resolution === '1m' ? 'metrics_server_1m' : 'metrics_server_1h';
      points = (
        db
          .prepare(
            `SELECT ts, cpu_avg, cpu_max, ram_avg, ram_max, tps_avg, tps_min, players_max, samples
             FROM ${table} WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
          )
          .all(serverId, from, to) as {
          ts: number;
          cpu_avg: number | null;
          cpu_max: number | null;
          ram_avg: number | null;
          ram_max: number | null;
          tps_avg: number | null;
          tps_min: number | null;
          players_max: number | null;
          samples: number;
        }[]
      ).map((r) => ({
        ts: r.ts,
        cpu: r.cpu_avg,
        cpuMax: r.cpu_max,
        ram: r.ram_avg,
        ramMax: r.ram_max,
        tps: r.tps_avg,
        tpsMin: r.tps_min,
        players: r.players_max,
        samples: r.samples,
      }));
    }
    const latest = this.latestServer.get(serverId);
    return {
      resolution,
      from,
      to,
      points,
      latest: latest?.point ?? null,
      tpsSource: latest?.tpsSource ?? null,
      cpuSource: latest?.cpuSource ?? null,
    };
  }

  queryMachine(machineId: string, query: MetricsQuery): MachineMetricsResult {
    this.flush();
    const to = query.to ?? this.options.now();
    const from = Math.min(query.from, to);
    const resolution = query.resolution ?? autoResolution(to - from);
    const db = this.options.sqlite;
    let points: MachineMetricsPoint[];
    if (resolution === 'raw') {
      points = (
        db
          .prepare(
            `SELECT ts, cpu_pct, ram_used_mb, disk_used_gb, disk_total_gb FROM metrics_machine_raw
             WHERE machine_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
          )
          .all(machineId, from, to) as {
          ts: number;
          cpu_pct: number | null;
          ram_used_mb: number | null;
          disk_used_gb: number | null;
          disk_total_gb: number | null;
        }[]
      ).map((r) => ({
        ts: r.ts,
        cpu: r.cpu_pct,
        ram: r.ram_used_mb,
        diskUsedGb: r.disk_used_gb,
        diskTotalGb: r.disk_total_gb,
      }));
    } else {
      const table = resolution === '1m' ? 'metrics_machine_1m' : 'metrics_machine_1h';
      points = (
        db
          .prepare(
            `SELECT ts, cpu_avg, cpu_max, ram_avg, ram_max, disk_used_gb, disk_total_gb, samples
             FROM ${table} WHERE machine_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
          )
          .all(machineId, from, to) as {
          ts: number;
          cpu_avg: number | null;
          cpu_max: number | null;
          ram_avg: number | null;
          ram_max: number | null;
          disk_used_gb: number | null;
          disk_total_gb: number | null;
          samples: number;
        }[]
      ).map((r) => ({
        ts: r.ts,
        cpu: r.cpu_avg,
        cpuMax: r.cpu_max,
        ram: r.ram_avg,
        ramMax: r.ram_max,
        diskUsedGb: r.disk_used_gb,
        diskTotalGb: r.disk_total_gb,
        samples: r.samples,
      }));
    }
    const latest = this.latestMachine.get(machineId);
    return {
      resolution,
      from,
      to,
      points,
      latest: latest?.point ?? null,
      cpuSource: latest?.cpuSource ?? null,
    };
  }

  /** Supprime toutes les métriques d'un serveur (suppression du serveur). */
  deleteServer(serverId: string): void {
    this.flush();
    const db = this.options.sqlite;
    for (const table of ['metrics_server_raw', 'metrics_server_1m', 'metrics_server_1h']) {
      db.prepare(`DELETE FROM ${table} WHERE server_id = ?`).run(serverId);
    }
    this.latestServer.delete(serverId);
  }

  close(): void {
    this.flush();
  }
}
