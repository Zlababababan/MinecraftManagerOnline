/**
 * Hub des navigateurs connectés à `/ws/client` (doc 07 phase 4) : diffusion des événements du bus,
 * des états serveurs, des heartbeats machines et des flux console par canal (`console:<serverId>`).
 * Tout utilisateur authentifié reçoit les événements (droits par serveur : extension future, doc 04).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';

import { clientMessageSchema, type ServerMessage, type UserDto } from '@mmo/protocol/client';

export interface ClientConnection {
  readonly id: number;
  readonly user: UserDto;
  readonly channels: Set<string>;
  send(message: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

export interface ClientHubOptions {
  logger: FastifyBaseLogger;
  now: () => number;
  /** Premier abonné d'un canal (ou nouvel abonné) : rattrapage à envoyer. */
  onSubscribe: (channel: string, conn: ClientConnection, first: boolean) => void | Promise<void>;
  /** Dernier abonné parti. */
  onUnsubscribe: (channel: string) => void;
}

export class ClientHub {
  private readonly connections = new Map<number, ClientConnection>();
  private readonly channels = new Map<string, Set<ClientConnection>>();
  private nextId = 1;

  constructor(private readonly options: ClientHubOptions) {}

  get size(): number {
    return this.connections.size;
  }

  subscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  subscribedChannels(): string[] {
    return [...this.channels.keys()];
  }

  /** Attache un socket `ws` authentifié. */
  attach(ws: WebSocket, user: UserDto): ClientConnection {
    const id = this.nextId++;
    const conn: ClientConnection = {
      id,
      user,
      channels: new Set(),
      send: (message) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
      close: (code, reason) => {
        ws.close(code, reason);
      },
    };
    this.connections.set(id, conn);
    ws.on('message', (data) => {
      this.onMessage(
        conn,
        typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8'),
      );
    });
    ws.on('close', () => {
      this.detach(conn);
    });
    ws.on('error', (error) => {
      this.options.logger.warn({ err: error, clientId: id }, 'client websocket error');
    });
    conn.send({ type: 'hello', user, serverTime: this.options.now() });
    return conn;
  }

  /** Déconnecte toutes les sessions d'un utilisateur (désactivation, suppression, changement de rôle). */
  disconnectUser(userId: string, reason = 'session revoked'): void {
    for (const conn of this.connections.values()) {
      if (conn.user.id === userId) conn.close(4001, reason);
    }
  }

  broadcast(message: ServerMessage): void {
    for (const conn of this.connections.values()) conn.send(message);
  }

  publish(channel: string, message: ServerMessage): void {
    const subs = this.channels.get(channel);
    if (!subs) return;
    for (const conn of subs) conn.send(message);
  }

  closeAll(): void {
    for (const conn of this.connections.values()) conn.close(1001, 'panel shutting down');
    this.connections.clear();
    this.channels.clear();
  }

  private detach(conn: ClientConnection): void {
    this.connections.delete(conn.id);
    for (const channel of [...conn.channels]) this.unsubscribe(conn, channel);
  }

  private onMessage(conn: ClientConnection, raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      conn.send({
        type: 'error',
        error: { code: 'E_INVALID_PAYLOAD', message: 'unparseable message' },
      });
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      conn.send({
        type: 'error',
        error: { code: 'E_INVALID_PAYLOAD', message: 'invalid client message' },
      });
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'ping':
        conn.send({ type: 'pong', ts: this.options.now() });
        return;
      case 'subscribe':
        for (const channel of msg.channels) this.subscribe(conn, channel);
        return;
      case 'unsubscribe':
        for (const channel of msg.channels) this.unsubscribe(conn, channel);
        return;
    }
  }

  private subscribe(conn: ClientConnection, channel: string): void {
    let subs = this.channels.get(channel);
    const first = subs === undefined || subs.size === 0;
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(conn);
    conn.channels.add(channel);
    Promise.resolve(this.options.onSubscribe(channel, conn, first)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn({ channel, message }, 'subscribe handler failed');
      conn.send({ type: 'error', channel, error: { code: 'E_INTERNAL', message } });
    });
  }

  private unsubscribe(conn: ClientConnection, channel: string): void {
    conn.channels.delete(channel);
    const subs = this.channels.get(channel);
    if (!subs) return;
    subs.delete(conn);
    if (subs.size === 0) {
      this.channels.delete(channel);
      this.options.onUnsubscribe(channel);
    }
  }
}
