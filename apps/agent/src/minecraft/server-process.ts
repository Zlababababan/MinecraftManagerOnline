/**
 * Processus serveur géré (doc 06 §3–5, doc 05 §4/§10) :
 * - spawn **détaché** (survit à l'agent), stdin/stdout/stderr pipés, décodage UTF-8 tolérant,
 *   filtre ANSI, classification des lignes, ring buffer `seq`, lots console (≤ 50 lignes / 100 ms) ;
 * - readiness = `Done (x s)!` **ou** authentification RCON réussie ;
 * - arrêt : annonce → `stop` (stdin, sinon RCON) → attente → SIGTERM/30 s/SIGKILL (POSIX) ou
 *   terminaison forcée (Windows) ;
 * - crash = exit sans arrêt demandé (+ rapport `crash-reports/`), EULA refusée détectée ;
 * - ré-adoption en mode `detached` : PID + heure de démarrage + ligne de commande vérifiés,
 *   console = tail de `logs/latest.log`, pilotage RCON.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  ProtocolError,
  type AttachMode,
  type ConsoleLine,
  type ExitReason,
  type RunState,
} from '@mmo/protocol';
import {
  LogLineClassifier,
  matchServerLogEvent,
  stripAnsi,
  type ServerLogEvent,
} from '@mmo/shared';

import { errorMessage, type Logger } from '../log.js';
import { isProcessAlive, verifyProcessIdentity } from '../platform/process-info.js';
import type { ServerRuntime } from '../state/store.js';
import { ConsoleBuffer, type ConsoleBufferOptions } from './console-buffer.js';
import type { LaunchCommand } from './launch.js';
import { LogTail } from './log-tail.js';
import { RconClient, parseListResponse } from './rcon.js';

export type ServerProcessEvent =
  | {
      kind: 'state';
      state: RunState;
      previous: RunState;
      attachMode: AttachMode;
      pid: number | undefined;
      exitReason?: ExitReason;
      exitCode?: number;
      crashReportPath?: string;
    }
  | { kind: 'lines'; lines: ConsoleLine[] }
  | {
      kind: 'player';
      event: 'join' | 'leave';
      name: string;
      uuid: string | undefined;
      online: number;
    }
  | { kind: 'log-event'; event: ServerLogEvent }
  | { kind: 'eula-required' }
  | { kind: 'start-timeout' };

export interface SeqCounter {
  next(): number;
  current(): number;
}

export interface ServerProcessOptions {
  serverId: string;
  serverDir: string;
  logger: Logger;
  seq: SeqCounter;
  onEvent: (event: ServerProcessEvent) => void;
  buffer?: ConsoleBufferOptions;
  batchMaxLines?: number;
  batchMs?: number;
  startTimeoutMs?: number;
  /** Sonde RCON pendant `starting` (readiness) et après ré-adoption. */
  rconProbeIntervalMs?: number;
  exitPollMs?: number;
  now?: () => number;
}

export interface StopOptions {
  timeoutMs?: number;
  announce?: string;
  forceAfterTimeout?: boolean;
  /** Délai SIGTERM → SIGKILL (POSIX), défaut 30 s. */
  termGraceMs?: number;
}

export interface RconSettings {
  port: number;
  password: string;
}

const LINE_LEVELS = new Set(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);

export class ServerProcess {
  readonly serverId: string;
  readonly serverDir: string;
  readonly buffer: ConsoleBuffer;
  private readonly logger: Logger;
  private readonly opts: ServerProcessOptions;
  private child: ChildProcess | undefined;
  private _state: RunState = 'stopped';
  private _attachMode: AttachMode = 'attached';
  private _pid: number | undefined;
  private _startedAt: number | undefined;
  private _cmdlineKey = '';
  private rconSettings: RconSettings | undefined;
  private rconClient: RconClient | undefined;
  private readonly classifier = new LogLineClassifier();
  private pendingLines: ConsoleLine[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private stopRequested: 'stop' | 'kill' | undefined;
  private eulaRequired = false;
  /** Le serveur a annoncé son arrêt (`Stopping the server`) : arrêt intentionnel, même via une commande console. */
  private sawStopping = false;
  private exitWaiters: (() => void)[] = [];
  private tail: LogTail | undefined;
  private exitPoll: ReturnType<typeof setInterval> | undefined;
  private rconProbe: ReturnType<typeof setInterval> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly players = new Map<string, string | undefined>();
  private readonly uuids = new Map<string, string>();
  private disposed = false;

  constructor(options: ServerProcessOptions) {
    this.opts = options;
    this.serverId = options.serverId;
    this.serverDir = options.serverDir;
    this.logger = options.logger;
    this.buffer = new ConsoleBuffer(options.buffer);
  }

  get state(): RunState {
    return this._state;
  }
  get attachMode(): AttachMode {
    return this._attachMode;
  }
  get pid(): number | undefined {
    return this._pid;
  }
  get startedAt(): number | undefined {
    return this._startedAt;
  }
  get cmdlineKey(): string {
    return this._cmdlineKey;
  }
  get isRunning(): boolean {
    return this._state === 'starting' || this._state === 'running' || this._state === 'stopping';
  }
  get rcon(): RconSettings | undefined {
    return this.rconSettings;
  }
  get onlinePlayers(): { name: string; uuid: string | undefined }[] {
    return [...this.players].map(([name, uuid]) => ({ name, uuid }));
  }

  setRcon(settings: RconSettings | undefined): void {
    if (
      this.rconSettings?.port !== settings?.port ||
      this.rconSettings?.password !== settings?.password
    ) {
      this.rconClient?.close();
      this.rconClient = undefined;
    }
    this.rconSettings = settings;
  }

  // --- Démarrage ------------------------------------------------------------------------------

  async start(command: LaunchCommand): Promise<{ pid: number }> {
    if (this.isRunning) {
      throw new ProtocolError('E_CONFLICT', 'server already running', {
        details: { state: this._state },
      });
    }
    await mkdir(command.cwd, { recursive: true });
    for (const f of command.files) await writeFile(path.join(command.cwd, f.name), f.content);

    this.resetSession();
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, LANG: process.env.LANG ?? 'C.UTF-8' },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        resolve();
      });
      child.once('error', (error: Error) => {
        reject(new ProtocolError('E_IO', `spawn failed: ${error.message}`, { cause: error }));
      });
    });
    const pid = child.pid;
    if (pid === undefined) throw new ProtocolError('E_IO', 'spawn returned no pid');

    this.child = child;
    this._pid = pid;
    this._startedAt = this.now();
    this._cmdlineKey = command.cmdlineKey;
    this._attachMode = 'attached';
    child.stdin.on('error', (error: Error) => {
      this.logger.warn('stdin error', { error: error.message });
    });
    this.pipe(child.stdout, 'stdout');
    this.pipe(child.stderr, 'stderr');
    child.on('error', (error: Error) => {
      this.logger.warn('child error', { error: error.message });
    });
    child.on('exit', (code, signal) => {
      this.onExit(code, signal);
    });
    this.setState('starting');
    this.armStartTimeout();
    this.startRconProbe();
    this.logger.info('started', { pid, file: command.file });
    return { pid };
  }

  /** Heure de démarrage précise (observée par l'OS) une fois connue : remplace l'heure du spawn. */
  setObservedStart(startedAt: number): void {
    this._startedAt = startedAt;
  }

  /**
   * Ré-adoption d'un processus lancé par une instance précédente de l'agent. `false` si le PID ne
   * désigne plus notre serveur (mort, ou réutilisé par un autre processus).
   */
  async adopt(runtime: ServerRuntime): Promise<boolean> {
    if (this.isRunning) return true;
    const verdict = await verifyProcessIdentity(runtime.pid, {
      startedAt: runtime.startedAt,
      cmdlineKey: runtime.cmdlineKey,
    });
    if (!verdict.alive) {
      this.logger.info('adoption: process gone', { pid: runtime.pid });
      return false;
    }
    if (!verdict.matches) {
      this.logger.warn('adoption: pid reused by another process', {
        pid: runtime.pid,
        reason: verdict.reason,
      });
      return false;
    }
    if (!verdict.verified) {
      this.logger.warn('adoption: identity not verifiable on this OS, trusting pid', {
        pid: runtime.pid,
      });
    }
    this.resetSession();
    this._pid = runtime.pid;
    this._startedAt = runtime.startedAt;
    this._cmdlineKey = runtime.cmdlineKey;
    this._attachMode = 'detached';
    if (runtime.rconPort !== undefined && runtime.rconPassword !== undefined) {
      this.setRcon({ port: runtime.rconPort, password: runtime.rconPassword });
    }
    this.tail = new LogTail(
      path.join(this.serverDir, 'logs', 'latest.log'),
      (line) => {
        this.onLine(line);
      },
      { fromEnd: true },
    );
    await this.tail.start();
    this.exitPoll = setInterval(() => {
      if (this._pid !== undefined && !isProcessAlive(this._pid)) this.onExit(null, null);
    }, this.opts.exitPollMs ?? 1000);
    this.exitPoll.unref();
    // État inconnu tant que RCON n'a pas répondu : `starting` (le panel affiche « vérification »).
    this.setState('starting');
    this.startRconProbe();
    this.logger.info('adopted (detached)', { pid: runtime.pid });
    return true;
  }

  // --- Console --------------------------------------------------------------------------------

  async sendCommand(command: string): Promise<'stdin' | 'rcon'> {
    const cmd = command.replace(/^\//, '').replace(/\r?\n$/, '');
    if (!this.isRunning) {
      throw new ProtocolError('E_CONFLICT', 'server not running', {
        details: { state: this._state },
      });
    }
    const stdin = this.child?.stdin;
    if (this._attachMode === 'attached' && stdin && stdin.writable && !stdin.destroyed) {
      await new Promise<void>((resolve, reject) => {
        stdin.write(`${cmd}\n`, (error) => {
          if (error) reject(new ProtocolError('E_IO', `stdin write failed: ${error.message}`));
          else resolve();
        });
      });
      return 'stdin';
    }
    if (!this.rconSettings) {
      throw new ProtocolError('E_CONFLICT', 'console unavailable: detached server without RCON', {
        details: { reason: 'detached_no_rcon' },
      });
    }
    await this.rconExec(cmd);
    return 'rcon';
  }

  async rconExec(command: string, timeoutMs?: number): Promise<string> {
    const settings = this.rconSettings;
    if (!settings) {
      throw new ProtocolError('E_CONFLICT', 'RCON not provisioned for this server', {
        details: { reason: 'rcon_unavailable' },
      });
    }
    this.rconClient ??= new RconClient({ port: settings.port, password: settings.password });
    return this.rconClient.exec(command.replace(/^\//, ''), timeoutMs);
  }

  async listPlayers(): Promise<{
    online: number;
    max?: number;
    players: { name: string; uuid?: string }[];
  }> {
    if (this._attachMode === 'detached' && this.rconSettings && this._state === 'running') {
      try {
        const parsed = parseListResponse(await this.rconExec('list'));
        if (parsed) {
          this.players.clear();
          for (const name of parsed.players) this.players.set(name, this.uuids.get(name));
          return {
            online: parsed.online,
            ...(parsed.max === undefined ? {} : { max: parsed.max }),
            players: parsed.players.map((name) => {
              const uuid = this.uuids.get(name);
              return uuid === undefined ? { name } : { name, uuid };
            }),
          };
        }
      } catch (error) {
        this.logger.warn('list via rcon failed', { error: errorMessage(error) });
      }
    }
    return {
      online: this.players.size,
      players: this.onlinePlayers.map((p) =>
        p.uuid === undefined ? { name: p.name } : { name: p.name, uuid: p.uuid },
      ),
    };
  }

  // --- Arrêt ----------------------------------------------------------------------------------

  async stop(options: StopOptions = {}): Promise<{ alreadyStopped: boolean; forced: boolean }> {
    if (!this.isRunning) return { alreadyStopped: true, forced: false };
    if (this._state === 'stopping' && this.stopRequested) {
      await this.waitExit(options.timeoutMs ?? 120_000);
      return { alreadyStopped: false, forced: false };
    }
    const timeoutMs = options.timeoutMs ?? 120_000;
    this.stopRequested = 'stop';
    this.setState('stopping');
    let sent = false;
    try {
      if (options.announce !== undefined && options.announce !== '') {
        await this.sendCommand(`say ${options.announce}`).catch(() => undefined);
      }
      await this.sendCommand('stop');
      sent = true;
    } catch (error) {
      this.logger.warn('graceful stop unavailable', { error: errorMessage(error) });
    }
    if (sent && (await this.waitExit(timeoutMs))) return { alreadyStopped: false, forced: false };
    if (!(options.forceAfterTimeout ?? true)) {
      throw new ProtocolError('E_TIMEOUT', 'server did not stop in time', {
        details: { timeoutMs },
      });
    }
    this.logger.warn('forcing termination', { pid: this._pid });
    await this.terminate(options.termGraceMs ?? 30_000);
    return { alreadyStopped: false, forced: true };
  }

  async kill(): Promise<{ wasRunning: boolean }> {
    if (!this.isRunning || this._pid === undefined) return { wasRunning: false };
    this.stopRequested ??= 'kill';
    this.setState('stopping');
    this.signal('SIGKILL');
    await this.waitExit(15_000);
    return { wasRunning: true };
  }

  /** Détache l'agent du processus sans l'arrêter (arrêt de l'agent, tests de ré-adoption). */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.flushLines();
    this.rconClient?.close();
    this.rconClient = undefined;
    const child = this.child;
    if (child) {
      child.removeAllListeners('exit');
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdin?.end();
      child.unref();
    }
    this.child = undefined;
    this.tail?.stop();
    this.tail = undefined;
  }

  // --- Internes -------------------------------------------------------------------------------

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Lecture non rétrécie par le contrôle de flux (après un `await`). */
  private inState(state: RunState): boolean {
    return this._state === state;
  }

  private resetSession(): void {
    this.clearTimers();
    this.stopRequested = undefined;
    this.eulaRequired = false;
    this.sawStopping = false;
    this.players.clear();
    this.classifier.reset();
    this.child = undefined;
    this.tail = undefined;
  }

  private clearTimers(): void {
    if (this.batchTimer !== undefined) clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    if (this.exitPoll !== undefined) clearInterval(this.exitPoll);
    this.exitPoll = undefined;
    if (this.rconProbe !== undefined) clearInterval(this.rconProbe);
    this.rconProbe = undefined;
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    this.startTimer = undefined;
  }

  private setState(
    state: RunState,
    extra: { exitReason?: ExitReason; exitCode?: number; crashReportPath?: string } = {},
  ): void {
    const previous = this._state;
    if (previous === state && state !== 'stopped') return;
    this._state = state;
    this.opts.onEvent({
      kind: 'state',
      state,
      previous,
      attachMode: this._attachMode,
      pid: this._pid,
      ...extra,
    });
  }

  private armStartTimeout(): void {
    const ms = this.opts.startTimeoutMs ?? 600_000;
    this.startTimer = setTimeout(() => {
      if (this._state === 'starting') {
        this.logger.warn('start timeout: still not ready', { pid: this._pid, ms });
        this.opts.onEvent({ kind: 'start-timeout' });
      }
    }, ms);
    this.startTimer.unref();
  }

  private startRconProbe(): void {
    if (this.rconProbe !== undefined) clearInterval(this.rconProbe);
    const interval = this.opts.rconProbeIntervalMs ?? 5000;
    let probing = false;
    const probe = async (): Promise<void> => {
      if (probing || this._state !== 'starting' || !this.rconSettings) return;
      probing = true;
      try {
        this.rconClient ??= new RconClient({
          port: this.rconSettings.port,
          password: this.rconSettings.password,
          timeoutMs: 3000,
        });
        await this.rconClient.connect();
        if (this.inState('starting')) {
          this.logger.info('ready (rcon responded)', { pid: this._pid });
          this.markRunning();
        }
      } catch {
        // pas encore prêt
      } finally {
        probing = false;
      }
    };
    this.rconProbe = setInterval(() => {
      void probe();
    }, interval);
    this.rconProbe.unref();
    setTimeout(
      () => {
        void probe();
      },
      Math.min(interval, 1000),
    ).unref();
  }

  private markRunning(): void {
    if (this._state !== 'starting') return;
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    this.startTimer = undefined;
    this.setState('running');
    if (this._attachMode === 'detached') {
      void this.listPlayers();
    }
  }

  private pipe(stream: NodeJS.ReadableStream | null | undefined, name: string): void {
    if (!stream) return;
    const decoder = new StringDecoder('utf8');
    let partial = '';
    stream.on('data', (chunk: Buffer | string) => {
      const text = partial + (typeof chunk === 'string' ? chunk : decoder.write(chunk));
      const parts = text.split(/\r?\n/);
      partial = parts.pop() ?? '';
      for (const line of parts) this.onLine(line);
    });
    stream.on('end', () => {
      const rest = partial + decoder.end();
      if (rest !== '') this.onLine(rest);
      partial = '';
    });
    stream.on('error', (error: Error) => {
      this.logger.debug(`${name} error`, { error: error.message });
    });
  }

  private onLine(raw: string): void {
    if (this.disposed) return;
    const text = stripAnsi(raw);
    const classified = this.classifier.classify(text);
    const level = LINE_LEVELS.has(classified.level) ? classified.level : 'INFO';
    const line: ConsoleLine = { seq: this.opts.seq.next(), ts: this.now(), level, text };
    this.buffer.push(line);
    this.pendingLines.push(line);
    if (this.pendingLines.length >= (this.opts.batchMaxLines ?? 50)) this.flushLines();
    else
      this.batchTimer ??= setTimeout(() => {
        this.flushLines();
      }, this.opts.batchMs ?? 100);

    const message = classified.kind === 'entry' ? classified.parsed.message : text;
    const event = matchServerLogEvent(message);
    if (event) this.onLogEvent(event);
  }

  private flushLines(): void {
    if (this.batchTimer !== undefined) clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    if (this.pendingLines.length === 0) return;
    const lines = this.pendingLines;
    this.pendingLines = [];
    this.opts.onEvent({ kind: 'lines', lines });
  }

  private onLogEvent(event: ServerLogEvent): void {
    this.opts.onEvent({ kind: 'log-event', event });
    switch (event.kind) {
      case 'done':
        if (this._state === 'starting') {
          this.logger.info('ready (Done)', { seconds: event.seconds });
          this.markRunning();
        }
        break;
      case 'eula_required':
        this.eulaRequired = true;
        this.opts.onEvent({ kind: 'eula-required' });
        break;
      case 'player_uuid':
        this.uuids.set(event.name, event.uuid);
        break;
      case 'player_join':
        if (!this.players.has(event.name)) {
          this.players.set(event.name, this.uuids.get(event.name));
          this.opts.onEvent({
            kind: 'player',
            event: 'join',
            name: event.name,
            uuid: this.uuids.get(event.name),
            online: this.players.size,
          });
        }
        break;
      case 'player_leave':
        if (this.players.delete(event.name)) {
          this.opts.onEvent({
            kind: 'player',
            event: 'leave',
            name: event.name,
            uuid: this.uuids.get(event.name),
            online: this.players.size,
          });
        }
        break;
      case 'starting':
      case 'fabric_loading':
      case 'forge_legacy_loading':
      case 'modlauncher':
      case 'preparing_spawn':
      case 'listening':
      case 'rcon_running':
        break;
      case 'stopping':
        // Arrêt volontaire signalé par le serveur (`stop` console, RCON, ou notre séquence d'arrêt).
        this.sawStopping = true;
        break;
      case 'player_login':
      case 'player_disconnect':
      case 'cant_keep_up':
      case 'crash_signal':
        break;
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed || !this.isRunning) return;
    this.clearTimers();
    this.tail?.stop();
    this.tail = undefined;
    this.rconClient?.close();
    this.rconClient = undefined;
    this.flushLines();
    const pid = this._pid;
    const requested = this.stopRequested;
    const startedAt = this._startedAt ?? 0;
    this.players.clear();
    const finish = (state: RunState, exitReason: ExitReason, crashReportPath?: string): void => {
      this.child = undefined;
      this.logger.info('exited', { pid, code, signal, exitReason, state });
      this.setState(state, {
        exitReason,
        ...(code === null ? {} : { exitCode: code }),
        ...(crashReportPath === undefined ? {} : { crashReportPath }),
      });
      this._pid = undefined;
      for (const w of this.exitWaiters) w();
      this.exitWaiters = [];
    };
    if (requested === 'stop') {
      finish('stopped', 'stop');
      return;
    }
    if (requested === 'kill') {
      finish('stopped', 'kill');
      return;
    }
    if (this.eulaRequired) {
      finish('stopped', 'crash');
      return;
    }
    if (this.sawStopping) {
      // Arrêt initié par une commande console/RCON (`stop`) hors de notre séquence : pas un crash.
      finish('stopped', 'stop');
      return;
    }
    void findCrashReport(this.serverDir, startedAt).then((report) => {
      finish('crashed', 'crash', report);
    });
  }

  private waitExit(timeoutMs: number): Promise<boolean> {
    if (!this.isRunning) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.exitWaiters = this.exitWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.exitWaiters.push(waiter);
    });
  }

  private signal(sig: NodeJS.Signals): void {
    const pid = this._pid;
    if (pid === undefined) return;
    try {
      if (this.child && this._attachMode === 'attached') this.child.kill(sig);
      else process.kill(pid, sig);
    } catch (error) {
      this.logger.debug('signal failed', { sig, error: errorMessage(error) });
    }
  }

  private async terminate(termGraceMs: number): Promise<void> {
    this.stopRequested = 'kill';
    if (process.platform !== 'win32') {
      this.signal('SIGTERM');
      if (await this.waitExit(termGraceMs)) return;
    }
    this.signal('SIGKILL');
    if (!(await this.waitExit(15_000))) {
      throw new ProtocolError('E_IO', 'process survived SIGKILL', { details: { pid: this._pid } });
    }
  }
}

/** Rapport de crash créé depuis `since` (le plus récent), ou `undefined`. */
export async function findCrashReport(
  serverDir: string,
  since: number,
): Promise<string | undefined> {
  const dir = path.join(serverDir, 'crash-reports');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  let best: { file: string; mtime: number } | undefined;
  for (const name of names) {
    if (!/^crash-.*\.txt$/i.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const s = await stat(file);
      if (s.mtimeMs >= since - 2000 && (best === undefined || s.mtimeMs > best.mtime)) {
        best = { file, mtime: s.mtimeMs };
      }
    } catch {
      // fichier disparu entre-temps
    }
  }
  return best?.file;
}
