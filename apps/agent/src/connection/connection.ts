/**
 * Session panel↔agent (doc 05 §3–5, §7, §10) : connexion WS sortante en backoff, appairage,
 * `auth.hello` → négociation, `sync.state`, heartbeat, journal des événements critiques rejoués
 * jusqu'à `event.ack`. Les handlers de requêtes sont (ré)enregistrés à chaque nouveau pair via
 * `registerHandlers`.
 */
import os from 'node:os';
import zlib from 'node:zlib';

import {
  EVENTS,
  PROTOCOL_VERSION,
  ProtocolError,
  createRpcPeer,
  isProtocolError,
  ulid,
  type Compression,
  type EventPayload,
  type EventTypesFrom,
  type RequestPayload,
  type RpcPeer,
} from '@mmo/protocol';

import { errorMessage, type Logger } from '../log.js';
import type { StateStore } from '../state/store.js';
import { Backoff, type BackoffOptions } from './backoff.js';
import {
  createWsTransport,
  openWebSocket,
  type WebSocketFactory,
  type WsTransport,
} from './ws-transport.js';

export type AgentPeer = RpcPeer<'agent'>;
type AgentEventType = EventTypesFrom<'agent'>;

export interface SessionInfo {
  protocolVersion: number;
  heartbeatIntervalSec: number;
  compression: Compression | undefined;
  subscriptions: { channel: string; sinceSeq: number }[];
}

export interface ConnectionOptions {
  panelUrl: string;
  store: StateStore;
  logger: Logger;
  agentVersion: string;
  /** Code d'appairage (premier démarrage seulement). */
  pairCode?: string | undefined;
  capabilities?: string[];
  /** Enregistre les handlers sur chaque nouveau pair. */
  registerHandlers: (peer: AgentPeer) => void;
  /** Snapshot `sync.state` (vérité terrain de l'agent). */
  buildSyncState: () => RequestPayload<'sync.state'>;
  /** Heartbeat périodique. */
  buildHeartbeat: () => EventPayload<'agent.heartbeat'>;
  /** Tasks encore en cours côté agent (`auth.hello.resume`). */
  pendingTaskIds?: () => string[];
  /** Session établie (après sync + rejeu). */
  onSession?: (session: SessionInfo, peer: AgentPeer) => void | Promise<void>;
  onDisconnect?: (reason: string | undefined) => void;
  webSocketFactory?: WebSocketFactory;
  backoff?: BackoffOptions;
  connectTimeoutMs?: number;
  /** Délai maximal entre deux événements non critiques en file (console) avant envoi. */
  now?: () => number;
}

export function machineInfo(): RequestPayload<'pair.request'>['machine'] {
  const platform = process.platform;
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    os: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    ...(cpus[0] === undefined ? {} : { cpuModel: cpus[0].model }),
    ...(cpus.length > 0 ? { cpuCores: cpus.length } : {}),
    ramTotalMb: Math.max(1, Math.round(os.totalmem() / 1048576)),
    addresses: networkAddresses(),
  };
}

/**
 * Phase 10 : adresses utiles aux joueurs (doc 03 §5), sans aucun appel à Tailscale — seulement la
 * forme des adresses : tailnet = 100.64.0.0/10 (CGNAT réservé à Tailscale) et fd7a:115c:a1e0::/48 ;
 * global = IPv6 unicast globale 2000::/3 (hors adresses temporaires impossibles à distinguer ici)
 * et IPv4 non privée. Les adresses link-local et de boucle sont ignorées.
 */
export function networkAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): { tailnet: string[]; global: string[] } {
  const tailnet: string[] = [];
  const global: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      if (info.family === 'IPv4') {
        const [a, b] = info.address.split('.').map(Number);
        if (a === 100 && b !== undefined && b >= 64 && b <= 127) tailnet.push(info.address);
        else if (
          a === 10 ||
          (a === 192 && b === 168) ||
          (a === 172 && b !== undefined && b >= 16 && b <= 31)
        ) {
          continue;
        } else if (a === 169 && b === 254) continue;
        else global.push(info.address);
      } else {
        const address = (info.address.split('%')[0] ?? info.address).toLowerCase();
        if (address.startsWith('fd7a:115c:a1e0:')) tailnet.push(address);
        else if (/^[23][0-9a-f]{3}:/.test(address)) global.push(address);
      }
    }
  }
  return { tailnet: unique(tailnet), global: unique(global) };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Codecs disponibles dans ce runtime (spike n°3 : zstd ≥ Node 22.15, jamais présumé). */
export function supportedCompression(): Compression[] {
  const codecs: Compression[] = ['none', 'gzip'];
  if (typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function') {
    codecs.push('zstd');
  }
  return codecs;
}

export class AgentConnection {
  private readonly backoff: Backoff;
  private running = false;
  private peer: AgentPeer | undefined;
  private transport: WsTransport | undefined;
  private session: SessionInfo | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private wakeup: (() => void) | undefined;
  private loop: Promise<void> | undefined;
  private lastError: string | undefined;

  constructor(private readonly options: ConnectionOptions) {
    this.backoff = new Backoff(options.backoff);
  }

  get isConnected(): boolean {
    return this.session !== undefined && this.peer !== undefined && !this.peer.isClosed;
  }

  get currentSession(): SessionInfo | undefined {
    return this.session;
  }

  get lastConnectionError(): string | undefined {
    return this.lastError;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.transport?.close(1000, 'agent stopping');
    this.wakeup?.();
    await this.loop;
  }

  /**
   * Phase 11 : appairage seul (installeurs) — une connexion, `pair.request`, état écrit, fermeture.
   * Lève si le code est refusé ou le panel injoignable ; `alreadyPaired` si un secret existe déjà.
   */
  async pairOnly(): Promise<{ agentId: string; alreadyPaired: boolean }> {
    const state = this.options.store.get();
    if (state.agentId !== undefined && state.agentSecret !== undefined) {
      return { agentId: state.agentId, alreadyPaired: true };
    }
    const ws = await openWebSocket(
      this.options.panelUrl,
      this.options.webSocketFactory,
      this.options.connectTimeoutMs,
    );
    const transport = createWsTransport(ws);
    const peer = createRpcPeer({
      role: 'agent',
      transport,
      logger: this.options.logger,
      now: () => this.now(),
    });
    this.options.registerHandlers(peer);
    try {
      await this.pair(peer);
    } finally {
      transport.close(1000, 'paired');
    }
    const agentId = this.options.store.get().agentId;
    if (agentId === undefined) throw new Error('pairing did not persist an agent id');
    return { agentId, alreadyPaired: false };
  }

  /** Force une reconnexion immédiate (ex. après rotation de secret). */
  reconnect(reason: string): void {
    this.transport?.close(1000, reason);
  }

  // --- Événements -----------------------------------------------------------------------------

  /**
   * Émet un événement ; les événements critiques sont journalisés dans l'état et rejoués à chaque
   * session jusqu'à `event.ack` (doc 05 §6). Retourne l'`id` d'enveloppe des événements critiques.
   */
  emit<T extends AgentEventType>(
    type: T,
    payloadOrFactory: EventPayload<T> | ((eventId: string) => EventPayload<T>),
  ): string | undefined {
    const critical = EVENTS[type].critical;
    const id = ulid(this.now());
    const payload =
      typeof payloadOrFactory === 'function' ? payloadOrFactory(id) : payloadOrFactory;
    if (critical) {
      this.options.store.mutate((s) => {
        s.pendingEvents.push({ id, type, payload, ts: this.now() });
        if (s.pendingEvents.length > 10_000)
          s.pendingEvents.splice(0, s.pendingEvents.length - 10_000);
      });
      this.persist(this.options.store.flush());
      this.trySend(type, payload, id);
      return id;
    }
    this.trySend(type, payload, undefined);
    return undefined;
  }

  /** Écriture d'état en arrière-plan : une erreur (dossier supprimé à l'arrêt…) est journalisée, jamais fatale. */
  private persist(promise: Promise<void>): void {
    promise.catch((error: unknown) => {
      this.options.logger.warn('state persist failed', { error: errorMessage(error) });
    });
  }

  private trySend(type: AgentEventType, payload: unknown, id: string | undefined): void {
    const peer = this.peer;
    if (!peer || peer.isClosed || !this.session) return;
    try {
      peer.emit(type, payload as never, id === undefined ? {} : { id });
    } catch (error) {
      this.options.logger.warn('emit failed', { type, error: errorMessage(error) });
    }
  }

  acknowledge(eventIds: string[]): void {
    const ids = new Set(eventIds);
    this.options.store.mutate((s) => {
      s.pendingEvents = s.pendingEvents.filter((e) => !ids.has(e.id));
    });
    this.persist(this.options.store.flush());
  }

  // --- Boucle ---------------------------------------------------------------------------------

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private isRunningLoop(): boolean {
    return this.running;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.runSession();
        this.lastError = undefined;
      } catch (error) {
        this.lastError = errorMessage(error);
        this.options.logger.warn('session ended with error', { error: this.lastError });
        if (isProtocolError(error) && !error.retryable) {
          // E_AUTH / E_UNSUPPORTED_VERSION / E_PAIRING_CODE_INVALID : on réessaie au rythme maximal.
          for (let i = 0; i < 10; i++) this.backoff.next();
        }
      }
      if (!this.isRunningLoop()) break;
      const delay = this.backoff.next();
      this.options.logger.info(`reconnecting in ${String(delay)} ms`, {
        attempt: this.backoff.attempts,
      });
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeup = undefined;
        resolve();
      }, ms);
      this.wakeup = () => {
        clearTimeout(timer);
        this.wakeup = undefined;
        resolve();
      };
    });
  }

  private async runSession(): Promise<void> {
    const { logger, store } = this.options;
    const ws = await openWebSocket(
      this.options.panelUrl,
      this.options.webSocketFactory,
      this.options.connectTimeoutMs,
    );
    const transport = createWsTransport(ws);
    this.transport = transport;
    const closed = new Promise<string | undefined>((resolve) => {
      transport.onClose(resolve);
    });
    const peer = createRpcPeer({ role: 'agent', transport, logger, now: () => this.now() });
    this.peer = peer;
    this.options.registerHandlers(peer);
    peer.handle('event.ack', ({ eventIds }) => {
      this.acknowledge(eventIds);
      return {};
    });

    try {
      const state = store.get();
      if (state.agentId === undefined || state.agentSecret === undefined) {
        await this.pair(peer);
        // Doc 05 §3 : reconnexion après appairage, puis auth.hello.
        transport.close(1000, 'paired');
        this.backoff.reset();
        await closed;
        return;
      }
      const session = await this.authenticate(peer, state.agentId, state.agentSecret);
      this.backoff.reset();
      this.session = session;
      this.startHeartbeat(peer, session.heartbeatIntervalSec);
      this.replayPending(peer);
      await this.options.onSession?.(session, peer);
      const reason = await closed;
      logger.info('disconnected', { reason });
    } finally {
      this.stopHeartbeat();
      const hadSession = this.session !== undefined;
      this.session = undefined;
      this.peer = undefined;
      this.transport = undefined;
      transport.close();
      if (hadSession) this.options.onDisconnect?.(this.lastError);
    }
  }

  private async pair(peer: AgentPeer): Promise<void> {
    const code = this.options.pairCode;
    if (code === undefined || code === '') {
      throw new ProtocolError('E_AUTH', 'agent not paired and no pairing code provided', {
        retryable: false,
      });
    }
    this.options.logger.info('pairing with panel');
    const res = await peer.request('pair.request', {
      code,
      machine: machineInfo(),
      agentVersion: this.options.agentVersion,
      protoMin: PROTOCOL_VERSION,
      protoMax: PROTOCOL_VERSION,
    });
    await this.options.store.update((s) => {
      s.agentId = res.agentId;
      s.agentSecret = res.secret;
      s.panelUrl = this.options.panelUrl;
    });
    this.options.logger.info('paired', { agentId: res.agentId });
  }

  private async authenticate(
    peer: AgentPeer,
    agentId: string,
    agentSecret: string,
  ): Promise<SessionInfo> {
    const state = this.options.store.get();
    const ok = await peer.request('auth.hello', {
      agentId,
      agentSecret,
      agentVersion: this.options.agentVersion,
      runtimeVersion: process.version.replace(/^v/, ''),
      protoMin: PROTOCOL_VERSION,
      protoMax: PROTOCOL_VERSION,
      capabilities: this.options.capabilities ?? ['rcon'],
      compression: supportedCompression(),
      resume: { pendingTaskIds: this.options.pendingTaskIds?.() ?? [] },
      machine: machineInfo(),
    });
    peer.version = ok.protocolVersion;
    const session: SessionInfo = {
      protocolVersion: ok.protocolVersion,
      heartbeatIntervalSec: ok.heartbeatIntervalSec,
      compression: ok.compression,
      subscriptions: ok.subscriptions,
    };
    this.options.logger.info('authenticated', {
      protocolVersion: ok.protocolVersion,
      heartbeatIntervalSec: ok.heartbeatIntervalSec,
    });
    if (ok.wantFullSync) {
      await peer.request('sync.state', this.options.buildSyncState());
    }
    if (state.previousSecret !== undefined && state.previousSecret.graceUntil < this.now()) {
      await this.options.store.update((s) => {
        delete s.previousSecret;
      });
    }
    return session;
  }

  private replayPending(peer: AgentPeer): void {
    const pending = [...this.options.store.get().pendingEvents];
    if (pending.length === 0) return;
    this.options.logger.info('replaying pending critical events', { count: pending.length });
    for (const e of pending) {
      try {
        peer.emit(e.type as AgentEventType, e.payload as never, { id: e.id });
      } catch (error) {
        this.options.logger.warn('replay failed', { type: e.type, error: errorMessage(error) });
      }
    }
  }

  private startHeartbeat(peer: AgentPeer, intervalSec: number): void {
    this.stopHeartbeat();
    const send = (): void => {
      if (peer.isClosed) return;
      try {
        peer.emit('agent.heartbeat', this.options.buildHeartbeat());
      } catch (error) {
        this.options.logger.warn('heartbeat failed', { error: errorMessage(error) });
      }
    };
    send();
    this.heartbeatTimer = setInterval(send, Math.max(1, intervalSec) * 1000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}
