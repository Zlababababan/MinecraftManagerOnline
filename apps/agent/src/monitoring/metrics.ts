/**
 * Collecteur `metrics.sample` (doc 05 §6 Monitoring, doc 04 §7) : toutes les `intervalMs` (15 s),
 * CPU/RSS par serveur en marche (échantillonneur par OS), joueurs, TPS/MSPT si disponibles,
 * machine (CPU, RAM, disque du volume de l'état), `cpuSource`. Hors ligne, les échantillons sont
 * gardés en mémoire (1 h glissante) et rejoués avec leurs timestamps à la session suivante.
 */
import { statfs } from 'node:fs/promises';
import os from 'node:os';

import type { CpuSource, EventPayload, RunState } from '@mmo/protocol';

import { errorMessage, type Logger } from '../log.js';
import type { ProcessSampler } from './sampler.js';
import type { TpsResult } from './tps.js';

export type MetricsSample = EventPayload<'metrics.sample'>;

export interface MetricsTarget {
  serverId: string;
  pid: number | undefined;
  state: RunState;
  players: number;
  maxRamMb: number;
  /** Lecture TPS (RCON) — uniquement quand `running`. */
  readTps?: () => Promise<TpsResult | undefined>;
}

export interface MetricsCollectorOptions {
  logger: Logger;
  sampler: ProcessSampler;
  targets: () => MetricsTarget[];
  emit: (sample: MetricsSample) => void;
  isConnected: () => boolean;
  intervalMs?: number;
  /** Profondeur du tampon hors ligne (défaut 1 h). */
  bufferMs?: number;
  /** Volume dont l'occupation est remontée (défaut : dossier d'état de l'agent). */
  diskPath?: string;
  /** Garde-fou RAM (doc 02) : RSS > `ramGuardFactor × maxRamMb + ramGuardSlackMb` ⇒ callback. */
  onRamExceeded?: (serverId: string, rssMb: number, maxRamMb: number) => void;
  ramGuardFactor?: number;
  ramGuardSlackMb?: number;
  now?: () => number;
}

export interface MetricsSummary {
  ts: number;
  cpuPct: number | undefined;
  cpuSource: CpuSource;
  diskUsedGb: number | undefined;
  diskTotalGb: number | undefined;
}

export class MetricsCollector {
  private timer: ReturnType<typeof setInterval> | undefined;
  private intervalMs: number;
  private readonly buffer: MetricsSample[] = [];
  private latest: MetricsSummary | undefined;
  private collecting = false;
  private readonly ramAlerted = new Set<string>();

  constructor(private readonly options: MetricsCollectorOptions) {
    this.intervalMs = options.intervalMs ?? 15_000;
  }

  get interval(): number {
    return this.intervalMs;
  }

  /** Dernier relevé machine (pour le heartbeat). */
  get summary(): MetricsSummary | undefined {
    return this.latest;
  }

  /** Échantillons en attente de rejeu (hors ligne). */
  get buffered(): number {
    return this.buffer.length;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.collect();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  setInterval(ms: number): void {
    const next = Math.max(1000, ms);
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (this.timer !== undefined) {
      this.stop();
      this.start();
    }
  }

  /** Nouvelle session panel : rejeu du tampon hors ligne (timestamps d'origine), puis vidage. */
  replay(): number {
    const pending = this.buffer.splice(0);
    for (const sample of pending) this.options.emit(sample);
    return pending.length;
  }

  /** Un serveur (re)démarre : le garde-fou RAM peut alerter à nouveau. */
  resetServer(serverId: string): void {
    this.ramAlerted.delete(serverId);
  }

  /** Un cycle de collecte (public pour les tests). */
  async collect(): Promise<MetricsSample | undefined> {
    if (this.collecting) return undefined;
    this.collecting = true;
    try {
      const sample = await this.build();
      this.deliver(sample);
      return sample;
    } catch (error) {
      this.options.logger.warn('metrics collection failed', { error: errorMessage(error) });
      return undefined;
    } finally {
      this.collecting = false;
    }
  }

  private deliver(sample: MetricsSample): void {
    if (this.options.isConnected()) {
      this.options.emit(sample);
      return;
    }
    this.buffer.push(sample);
    const keep = Math.max(1, Math.floor((this.options.bufferMs ?? 3_600_000) / this.intervalMs));
    if (this.buffer.length > keep) this.buffer.splice(0, this.buffer.length - keep);
  }

  private async build(): Promise<MetricsSample> {
    const targets = this.options
      .targets()
      .filter((t) => t.pid !== undefined && t.state !== 'stopped' && t.state !== 'crashed');
    const pids = targets.map((t) => t.pid).filter((p): p is number => p !== undefined);
    const sampled = await this.options.sampler.sample(pids);
    const ts = this.options.now?.() ?? sampled.ts;

    const servers: MetricsSample['servers'] = [];
    await Promise.all(
      targets.map(async (target) => {
        const proc = target.pid === undefined ? undefined : sampled.processes.get(target.pid);
        let tps: TpsResult | undefined;
        if (target.state === 'running' && target.readTps) {
          try {
            tps = await target.readTps();
          } catch (error) {
            this.options.logger.debug('tps read failed', {
              serverId: target.serverId,
              error: errorMessage(error),
            });
          }
        }
        servers.push({
          serverId: target.serverId,
          ...(proc?.cpuPct === undefined ? {} : { cpuPct: proc.cpuPct }),
          ...(proc?.rssMb === undefined ? {} : { rssMb: proc.rssMb }),
          ...(tps?.tps === undefined ? {} : { tps: round(tps.tps) }),
          ...(tps?.mspt === undefined ? {} : { mspt: round(tps.mspt) }),
          ...(tps === undefined ? {} : { tpsSource: tps.source }),
          players: target.players,
        });
        if (proc?.rssMb !== undefined) this.checkRam(target, proc.rssMb);
      }),
    );
    servers.sort((a, b) => a.serverId.localeCompare(b.serverId));

    const total = os.totalmem();
    const free = os.freemem();
    const disk = await this.readDisk();
    this.latest = {
      ts,
      cpuPct: sampled.machineCpuPct,
      cpuSource: sampled.cpuSource,
      diskUsedGb: disk?.usedGb,
      diskTotalGb: disk?.totalGb,
    };
    return {
      ts,
      machine: {
        ...(sampled.machineCpuPct === undefined ? {} : { cpuPct: sampled.machineCpuPct }),
        ramUsedMb: Math.round((total - free) / 1048576),
        ramTotalMb: Math.max(1, Math.round(total / 1048576)),
        ...(disk === undefined ? {} : { diskUsedGb: disk.usedGb, diskTotalGb: disk.totalGb }),
      },
      servers,
      cpuSource: sampled.cpuSource,
    };
  }

  private checkRam(target: MetricsTarget, rssMb: number): void {
    const limit =
      target.maxRamMb * (this.options.ramGuardFactor ?? 1.5) +
      (this.options.ramGuardSlackMb ?? 512);
    if (rssMb <= limit) {
      if (rssMb <= target.maxRamMb) this.ramAlerted.delete(target.serverId);
      return;
    }
    if (this.ramAlerted.has(target.serverId)) return;
    this.ramAlerted.add(target.serverId);
    this.options.onRamExceeded?.(target.serverId, rssMb, target.maxRamMb);
  }

  private async readDisk(): Promise<{ usedGb: number; totalGb: number } | undefined> {
    const target = this.options.diskPath;
    if (target === undefined) return undefined;
    try {
      const s = await statfs(target);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      if (!(total > 0)) return undefined;
      const gb = 1024 ** 3;
      return {
        usedGb: Math.round(((total - free) / gb) * 100) / 100,
        totalGb: Math.round((total / gb) * 100) / 100,
      };
    } catch {
      return undefined;
    }
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
