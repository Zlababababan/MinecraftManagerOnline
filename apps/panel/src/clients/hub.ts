/**
 * Hub des navigateurs connectés à `/ws/client` (doc 07 phase 4) : diffusion des événements du bus,
 * des états serveurs, des heartbeats machines et des flux console par canal (`console:<serverId>`).
 * Lot 8 : chaque message diffusé passe par `filter` (droits par serveur — un compte limité ne
 * reçoit que ce qui concerne ses portées) et chaque abonnement par `canSubscribe`.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';

import { BACKPRESSURE, backpressureAction } from '@mmo/protocol';
import { clientMessageSchema, type ServerMessage, type UserDto } from '@mmo/protocol/client';

/** Messages remplacés par les suivants : les perdre sous contre-pression ne coûte rien. */
const LOW_VALUE_MESSAGES: ReadonlySet<ServerMessage['type']> = new Set([
  'metrics.sample',
  'console.lines',
]);

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
  /** Seuils de contre-pression (défaut `BACKPRESSURE` ; abaissés en test). */
  backpressure?: { dropAboveBytes: number; closeAboveBytes: number };
  /**
   * Lot 8 : ce qu'une connexion a le droit de recevoir d'un message diffusé — le message, une
   * copie retaillée, ou `undefined` (rien). Défaut : tout le monde reçoit tout.
   */
  filter?: (conn: ClientConnection, message: ServerMessage) => ServerMessage | undefined;
  /** Lot 8 : abonnement refusé → `error E_NOT_FOUND` sur le canal, sans rien inscrire. */
  canSubscribe?: (conn: ClientConnection, channel: string) => boolean;
}

/** Code de fermeture « droits modifiés » : le front se reconnecte et relit ses listes. */
export const CLOSE_PERMISSIONS_CHANGED = 4002;

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
    let dropped = 0;
    const conn: ClientConnection = {
      id,
      user,
      channels: new Set(),
      send: (message) => {
        if (ws.readyState !== ws.OPEN) return;
        // Contre-pression (lot 9) : un navigateur qui ne lit plus ne doit pas faire gonfler la
        // mémoire du panel. Échantillons et lignes de console sont abandonnés au-delà de 1 Mio en
        // attente (les suivants les remplacent) ; au-delà de 8 Mio, le socket est fermé et le
        // front se reconnecte. Les états et événements passent toujours.
        const action = backpressureAction(
          ws.bufferedAmount,
          LOW_VALUE_MESSAGES.has(message.type),
          this.options.backpressure ?? BACKPRESSURE,
        );
        if (action === 'send') {
          ws.send(JSON.stringify(message));
          return;
        }
        if (action === 'drop') {
          dropped += 1;
          if (dropped === 1) {
            this.options.logger.warn(
              { clientId: id, user: user.username, bufferedAmount: ws.bufferedAmount },
              'client falling behind: low-value messages dropped',
            );
          }
          return;
        }
        this.options.logger.warn(
          { clientId: id, user: user.username, bufferedAmount: ws.bufferedAmount, dropped },
          'client not reading: closing (it will reconnect)',
        );
        ws.close(1013, 'client too slow');
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

  /**
   * Déconnecte toutes les sessions d'un utilisateur (désactivation, suppression, changement de
   * rôle : 4001, le front n'insiste pas ; droits modifiés : `CLOSE_PERMISSIONS_CHANGED`, le
   * front se reconnecte aussitôt et ses abonnements sont rejugés).
   */
  disconnectUser(userId: string, reason = 'session revoked', code = 4001): void {
    for (const conn of this.connections.values()) {
      if (conn.user.id === userId) conn.close(code, reason);
    }
  }

  broadcast(message: ServerMessage): void {
    const filter = this.options.filter;
    for (const conn of this.connections.values()) {
      if (filter === undefined) {
        conn.send(message);
        continue;
      }
      const allowed = filter(conn, message);
      if (allowed !== undefined) conn.send(allowed);
    }
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
    if (this.options.canSubscribe?.(conn, channel) === false) {
      // Même réponse qu'un serveur inexistant : un compte limité n'énumère pas le parc.
      conn.send({
        type: 'error',
        channel,
        error: { code: 'E_NOT_FOUND', message: `channel ${channel} not found` },
      });
      return;
    }
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
