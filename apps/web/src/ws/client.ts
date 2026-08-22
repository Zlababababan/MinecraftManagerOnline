/**
 * Client `/ws/client` (doc 07 phase 4/5) : connexion authentifiée par le cookie de session,
 * reconnexion avec backoff, abonnements par canal comptés (`console:<id>`), ping périodique.
 * Les messages sont validés par `serverMessageSchema` (champs inconnus ignorés : le panel peut
 * être plus récent que le front).
 */
import { serverMessageSchema, type ClientMessage, type ServerMessage } from '@mmo/protocol/client';

export type RealtimeStatus = 'connecting' | 'open' | 'closed';
export type MessageHandler = (message: ServerMessage) => void;
export type StatusHandler = (status: RealtimeStatus) => void;

export interface RealtimeClientOptions {
  url?: string;
  /** Fabrique de WebSocket (tests). */
  factory?: (url: string) => WebSocket;
  backoff?: { baseMs: number; maxMs: number };
  pingIntervalMs?: number;
}

const defaultUrl = (): string => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/client`;
};

export class RealtimeClient {
  private ws: WebSocket | undefined;
  private readonly handlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly channels = new Map<string, number>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private wanted = false;
  private _status: RealtimeStatus = 'closed';

  constructor(private readonly options: RealtimeClientOptions = {}) {}

  get status(): RealtimeStatus {
    return this._status;
  }

  /** Ouvre (ou rouvre) la connexion ; idempotent. */
  connect(): void {
    this.wanted = true;
    if (this.ws !== undefined) return;
    this.open();
  }

  /** Ferme volontairement (déconnexion) — plus aucune reconnexion. */
  disconnect(): void {
    this.wanted = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onclose = null;
      ws.close(1000, 'client disconnect');
    }
    this.setStatus('closed');
  }

  on(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  /** Abonnement compté : le premier abonné envoie `subscribe`, le dernier `unsubscribe`. */
  subscribe(channel: string): () => void {
    const count = this.channels.get(channel) ?? 0;
    this.channels.set(channel, count + 1);
    if (count === 0) this.send({ type: 'subscribe', channels: [channel] });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.channels.get(channel) ?? 0;
      if (current <= 1) {
        this.channels.delete(channel);
        this.send({ type: 'unsubscribe', channels: [channel] });
      } else {
        this.channels.set(channel, current - 1);
      }
    };
  }

  /** Réabonne un canal déjà compté (rattrapage : nouveau snapshot demandé au panel). */
  resubscribe(channel: string): void {
    if (this.channels.has(channel)) this.send({ type: 'subscribe', channels: [channel] });
  }

  send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private open(): void {
    const url = this.options.url ?? defaultUrl();
    this.setStatus('connecting');
    const ws = this.options.factory === undefined ? new WebSocket(url) : this.options.factory(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      const channels = [...this.channels.keys()];
      if (channels.length > 0) this.send({ type: 'subscribe', channels });
      const interval = this.options.pingIntervalMs ?? 30_000;
      this.pingTimer = setInterval(() => {
        this.send({ type: 'ping', ts: Date.now() });
      }, interval);
    };
    ws.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = serverMessageSchema.safeParse(json);
      if (!parsed.success) return;
      for (const handler of this.handlers) handler(parsed.data);
    };
    ws.onclose = (event: CloseEvent) => {
      this.ws = undefined;
      this.clearTimers();
      this.setStatus('closed');
      // 4001 = session révoquée, 1008 = non authentifié : inutile d'insister.
      if (!this.wanted || event.code === 4001 || event.code === 1008) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // `onclose` suit toujours une erreur : la reconnexion y est gérée.
    };
  }

  private scheduleReconnect(): void {
    const { baseMs, maxMs } = this.options.backoff ?? { baseMs: 1_000, maxMs: 15_000 };
    const delay = Math.min(maxMs, baseMs * 2 ** this.attempt) * (0.8 + Math.random() * 0.4);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.wanted && this.ws === undefined) this.open();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.reconnectTimer = undefined;
    this.pingTimer = undefined;
  }

  private setStatus(status: RealtimeStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const handler of this.statusHandlers) handler(status);
  }
}

/** Instance unique de l'application (les tests en créent d'autres). */
export const realtime = new RealtimeClient();
