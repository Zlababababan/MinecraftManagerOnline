/**
 * Gestionnaire des serveurs de la machine : un `ServerProcess` par serveur configuré, garde-fous
 * de lancement (RAM, port, EULA, Java → erreurs typées, doc 05 §6), provisionnement RCON,
 * persistance du runtime (PID + heure + clé cmdline) et ré-adoption au démarrage de l'agent,
 * restauration selon `desired_state` (doc 05 §5).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ProtocolError,
  type AttachMode,
  type JavaRuntime,
  type LaunchPlan,
  type Os,
  type RequestPayload,
  type ServerConfig,
} from '@mmo/protocol';
import {
  VELOCITY_DEFAULT_PORT,
  detectServer,
  javaRequirementFromTable,
  parseVelocityToml,
  type DetectFs,
} from '@mmo/shared';
import { createNodeDetectFs } from '@mmo/shared/node';

import { FsService } from '../files/fs-service.js';
import { listLogFiles, searchLogs, type SearchOptions } from '../files/logs.js';
import { errorMessage, type Logger } from '../log.js';
import type { MetricsTarget } from '../monitoring/metrics.js';
import { TpsProbe } from '../monitoring/tps.js';
import type { WatchdogServerView } from '../monitoring/watchdog.js';
import { JavaRegistry, totalRamMb } from '../platform/java.js';
import { findFreePort, isPortFree } from '../platform/ports.js';
import { getProcessInfo, isProcessAlive } from '../platform/process-info.js';
import type { ServerRecord, ServerRuntime, StateStore } from '../state/store.js';
import { assertServerDirWritable, describeFsRefusal, withFsErrors } from '../util/fs-error.js';
import { ConfigService, type CommandResult } from './config-files.js';
import { buildLaunchCommand, type LaunchCommand } from './launch.js';
import { resolvePlayers, type FetchLike } from './players.js';
import { parseBooleanProperty } from './properties.js';
import {
  acceptEula,
  ensureRconProvisioned,
  gamePortFromProperties,
  generateRconPassword,
  isEulaAccepted,
  readServerProperties,
  writeMarker,
} from './provisioning.js';
import { CommandHelpProbe } from './command-help.js';
import {
  ServerProcess,
  type RconSettings,
  type ServerProcessEvent,
  type StopOptions,
} from './server-process.js';

export interface CommandContext {
  config: ServerConfig;
  launch: LaunchPlan;
  java: JavaRuntime;
  mcVersion: string | undefined;
}

export interface ServerManagerOptions {
  store: StateStore;
  logger: Logger;
  os: Os;
  java?: JavaRegistry;
  detectFs?: DetectFs;
  onEvent: (serverId: string, event: ServerProcessEvent) => void;
  /** Point d'injection des tests (fake Java server) : remplace `buildLaunchCommand`. */
  commandBuilder?: (ctx: CommandContext) => LaunchCommand;
  /** Tests : court-circuite la sélection Java. */
  javaResolver?:
    | ((ctx: { config: ServerConfig; mcVersion: string | undefined }) => Promise<JavaRuntime>)
    | undefined;
  /** RAM réservée au système (défaut 1 024 Mo). */
  ramReserveMb?: number;
  totalRamMb?: () => number;
  rconPortRange?: [number, number];
  startTimeoutMs?: number;
  rconProbeIntervalMs?: number;
  exitPollMs?: number;
  /** Résolution Mojang (tests : stub). */
  fetchImpl?: FetchLike | undefined;
  now?: () => number;
}

export class ServerManager {
  private readonly processes = new Map<string, ServerProcess>();
  private readonly tpsProbes = new Map<string, TpsProbe>();
  private readonly helpProbes = new Map<string, CommandHelpProbe>();
  private readonly java: JavaRegistry;
  private readonly detectFs: DetectFs;
  private readonly starting = new Set<string>();
  /** Phase 12 : allocation RCON sérialisée (démarrages simultanés ⇒ même port choisi sinon). */
  private rconAllocation: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ServerManagerOptions) {
    this.java = options.java ?? new JavaRegistry();
    this.detectFs = options.detectFs ?? createNodeDetectFs();
  }

  get store(): StateStore {
    return this.options.store;
  }

  get javaRegistry(): JavaRegistry {
    return this.java;
  }

  /** Ré-adopte les processus connus puis applique `desired_state` si `restoreOnBoot`. */
  async init(): Promise<void> {
    const state = this.options.store.get();
    for (const [serverId, record] of Object.entries(state.servers)) {
      if (!record.runtime) continue;
      const proc = this.getOrCreate(serverId, record);
      const adopted = await proc.adopt(record.runtime);
      if (adopted) {
        await this.options.store.update((s) => {
          const r = s.servers[serverId];
          if (r?.runtime) r.runtime.attachMode = 'detached';
        });
      } else {
        await this.options.store.update((s) => {
          const r = s.servers[serverId];
          if (r) delete r.runtime;
        });
      }
    }
    if (state.restoreOnBoot) {
      for (const [serverId, desired] of Object.entries(state.desiredStates)) {
        if (desired !== 'running' || this.processes.get(serverId)?.isRunning) continue;
        try {
          await this.start(serverId);
        } catch (error) {
          this.options.logger.warn('restore on boot failed', {
            serverId,
            error: errorMessage(error),
          });
        }
      }
    }
  }

  // --- Configuration --------------------------------------------------------------------------

  /** Remplace la liste des serveurs connus (marqueurs écrits) ; un serveur absent mais en marche est conservé. */
  async applyConfigs(configs: ServerConfig[]): Promise<void> {
    const ids = new Set(configs.map((c) => c.serverId));
    await this.options.store.update((s) => {
      for (const config of configs) {
        const existing = s.servers[config.serverId];
        s.servers[config.serverId] = existing ? { ...existing, config } : { config };
        // Loader/version ont pu changer : la chaîne TPS sera réapprise.
        this.tpsProbes.delete(config.serverId);
        this.helpProbes.delete(config.serverId);
      }
      const kept: typeof s.servers = {};
      for (const [id, record] of Object.entries(s.servers)) {
        if (ids.has(id) || this.processes.get(id)?.isRunning) {
          kept[id] = record;
          continue;
        }
        this.processes.get(id)?.dispose();
        this.processes.delete(id);
        this.tpsProbes.delete(id);
        this.helpProbes.delete(id);
      }
      s.servers = kept;
    });
    for (const config of configs) {
      await writeMarker(config.path, config.serverId).catch((error: unknown) => {
        this.options.logger.warn('marker write failed', {
          path: config.path,
          error: errorMessage(error),
        });
        // Un refus de DROITS ne se contente pas d'un warn local : c'est la seule occasion de le
        // dire à l'utilisateur avant qu'il ne tente un démarrage qui échouera forcément.
        const refusal = describeFsRefusal(error, config.path);
        if (refusal) {
          this.options.onEvent(config.serverId, {
            kind: 'folder-not-writable',
            // Le DOSSIER, pas le fichier qui a échoué : c'est lui que l'on corrige.
            path: config.path,
            user: refusal.user,
            reason: refusal.reason,
          });
        }
      });
    }
  }

  // --- Contrôle -------------------------------------------------------------------------------

  /** Ajoute ou remplace un seul serveur (phase 9 : import de migration) sans toucher aux autres. */
  async upsertConfig(config: ServerConfig): Promise<void> {
    const others = this.options.store.serverConfigs().filter((c) => c.serverId !== config.serverId);
    await this.applyConfigs([...others, config]);
  }

  get(serverId: string): ServerProcess | undefined {
    return this.processes.get(serverId);
  }

  require(serverId: string): ServerProcess {
    const record = this.options.store.getServer(serverId);
    if (!record) {
      throw new ProtocolError('E_NOT_FOUND', `unknown server ${serverId}`, {
        details: { serverId },
      });
    }
    return this.getOrCreate(serverId, record);
  }

  async start(serverId: string): Promise<{ alreadyRunning: boolean; pid: number | undefined }> {
    const record = this.options.store.getServer(serverId);
    if (!record) {
      throw new ProtocolError('E_NOT_FOUND', `unknown server ${serverId}`, {
        details: { serverId },
      });
    }
    const proc = this.getOrCreate(serverId, record);
    if (proc.isRunning) return { alreadyRunning: true, pid: proc.pid };
    if (this.starting.has(serverId)) {
      throw new ProtocolError('E_BUSY', 'start already in progress', { details: { serverId } });
    }
    this.starting.add(serverId);
    try {
      return await this.doStart(serverId, record, proc);
    } finally {
      this.starting.delete(serverId);
    }
  }

  private async doStart(
    serverId: string,
    record: ServerRecord,
    proc: ServerProcess,
  ): Promise<{ alreadyRunning: boolean; pid: number | undefined }> {
    const { config } = record;
    const dir = config.path;

    // 1. Plan de lancement (config, sinon redétection du dossier). Un proxy Velocity n'a pas de
    //    version Minecraft : ne pas redétecter le dossier à chaque démarrage pour autant.
    let launch = config.launch;
    let mcVersion = config.mcVersion;
    let loader = config.loader;
    if (!launch || (mcVersion === undefined && loader !== 'velocity')) {
      const detected = await detectServer(this.detectFs, dir, { os: this.options.os });
      launch ??= detected?.launch;
      mcVersion ??= detected?.mcVersion?.value;
      loader ??= detected?.loader.value;
    }
    if (!launch) {
      throw new ProtocolError('E_NOT_FOUND', 'no launch plan for this server', {
        details: { serverId, reason: 'launch_plan_missing' },
      });
    }

    // 2. Dossier inscriptible (RCON, logs, monde : démarrer sans droit d'écriture est perdu d'avance)
    await assertServerDirWritable(dir);

    // 3. EULA (sans objet pour un proxy Velocity : rien à accepter)
    if (loader !== 'velocity' && !(await isEulaAccepted(dir))) {
      throw new ProtocolError('E_EULA_REQUIRED', 'eula.txt not accepted', {
        details: { serverId },
      });
    }

    // 4. Java
    const java = await this.resolveJava(config, mcVersion, loader);

    // 5. RAM
    const total = this.options.totalRamMb?.() ?? totalRamMb();
    const reserve = this.options.ramReserveMb ?? 1024;
    const committed = this.committedRamMb(serverId);
    const available = total - reserve - committed;
    if (config.maxRamMb > available) {
      throw new ProtocolError('E_RAM_GUARD', 'not enough memory to start this server', {
        details: {
          requestedMb: config.maxRamMb,
          availableMb: Math.max(0, available),
          totalMb: total,
          committedMb: committed,
        },
      });
    }

    // 6. Port de jeu (Velocity : le port d'écoute vient de velocity.toml, pas de server.properties)
    let gamePort: number;
    if (loader === 'velocity') {
      const toml = await readFile(path.join(dir, 'velocity.toml'), 'utf8').catch(() => '');
      gamePort = parseVelocityToml(toml).port ?? VELOCITY_DEFAULT_PORT;
    } else {
      const { props } = await readServerProperties(dir);
      gamePort = gamePortFromProperties(props);
    }
    if (!(await isPortFree(gamePort))) {
      throw new ProtocolError('E_PORT_IN_USE', `port ${String(gamePort)} already in use`, {
        details: { port: gamePort, serverId },
      });
    }

    // 7. RCON auto-provisionné — jamais pour un proxy Velocity (pas de RCON, et le provisionner
    //    créerait un server.properties parasite dans son dossier) : console via stdin seulement.
    let rcon: RconSettings | undefined;
    if (loader !== 'velocity') {
      const settings = await this.ensureRcon(serverId, record);
      await withFsErrors(dir, () => ensureRconProvisioned(dir, settings));
      proc.setRcon(settings);
      rcon = settings;
    }

    // 8. Commande et lancement
    const ctx: CommandContext = { config, launch, java, mcVersion };
    const command = this.options.commandBuilder
      ? this.options.commandBuilder(ctx)
      : buildLaunchCommand({
          serverDir: dir,
          launch,
          os: this.options.os,
          javaPath: java.path,
          javaMajor: java.majorVersion,
          maxRamMb: config.maxRamMb,
          minRamMb: config.minRamMb,
          mcVersion,
          loader,
          jvmArgs: config.jvmArgs,
        });
    const { pid } = await proc.start(command);
    const runtime: ServerRuntime = {
      pid,
      startedAt: proc.startedAt ?? Date.now(),
      cmdlineKey: command.cmdlineKey,
      gamePort,
      ...(rcon === undefined ? {} : { rconPort: rcon.port, rconPassword: rcon.password }),
      javaPath: java.path,
      attachMode: 'attached',
    };
    await this.options.store.update((s) => {
      const r = s.servers[serverId];
      if (r) r.runtime = runtime;
    });
    // Heure de démarrage observée par l'OS (précision de la ré-adoption)
    void getProcessInfo(pid).then(async (info) => {
      if (info?.startedAt === undefined || proc.pid !== pid) return;
      proc.setObservedStart(info.startedAt);
      await this.options.store.update((s) => {
        const r = s.servers[serverId];
        if (r?.runtime?.pid === pid) r.runtime.startedAt = info.startedAt ?? r.runtime.startedAt;
      });
    });
    return { alreadyRunning: false, pid };
  }

  async stop(
    serverId: string,
    options: StopOptions = {},
  ): Promise<{ alreadyStopped: boolean; forced: boolean }> {
    const proc = this.require(serverId);
    const record = this.options.store.getServer(serverId);
    const timeoutMs = options.timeoutMs ?? (record?.config.stopTimeoutSec ?? 120) * 1000;
    // Velocity ne connaît pas `stop` : sa commande console d'arrêt propre est `shutdown`.
    return proc.stop({
      ...options,
      timeoutMs,
      ...(record?.config.loader === 'velocity' ? { stopCommand: 'shutdown' } : {}),
    });
  }

  async kill(serverId: string): Promise<{ wasRunning: boolean }> {
    return this.require(serverId).kill();
  }

  async restart(serverId: string, options: StopOptions = {}): Promise<void> {
    await this.stop(serverId, options);
    await this.start(serverId);
  }

  async command(serverId: string, command: string): Promise<'stdin' | 'rcon'> {
    return this.require(serverId).sendCommand(command);
  }

  async rcon(serverId: string, command: string, timeoutMs?: number): Promise<string> {
    return this.require(serverId).rconExec(command, timeoutMs);
  }

  /**
   * Arbre des commandes du serveur, lu par `help`. Ne lève pas : un serveur arrêté, sans RCON ou
   * qui ignore `help` rend simplement « indisponible », et l'interface se rabat sans rien dire.
   */
  async commandHelp(
    serverId: string,
    name?: string,
    timeoutMs?: number,
  ): Promise<{ available: boolean; lines: string[]; truncated: boolean }> {
    const proc = this.require(serverId);
    let probe = this.helpProbes.get(serverId);
    if (!probe) {
      probe = new CommandHelpProbe({
        exec: (command, ms) => proc.rconExec(command, ms),
        state: () => proc.state,
        startedAt: () => proc.startedAt,
        log: (message, data) => {
          this.options.logger.debug(message, { serverId, ...data });
        },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
      this.helpProbes.set(serverId, probe);
    }
    return probe.fetch(name);
  }

  async acceptEula(serverId: string): Promise<void> {
    const record = this.options.store.getServer(serverId);
    if (!record) {
      throw new ProtocolError('E_NOT_FOUND', `unknown server ${serverId}`, {
        details: { serverId },
      });
    }
    await acceptEula(record.config.path);
  }

  // --- Fichiers, configuration, joueurs (phase 6) ------------------------------------------------

  serverDir(serverId: string): string {
    const record = this.options.store.getServer(serverId);
    if (!record) {
      throw new ProtocolError('E_NOT_FOUND', `unknown server ${serverId}`, {
        details: { serverId },
      });
    }
    return record.config.path;
  }

  files(serverId: string): FsService {
    return new FsService(this.serverDir(serverId), {
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
  }

  config(serverId: string): ConfigService {
    const dir = this.serverDir(serverId);
    return new ConfigService({
      serverDir: dir,
      isRunning: () => this.processes.get(serverId)?.isRunning ?? false,
      exec: (command) => this.execWithResponse(serverId, command),
      fetchImpl: this.options.fetchImpl,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
  }

  /** RCON de préférence (réponse corrélée), stdin en repli. */
  private async execWithResponse(serverId: string, command: string): Promise<CommandResult> {
    const proc = this.require(serverId);
    if (proc.rcon && proc.state === 'running') {
      try {
        return { via: 'rcon', response: await proc.rconExec(command, 5000) };
      } catch (error) {
        this.options.logger.debug('rcon exec failed, falling back to stdin', {
          serverId,
          error: errorMessage(error),
        });
      }
    }
    return { via: await proc.sendCommand(command) };
  }

  async resolvePlayers(serverId: string, names: string[]) {
    const dir = this.serverDir(serverId);
    const props = await readServerProperties(dir);
    const onlineMode = parseBooleanProperty(props.props.get('online-mode')) ?? true;
    const players = await resolvePlayers(names, {
      serverDir: dir,
      onlineMode,
      fetchImpl: this.options.fetchImpl,
    });
    return { players, onlineMode };
  }

  listLogFiles(serverId: string) {
    return listLogFiles(this.serverDir(serverId));
  }

  searchLogs(serverId: string, options: SearchOptions) {
    return searchLogs(this.serverDir(serverId), options);
  }

  /** Purge des corbeilles `.mmo-trash/` de tous les serveurs connus (7 jours). */
  async purgeTrash(): Promise<number> {
    let total = 0;
    for (const serverId of Object.keys(this.options.store.get().servers)) {
      try {
        total += await this.files(serverId).purgeTrash();
      } catch (error) {
        this.options.logger.warn('trash purge failed', { serverId, error: errorMessage(error) });
      }
    }
    return total;
  }

  // --- Monitoring (phase 7) -------------------------------------------------------------------

  /** Serveurs à échantillonner (`metrics.sample`) : PID, état, joueurs, lecture TPS si `running`. */
  metricsTargets(): MetricsTarget[] {
    const out: MetricsTarget[] = [];
    for (const [serverId, record] of Object.entries(this.options.store.get().servers)) {
      const proc = this.processes.get(serverId);
      if (!proc?.isRunning) continue;
      const probe = this.tpsProbe(serverId, record, proc);
      out.push({
        serverId,
        pid: proc.pid,
        state: proc.state,
        players: proc.onlinePlayers.length,
        maxRamMb: record.config.maxRamMb,
        readTps: () => probe.read(),
      });
    }
    return out;
  }

  private tpsProbe(serverId: string, record: ServerRecord, proc: ServerProcess): TpsProbe {
    let probe = this.tpsProbes.get(serverId);
    if (!probe) {
      probe = new TpsProbe({
        serverDir: record.config.path,
        loader: record.config.loader,
        mcVersion: record.config.mcVersion,
        exec: (command, timeoutMs) => proc.rconExec(command, timeoutMs),
        log: (message, data) => {
          this.options.logger.debug(message, { serverId, ...data });
        },
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
      this.tpsProbes.set(serverId, probe);
    }
    return probe;
  }

  /** Vue d'un serveur pour le watchdog (sonde RCON `list`, vivacité, kill « freeze »). */
  watchdogView(serverId: string): WatchdogServerView | undefined {
    const proc = this.processes.get(serverId);
    if (!proc) return undefined;
    return {
      state: () => proc.state,
      pid: proc.pid,
      probe: proc.rcon
        ? async (timeoutMs) => {
            await proc.rconExec('list', timeoutMs);
          }
        : undefined,
      alive: () => proc.pid !== undefined && isProcessAlive(proc.pid),
      kill: (reason) => proc.kill({ reason }),
    };
  }

  // --- Snapshot -------------------------------------------------------------------------------

  snapshotServers(): RequestPayload<'sync.state'>['servers'] {
    const out: RequestPayload<'sync.state'>['servers'] = [];
    for (const [serverId, record] of Object.entries(this.options.store.get().servers)) {
      const proc = this.processes.get(serverId);
      const attachMode: AttachMode = proc?.attachMode ?? 'attached';
      out.push({
        serverId,
        path: record.config.path,
        runState: proc?.state ?? 'stopped',
        attachMode,
        ...(proc?.pid === undefined ? {} : { pid: proc.pid }),
        ...(proc?.startedAt === undefined || !proc.isRunning ? {} : { startedAt: proc.startedAt }),
        ...(record.runtime?.gamePort === undefined ? {} : { gamePort: record.runtime.gamePort }),
        ...(record.rcon === undefined ? {} : { rconPort: record.rcon.port }),
      });
    }
    return out;
  }

  portsInUse(): number[] {
    const ports = new Set<number>();
    for (const [serverId, record] of Object.entries(this.options.store.get().servers)) {
      if (!this.processes.get(serverId)?.isRunning || !record.runtime) continue;
      if (record.runtime.gamePort !== undefined) ports.add(record.runtime.gamePort);
      if (record.runtime.rconPort !== undefined) ports.add(record.runtime.rconPort);
    }
    return [...ports].sort((a, b) => a - b);
  }

  get runningCount(): number {
    let n = 0;
    for (const p of this.processes.values()) if (p.isRunning) n++;
    return n;
  }

  dispose(): void {
    for (const p of this.processes.values()) p.dispose();
  }

  // --- Internes -------------------------------------------------------------------------------

  private getOrCreate(serverId: string, record: ServerRecord): ServerProcess {
    let proc = this.processes.get(serverId);
    if (!proc) {
      proc = new ServerProcess({
        serverId,
        serverDir: record.config.path,
        logger: this.options.logger.child(serverId),
        seq: {
          next: () => this.options.store.nextSeq(`console:${serverId}`),
          current: () => this.options.store.currentSeq(`console:${serverId}`),
        },
        onEvent: (event) => {
          this.onProcessEvent(serverId, event);
        },
        ...(record.config.startTimeoutSec === undefined
          ? this.options.startTimeoutMs === undefined
            ? {}
            : { startTimeoutMs: this.options.startTimeoutMs }
          : { startTimeoutMs: record.config.startTimeoutSec * 1000 }),
        ...(this.options.rconProbeIntervalMs === undefined
          ? {}
          : { rconProbeIntervalMs: this.options.rconProbeIntervalMs }),
        ...(this.options.exitPollMs === undefined ? {} : { exitPollMs: this.options.exitPollMs }),
      });
      if (record.rcon) proc.setRcon(record.rcon);
      this.processes.set(serverId, proc);
    }
    return proc;
  }

  private onProcessEvent(serverId: string, event: ServerProcessEvent): void {
    if (event.kind === 'state' && event.state === 'starting') {
      // Nouveau démarrage : mods/version ont pu changer, la chaîne TPS est réapprise — et
      // l'arbre des commandes aussi, un modpack mis à jour n'expose plus les mêmes.
      this.tpsProbes.get(serverId)?.reset();
      this.helpProbes.get(serverId)?.reset();
    }
    if (event.kind === 'state' && event.state === 'running') {
      // Le signal le plus proche de « RCON accepte les connexions » dont dispose l'agent : lève
      // le verrou d'un échec de transport sans jeter la chaîne apprise. `running` peut être
      // déclaré par la ligne « Done » alors que le listener RCON n'est pas encore ouvert — d'où
      // le backoff court côté sonde, que ce déblocage complète sans le remplacer.
      this.tpsProbes.get(serverId)?.unlock();
    }
    if (event.kind === 'state' && (event.state === 'stopped' || event.state === 'crashed')) {
      this.persist(
        this.options.store.update((s) => {
          const r = s.servers[serverId];
          if (r) delete r.runtime;
        }),
      );
    }
    if (event.kind === 'lines') this.persist(this.options.store.flush());
    this.options.onEvent(serverId, event);
  }

  /** Écriture d'état en arrière-plan : une erreur (dossier supprimé à l'arrêt…) est journalisée, jamais fatale. */
  private persist(promise: Promise<void>): void {
    promise.catch((error: unknown) => {
      this.options.logger.warn('state persist failed', { error: errorMessage(error) });
    });
  }

  private committedRamMb(except: string): number {
    let sum = 0;
    for (const [id, record] of Object.entries(this.options.store.get().servers)) {
      if (id === except) continue;
      if (this.processes.get(id)?.isRunning) sum += record.config.maxRamMb;
    }
    return sum;
  }

  private async resolveJava(
    config: ServerConfig,
    mcVersion: string | undefined,
    loader: ServerConfig['loader'],
  ): Promise<JavaRuntime> {
    if (this.options.javaResolver) return this.options.javaResolver({ config, mcVersion });
    if (config.javaPath !== undefined) {
      const rt = await this.java.probe(config.javaPath);
      if (!rt) {
        throw new ProtocolError('E_JAVA_UNAVAILABLE', `java not usable: ${config.javaPath}`, {
          details: { javaPath: config.javaPath },
        });
      }
      return rt;
    }
    const table = javaRequirementFromTable(mcVersion ?? '', loader, config.javaMajor);
    const requirement = {
      majorVersion: config.javaMajor ?? table.majorVersion,
      strict: config.javaStrict ?? table.strict,
    };
    const rt = await this.java.select(requirement);
    if (!rt) {
      const available = (await this.java.list()).map((r) => r.majorVersion);
      throw new ProtocolError(
        'E_JAVA_UNAVAILABLE',
        `no java ${String(requirement.majorVersion)} available`,
        {
          details: { required: requirement.majorVersion, strict: requirement.strict, available },
        },
      );
    }
    return rt;
  }

  private ensureRcon(
    serverId: string,
    record: ServerRecord,
  ): Promise<{ port: number; password: string }> {
    // Un seul choix de port à la fois : la lecture de l'état, les sondes et l'écriture du store
    // sont asynchrones, deux démarrages concurrents retenaient le même port libre (test d'échelle).
    const run = this.rconAllocation.then(
      () => this.allocateRcon(serverId, record),
      () => this.allocateRcon(serverId, record),
    );
    this.rconAllocation = run.catch(() => undefined);
    return run;
  }

  private async allocateRcon(
    serverId: string,
    record: ServerRecord,
  ): Promise<{ port: number; password: string }> {
    const [from, to] = this.options.rconPortRange ?? [25575, 25675];
    const used = new Set<number>();
    for (const [id, r] of Object.entries(this.options.store.get().servers)) {
      if (id !== serverId && r.rcon) used.add(r.rcon.port);
      if (r.runtime?.gamePort !== undefined) used.add(r.runtime.gamePort);
    }
    // Le port de jeu du serveur lui-même ne doit pas être réutilisé pour RCON.
    const { props } = await readServerProperties(record.config.path);
    used.add(gamePortFromProperties(props));
    // L'enregistrement passé en argument peut dater d'avant l'attente : relire l'état courant.
    let rcon = this.options.store.get().servers[serverId]?.rcon ?? record.rcon;
    if (rcon && (used.has(rcon.port) || !(await isPortFree(rcon.port)))) rcon = undefined;
    if (!rcon) {
      const port = await findFreePort(from, to, used);
      if (port === undefined) {
        throw new ProtocolError('E_PORT_IN_USE', 'no free RCON port in range', {
          details: { from, to },
        });
      }
      rcon = { port, password: generateRconPassword() };
      await this.options.store.update((s) => {
        const r = s.servers[serverId];
        if (r) r.rcon = rcon;
      });
    }
    return rcon;
  }
}

export function serverDirOf(record: ServerRecord): string {
  return path.normalize(record.config.path);
}
