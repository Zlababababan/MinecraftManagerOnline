/**
 * Relais console (doc 05 §6–§7, doc 04 §8.2 : jamais en SQLite) : ring buffer mémoire par serveur
 * côté panel, abonnement à l'agent quand un navigateur regarde (`console.subscribe` avec `sinceSeq`
 * = dernier `seq` connu), désabonnement quand plus personne ne regarde, dédup par `seq`,
 * ré-abonnement automatique à la reconnexion de l'agent (`subscriptions` de `auth.ok`).
 */
import type { FastifyBaseLogger } from 'fastify';

import type { ConsoleLine, ParsedResponsePayload } from '@mmo/protocol';
import { consoleChannel, parseConsoleChannel } from '@mmo/protocol/client';

import type { ClientConnection, ClientHub } from '../clients/hub.js';
import type { ServersService } from '../services/servers.js';
import type { AgentRegistry } from './registry.js';

const RING_MAX = 1000;

interface Buffer {
  lines: ConsoleLine[];
  latestSeq: number;
  /** Dernier `seq` connu via `sync.state` (sans lignes) — point de départ du rattrapage. */
  seenSeq: number;
}

export class ConsoleRelay {
  private readonly buffers = new Map<string, Buffer>();
  private hub: ClientHub | undefined;

  constructor(
    private readonly deps: {
      logger: FastifyBaseLogger;
      registry: AgentRegistry;
      servers: ServersService;
    },
  ) {}

  bind(hub: ClientHub): void {
    this.hub = hub;
  }

  private buffer(serverId: string): Buffer {
    let b = this.buffers.get(serverId);
    if (!b) {
      b = { lines: [], latestSeq: 0, seenSeq: 0 };
      this.buffers.set(serverId, b);
    }
    return b;
  }

  /** `console.lines` reçu d'un agent : dédup par `seq`, ring buffer, diffusion. */
  onLines(serverId: string, lines: ConsoleLine[]): void {
    const b = this.buffer(serverId);
    const fresh = lines.filter((l) => l.seq > b.latestSeq).sort((x, y) => x.seq - y.seq);
    if (fresh.length === 0) return;
    this.append(b, fresh);
    this.hub?.publish(consoleChannel(serverId), { type: 'console.lines', serverId, lines: fresh });
  }

  private append(b: Buffer, fresh: ConsoleLine[]): void {
    b.lines.push(...fresh);
    if (b.lines.length > RING_MAX) b.lines.splice(0, b.lines.length - RING_MAX);
    b.latestSeq = Math.max(b.latestSeq, fresh.at(-1)?.seq ?? 0);
    b.seenSeq = Math.max(b.seenSeq, b.latestSeq);
  }

  /** Compteurs `seq` du snapshot `sync.state` (`console:<serverId>`). */
  onSeqs(seqs: Record<string, number>): void {
    for (const [channel, seq] of Object.entries(seqs)) {
      const serverId = parseConsoleChannel(channel);
      if (serverId === undefined) continue;
      const b = this.buffer(serverId);
      if (b.latestSeq === 0 && b.seenSeq === 0) b.seenSeq = seq;
    }
  }

  /** Ré-abonnements à transmettre dans `auth.ok` (canaux regardés par au moins un navigateur). */
  subscriptionsFor(machineId: string): { channel: string; sinceSeq: number }[] {
    const hub = this.hub;
    if (!hub) return [];
    const out: { channel: string; sinceSeq: number }[] = [];
    for (const channel of hub.subscribedChannels()) {
      const serverId = parseConsoleChannel(channel);
      if (serverId === undefined) continue;
      const row = this.deps.servers.get(serverId);
      if (row?.machineId !== machineId) continue;
      out.push({ channel, sinceSeq: this.buffer(serverId).latestSeq });
    }
    return out;
  }

  /** Nouvel abonné navigateur : snapshot du buffer panel, complété par l'agent si c'est le premier. */
  async onSubscribe(channel: string, conn: ClientConnection, first: boolean): Promise<void> {
    const serverId = parseConsoleChannel(channel);
    if (serverId === undefined) return;
    const row = this.deps.servers.get(serverId);
    if (!row) {
      conn.send({
        type: 'error',
        channel,
        error: { code: 'E_NOT_FOUND', message: `server ${serverId} not found` },
      });
      return;
    }
    const b = this.buffer(serverId);
    let truncated = false;
    if (first) {
      const session = this.deps.registry.get(row.machineId);
      if (session) {
        try {
          const res = await session.peer.request('console.subscribe', {
            serverId,
            sinceSeq: b.latestSeq,
          });
          this.merge(serverId, res);
          truncated = res.truncated;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.deps.logger.warn({ serverId, message }, 'console.subscribe failed');
        }
      }
    }
    conn.send({
      type: 'console.snapshot',
      serverId,
      lines: [...b.lines],
      truncated,
      latestSeq: b.latestSeq,
    });
  }

  private merge(serverId: string, res: ParsedResponsePayload<'console.subscribe'>): void {
    const b = this.buffer(serverId);
    const fresh = res.lines.filter((l) => l.seq > b.latestSeq).sort((x, y) => x.seq - y.seq);
    if (fresh.length > 0) this.append(b, fresh);
    b.latestSeq = Math.max(b.latestSeq, res.latestSeq);
    b.seenSeq = Math.max(b.seenSeq, res.latestSeq);
  }

  /** Plus aucun navigateur sur ce canal : l'agent cesse d'émettre (économie de bande passante). */
  onUnsubscribe(channel: string): void {
    const serverId = parseConsoleChannel(channel);
    if (serverId === undefined) return;
    const row = this.deps.servers.get(serverId);
    const session = row === undefined ? undefined : this.deps.registry.get(row.machineId);
    if (!session) return;
    session.peer.request('console.unsubscribe', { serverId }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.debug({ serverId, message }, 'console.unsubscribe failed');
    });
  }

  /** Snapshot pour l'API REST (`GET /api/servers/:id/console`). */
  snapshot(serverId: string, sinceSeq = 0): { lines: ConsoleLine[]; latestSeq: number } {
    const b = this.buffer(serverId);
    return { lines: b.lines.filter((l) => l.seq > sinceSeq), latestSeq: b.latestSeq };
  }

  forget(serverId: string): void {
    this.buffers.delete(serverId);
  }
}
