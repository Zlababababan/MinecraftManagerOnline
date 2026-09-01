/**
 * Échantillonnage CPU / RSS par processus et charge machine, **sans module natif** (doc 03 §1,
 * spike n°2) :
 *  - Windows : sidecar PowerShell persistant (script embarqué) — cycles CPU (`QueryProcessCycleTime`,
 *    exacts même sous Hyper-V) + compteur `% Processor Utility` ; si `Add-Type` échoue, le script
 *    bascule sur `TotalProcessorTime` (ticks) et le signale ; si PowerShell est indisponible, repli
 *    `os.cpus()` machine seule (`cpuSource: 'ticks'`).
 *  - Linux : `/proc/<pid>/stat` (utime+stime) + `/proc/<pid>/status` (VmRSS) + `/proc/stat`.
 *  - macOS : `ps -o pid=,rss=,time=` (temps CPU cumulé) + `os.cpus()`.
 * CPU % « en cœurs » : 100 = un cœur saturé (borné à `cores × 100`), comme le Gestionnaire des tâches.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import readline from 'node:readline';

import type { CpuSource } from '@mmo/protocol';

import { errorMessage, type Logger } from '../log.js';

export interface ProcessSample {
  /** % d'un cœur ; `undefined` au premier échantillon ou si non mesurable. */
  cpuPct: number | undefined;
  rssMb: number | undefined;
}

export interface Sample {
  ts: number;
  cpuSource: CpuSource;
  /** Charge machine en % (0–100 de toute la machine). */
  machineCpuPct: number | undefined;
  processes: Map<number, ProcessSample>;
}

export interface ProcessSampler {
  sample(pids: number[]): Promise<Sample>;
  close(): void;
}

const MB = 1048576;

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

// --- Mesure machine par `os.cpus()` (ticks : juste sur Linux/macOS, sous-évaluée sous Hyper-V) --------

export class OsCpuMeter {
  private previous: { idle: number; total: number } | undefined;

  /** % machine depuis le dernier appel ; `undefined` au premier. */
  read(): number | undefined {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    }
    const prev = this.previous;
    this.previous = { idle, total };
    if (!prev) return undefined;
    const dt = total - prev.total;
    if (dt <= 0) return undefined;
    return clamp(Math.round((1 - (idle - prev.idle) / dt) * 1000) / 10, 100);
  }
}

/** Repli universel : charge machine par ticks, aucune mesure par processus. */
export class TicksSampler implements ProcessSampler {
  private readonly meter = new OsCpuMeter();

  sample(pids: number[]): Promise<Sample> {
    const processes = new Map<number, ProcessSample>();
    for (const pid of pids) processes.set(pid, { cpuPct: undefined, rssMb: undefined });
    return Promise.resolve({
      ts: Date.now(),
      cpuSource: 'ticks',
      machineCpuPct: this.meter.read(),
      processes,
    });
  }

  close(): void {
    // rien à libérer
  }
}

// --- Temps CPU cumulé par processus → % d'un cœur ------------------------------------------------------

/** Convertit des temps CPU cumulés (ms) en % d'un cœur entre deux relevés. */
class CpuTimeTracker {
  private readonly previous = new Map<number, { cpuMs: number; ts: number }>();

  rate(pid: number, cpuMs: number, ts: number, cores: number): number | undefined {
    const prev = this.previous.get(pid);
    this.previous.set(pid, { cpuMs, ts });
    if (!prev || ts <= prev.ts || cpuMs < prev.cpuMs) return undefined;
    return clamp(Math.round(((cpuMs - prev.cpuMs) / (ts - prev.ts)) * 1000) / 10, cores * 100);
  }

  forget(keep: Set<number>): void {
    for (const pid of this.previous.keys()) if (!keep.has(pid)) this.previous.delete(pid);
  }
}

// --- Linux : /proc ------------------------------------------------------------------------------------

export class ProcSampler implements ProcessSampler {
  private readonly tracker = new CpuTimeTracker();
  private previousStat: { idle: number; total: number } | undefined;
  private readonly cores = Math.max(1, os.cpus().length);
  /** CLK_TCK (sysconf) : 100 sur toutes les distributions courantes. */
  private readonly hz: number;

  constructor(options: { hz?: number } = {}) {
    this.hz = options.hz ?? 100;
  }

  async sample(pids: number[]): Promise<Sample> {
    const ts = Date.now();
    const processes = new Map<number, ProcessSample>();
    await Promise.all(
      pids.map(async (pid) => {
        processes.set(pid, await this.readProcess(pid, ts));
      }),
    );
    this.tracker.forget(new Set(pids));
    return { ts, cpuSource: 'proc', machineCpuPct: await this.readMachine(), processes };
  }

  private async readProcess(pid: number, ts: number): Promise<ProcessSample> {
    try {
      const [stat, status] = await Promise.all([
        readFile(`/proc/${String(pid)}/stat`, 'utf8'),
        readFile(`/proc/${String(pid)}/status`, 'utf8').catch(() => ''),
      ]);
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const utime = Number(after[11]);
      const stime = Number(after[12]);
      const cpuMs = ((utime + stime) * 1000) / this.hz;
      const rssKb = Number(/^VmRSS:\s*(\d+)/m.exec(status)?.[1]);
      return {
        cpuPct: Number.isFinite(cpuMs) ? this.tracker.rate(pid, cpuMs, ts, this.cores) : undefined,
        rssMb: Number.isFinite(rssKb) ? Math.round(rssKb / 1024) : undefined,
      };
    } catch {
      return { cpuPct: undefined, rssMb: undefined };
    }
  }

  private async readMachine(): Promise<number | undefined> {
    try {
      const text = await readFile('/proc/stat', 'utf8');
      const line = text.split('\n').find((l) => l.startsWith('cpu '));
      if (line === undefined) return undefined;
      const fields = line.trim().split(/\s+/).slice(1).map(Number);
      const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
      const total = fields.reduce((a, b) => a + b, 0);
      const prev = this.previousStat;
      this.previousStat = { idle, total };
      if (!prev || total <= prev.total) return undefined;
      return clamp(Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 1000) / 10, 100);
    } catch {
      return undefined;
    }
  }

  close(): void {
    // rien à libérer
  }
}

// --- macOS : ps ---------------------------------------------------------------------------------------

/** `[[dd-]hh:]mm:ss[.ff]` → ms. */
export function parsePsTime(text: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return undefined;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

export class PsSampler implements ProcessSampler {
  private readonly tracker = new CpuTimeTracker();
  private readonly meter = new OsCpuMeter();
  private readonly cores = Math.max(1, os.cpus().length);

  constructor(private readonly run: (args: string[]) => Promise<string> = runPs) {}

  async sample(pids: number[]): Promise<Sample> {
    const ts = Date.now();
    const processes = new Map<number, ProcessSample>();
    for (const pid of pids) processes.set(pid, { cpuPct: undefined, rssMb: undefined });
    if (pids.length > 0) {
      try {
        const out = await this.run(['-o', 'pid=,rss=,time=', '-p', pids.join(',')]);
        for (const line of out.split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
          if (!m) continue;
          const pid = Number(m[1]);
          const cpuMs = parsePsTime(m[3] ?? '');
          processes.set(pid, {
            cpuPct: cpuMs === undefined ? undefined : this.tracker.rate(pid, cpuMs, ts, this.cores),
            rssMb: Math.round(Number(m[2]) / 1024),
          });
        }
      } catch {
        // ps indisponible : aucune mesure par processus
      }
    }
    this.tracker.forget(new Set(pids));
    return { ts, cpuSource: 'proc', machineCpuPct: this.meter.read(), processes };
  }

  close(): void {
    // rien à libérer
  }
}

function runPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 20 }, (e, out) => {
      if (e) reject(e instanceof Error ? e : new Error('ps failed'));
      else resolve(out);
    });
  });
}

// --- Windows : sidecar PowerShell (cycles) ------------------------------------------------------------

/**
 * Script du sidecar (spike n°2, `docs/spikes/scripts/cpu-cycles.ps1`), embarqué dans le bundle.
 * Protocole ligne à ligne : `{"pids":[…]}` → `{"t","mhz","cores","utility","mode","procs":{pid:{cycles|cpuMs,rss}|null}}`.
 * `mode` = `cycles` (P/Invoke OK) ou `ticks` (`Add-Type` impossible : `TotalProcessorTime`).
 */
export const CYCLES_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$mode = 'cycles'
try {
  Add-Type -Namespace Mmo -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool QueryProcessCycleTime(IntPtr hProcess, out ulong cycles);' -ErrorAction Stop
} catch { $mode = 'ticks' }
# Fréquence et cœurs par le registre et l'environnement, JAMAIS par CIM/WMI : une requête CIM peut
# rester pendante plusieurs dizaines de secondes sur une machine chargée (déjà vu sur process-info,
# qui a fini par se doter d'un disjoncteur). Ici elle bloquait la poignée de main du sidecar, donc
# son démarrage, et un dépassement privait l'agent de RSS jusqu'à son redémarrage. La valeur ~MHz du
# registre est la fréquence relevée au boot là où CIM donnait la fréquence nominale : le CPU% par
# cycles reste l'estimation qu'il était. (Pas d'accent grave dans ce script : il est porté par un
# template literal.)
$mhz = 0
try {
  $mhz = [int](Get-ItemProperty -Path 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -Name '~MHz' -ErrorAction Stop).'~MHz'
} catch { $mhz = 0 }
if ($mhz -le 0) { $mhz = 1 }
$cores = [int]$env:NUMBER_OF_PROCESSORS
if ($cores -le 0) { $cores = 1 }
$utilityCounter = $null
try {
  $utilityCounter = New-Object System.Diagnostics.PerformanceCounter('Processor Information', '% Processor Utility', '_Total')
  $null = $utilityCounter.NextValue()
} catch { $utilityCounter = $null }
[Console]::Out.WriteLine('{"ready":true,"mode":"' + $mode + '","mhz":' + $mhz + ',"cores":' + $cores + '}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $procs = @{}
  foreach ($pid0 in $req.pids) {
    $p = Get-Process -Id $pid0 -ErrorAction SilentlyContinue
    if ($p) {
      if ($mode -eq 'cycles') {
        $c = [uint64]0
        [void][Mmo.Native]::QueryProcessCycleTime($p.Handle, [ref]$c)
        $procs["$pid0"] = @{ cycles = $c; rss = $p.WorkingSet64 }
      } else {
        $procs["$pid0"] = @{ cpuMs = [int64]$p.TotalProcessorTime.TotalMilliseconds; rss = $p.WorkingSet64 }
      }
    } else { $procs["$pid0"] = $null }
  }
  $utility = $null
  if ($null -ne $utilityCounter) { try { $utility = [math]::Round($utilityCounter.NextValue(), 1) } catch { $utility = $null } }
  $out = @{ t = [int64](([datetime]::UtcNow - [datetime]'1970-01-01').TotalMilliseconds); mhz = $mhz; cores = $cores; mode = $mode; utility = $utility; procs = $procs }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 3))
}
`.trim();

interface SidecarReady {
  ready: true;
  mode: 'cycles' | 'ticks';
  mhz: number;
  cores: number;
}

interface SidecarReply {
  t: number;
  mhz: number;
  cores: number;
  mode: 'cycles' | 'ticks';
  utility: number | null;
  procs: Record<string, { cycles?: number; cpuMs?: number; rss: number } | null>;
}

export interface WindowsSamplerOptions {
  logger: Logger;
  /** Exécutable PowerShell (défaut `powershell.exe`, toujours présent ; `pwsh` accepté). */
  shell?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** Sidecar PowerShell persistant, relancé s'il meurt ; `E_UNAVAILABLE` si PowerShell ne démarre pas. */
export class WindowsCyclesSampler implements ProcessSampler {
  private child: ChildProcess | undefined;
  private ready: Promise<SidecarReady> | undefined;
  private readonly waiters: ((line: string) => void)[] = [];
  private readonly previous = new Map<number, { cycles: number; ts: number }>();
  private readonly ticks = new CpuTimeTracker();
  private readonly fallbackMeter = new OsCpuMeter();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: WindowsSamplerOptions) {}

  async sample(pids: number[]): Promise<Sample> {
    const result = this.chain.then(() => this.doSample(pids));
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async doSample(pids: number[]): Promise<Sample> {
    const info = await this.ensureStarted();
    const reply = await this.request({ pids });
    const ts = reply.t > 0 ? reply.t : Date.now();
    const cores = reply.cores > 0 ? reply.cores : info.cores;
    const mhz = reply.mhz > 0 ? reply.mhz : info.mhz;
    const processes = new Map<number, ProcessSample>();
    for (const pid of pids) {
      const p = reply.procs[String(pid)];
      if (!p) {
        processes.set(pid, { cpuPct: undefined, rssMb: undefined });
        this.previous.delete(pid);
        continue;
      }
      let cpuPct: number | undefined;
      if (reply.mode === 'cycles' && typeof p.cycles === 'number') {
        const prev = this.previous.get(pid);
        this.previous.set(pid, { cycles: p.cycles, ts });
        if (prev && ts > prev.ts && p.cycles >= prev.cycles) {
          const seconds = (p.cycles - prev.cycles) / (mhz * 1e6);
          cpuPct = clamp(Math.round((seconds / ((ts - prev.ts) / 1000)) * 1000) / 10, cores * 100);
        }
      } else if (typeof p.cpuMs === 'number') {
        cpuPct = this.ticks.rate(pid, p.cpuMs, ts, cores);
      }
      processes.set(pid, { cpuPct, rssMb: Math.round(p.rss / MB) });
    }
    for (const pid of this.previous.keys()) if (!pids.includes(pid)) this.previous.delete(pid);
    const utility =
      typeof reply.utility === 'number' && Number.isFinite(reply.utility)
        ? clamp(reply.utility, 100)
        : this.fallbackMeter.read();
    return {
      ts,
      cpuSource: reply.mode === 'cycles' ? 'cycles' : 'ticks',
      machineCpuPct: utility,
      processes,
    };
  }

  private ensureStarted(): Promise<SidecarReady> {
    if (this.ready !== undefined && this.child?.exitCode === null) {
      return this.ready;
    }
    const started = this.start();
    this.ready = started;
    // Un démarrage raté ne doit pas être mémorisé : `child.kill()` est asynchrone, le processus a
    // encore `exitCode === null` pendant quelques millisecondes et l'essai suivant se verrait
    // resservir cette promesse rejetée — le sidecar ne redémarrerait jamais.
    started.catch(() => {
      if (this.ready === started) this.ready = undefined;
    });
    return started;
  }

  private start(): Promise<SidecarReady> {
    if (this.closed) return Promise.reject(new Error('sampler closed'));
    const shell = this.options.shell ?? 'powershell.exe';
    // `-EncodedCommand` : le script voyage en base64 UTF-16LE, stdin reste libre pour les requêtes.
    const encoded = Buffer.from(CYCLES_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    this.child = child;
    this.previous.clear();
    const rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
    rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
    });
    child.on('exit', (code) => {
      this.options.logger.warn('metrics sidecar exited', { code });
      if (this.child === child) this.child = undefined;
      for (const w of this.waiters.splice(0)) w('');
    });
    child.stdin.on('error', () => undefined);
    return new Promise<SidecarReady>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('metrics sidecar start timeout'));
        child.kill();
      }, this.options.startTimeoutMs ?? 30_000);
      child.once('error', (error: Error) => {
        clearTimeout(timeout);
        this.child = undefined;
        reject(new Error(`powershell unavailable: ${error.message}`));
      });
      this.waiters.push((line) => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(line) as Partial<SidecarReady>;
          if (parsed.ready === true && parsed.mode !== undefined) {
            this.options.logger.info('metrics sidecar ready', {
              mode: parsed.mode,
              mhz: parsed.mhz,
              cores: parsed.cores,
            });
            resolve({
              ready: true,
              mode: parsed.mode,
              mhz: parsed.mhz ?? 1,
              cores: parsed.cores ?? 1,
            });
            return;
          }
        } catch {
          // réponse illisible
        }
        reject(new Error('metrics sidecar: unexpected handshake'));
      });
    });
  }

  private request(req: { pids: number[] }): Promise<SidecarReply> {
    const child = this.child;
    if (!child?.stdin) return Promise.reject(new Error('metrics sidecar not running'));
    return new Promise<SidecarReply>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('metrics sidecar timeout'));
        child.kill();
      }, this.options.requestTimeoutMs ?? 10_000);
      this.waiters.push((line) => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(line) as SidecarReply);
        } catch (error) {
          reject(new Error(`metrics sidecar: bad reply (${errorMessage(error)})`));
        }
      });
      child.stdin?.write(`${JSON.stringify(req)}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = undefined;
  }
}

// --- Sélection ----------------------------------------------------------------------------------------

/** Repli ticks après un échec : 5 s, puis 15 s, 30 s, 60 s tant que le primaire retombe. */
const SAMPLER_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

/**
 * Échantillonneur adapté à l'OS, avec repli vers `TicksSampler` quand la méthode principale échoue.
 *
 * Le repli est **temporaire** (backoff borné, puis nouvel essai du primaire). Un seul coup de mou —
 * sidecar PowerShell lent à démarrer sur un runner chargé, `Add-Type` à froid, requête au-delà de
 * 10 s — privait sinon l'agent du RSS et du CPU par processus jusqu'à son redémarrage, alors que
 * `TicksSampler` ne mesure AUCUN processus. Même famille de panne que le verrou de 10 min de la
 * sonde TPS (doc 06 §1) : un échec de transport n'est pas une incapacité durable.
 *
 * Seule une erreur définitive coupe le primaire pour de bon : PowerShell (ou `ps`) introuvable.
 */
export class PlatformSampler implements ProcessSampler {
  private primary: ProcessSampler | undefined;
  private readonly fallback = new TicksSampler();
  private readonly retryDelaysMs: readonly number[];
  /** Échecs consécutifs du primaire ; remis à zéro dès qu'il refonctionne. */
  private failures = 0;
  /** Date (ms) avant laquelle on ne retente pas le primaire. */
  private retryAt = 0;

  constructor(
    private readonly logger: Logger,
    private readonly platform: NodeJS.Platform = process.platform,
    options: { primary?: ProcessSampler; retryDelaysMs?: readonly number[] } = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? SAMPLER_RETRY_DELAYS_MS;
    if (options.primary) this.primary = options.primary;
    else if (platform === 'win32') this.primary = new WindowsCyclesSampler({ logger });
    else if (platform === 'linux') this.primary = new ProcSampler();
    else if (platform === 'darwin') this.primary = new PsSampler();
  }

  async sample(pids: number[]): Promise<Sample> {
    if (this.primary && Date.now() >= this.retryAt) {
      try {
        const sample = await this.primary.sample(pids);
        if (this.failures > 0) {
          this.logger.info('process sampler recovered', {
            platform: this.platform,
            failures: this.failures,
          });
          this.failures = 0;
        }
        return sample;
      } catch (error) {
        this.onFailure(error);
      }
    }
    return this.fallback.sample(pids);
  }

  /** Repli ticks pour ce relevé ; le primaire sera retenté après le backoff, sauf panne définitive. */
  private onFailure(error: unknown): void {
    const message = errorMessage(error);
    this.failures += 1;
    // `powershell unavailable: …` = l'exécutable n'existe pas (ENOENT au spawn) : inutile d'insister.
    if (message.startsWith('powershell unavailable')) {
      this.logger.warn('process sampler unavailable for good, ticks only', {
        platform: this.platform,
        error: message,
      });
      this.primary?.close();
      this.primary = undefined;
      return;
    }
    const index = Math.min(this.failures - 1, this.retryDelaysMs.length - 1);
    const retryInMs = this.retryDelaysMs[index] ?? 0;
    this.retryAt = Date.now() + retryInMs;
    this.logger.warn('process sampler failed, ticks fallback until retry', {
      platform: this.platform,
      failures: this.failures,
      retryInMs,
      error: message,
    });
  }

  close(): void {
    this.primary?.close();
    this.fallback.close();
  }
}
