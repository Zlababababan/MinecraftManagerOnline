/**
 * Bus d'événements persistant (doc 04 §6) : insertion dans `events` puis diffusion aux abonnés
 * (hub clients, push futur). `rowid` = curseur de reprise des consommateurs.
 */
import type { EventDto } from '@mmo/protocol/client';
import { and, desc, eq, gt, lt, type SQL } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import { events } from '../db/schema.js';
import { parseJson, toJson } from '../util/json.js';

export type Severity = EventDto['severity'];

export interface PublishInput {
  type: string;
  severity?: Severity;
  machineId?: string | undefined;
  serverId?: string | undefined;
  userId?: string | undefined;
  payload?: unknown;
  /** Horodatage d'origine (événement d'agent rejoué) ; défaut = maintenant. */
  ts?: number;
}

export interface EventsQuery {
  sinceId?: number | undefined;
  serverId?: string | undefined;
  machineId?: string | undefined;
  type?: string | undefined;
  limit?: number | undefined;
}

export type EventListener = (event: EventDto) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  constructor(
    private readonly db: MmoDatabase,
    private readonly now: () => number,
  ) {}

  publish(input: PublishInput): EventDto {
    const row = {
      ts: input.ts ?? this.now(),
      type: input.type,
      severity: input.severity ?? 'info',
      machineId: input.machineId ?? null,
      serverId: input.serverId ?? null,
      userId: input.userId ?? null,
      payload: input.payload === undefined ? null : toJson(input.payload),
    };
    const result = this.db.insert(events).values(row).run();
    const event: EventDto = {
      id: Number(result.lastInsertRowid),
      ...row,
      payload: input.payload ?? null,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // un abonné défaillant n'empêche pas les autres
      }
    }
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(query: EventsQuery = {}): EventDto[] {
    const conditions: SQL[] = [];
    if (query.sinceId !== undefined) conditions.push(gt(events.id, query.sinceId));
    if (query.serverId !== undefined) conditions.push(eq(events.serverId, query.serverId));
    if (query.machineId !== undefined) conditions.push(eq(events.machineId, query.machineId));
    if (query.type !== undefined) conditions.push(eq(events.type, query.type));
    const rows = this.db
      .select()
      .from(events)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(events.id))
      .limit(Math.min(query.limit ?? 100, 1000))
      .all();
    return rows.map((r) => ({ ...r, payload: parseJson<unknown>(r.payload, null) }));
  }

  purgeOlderThan(ts: number): number {
    return this.db.delete(events).where(lt(events.ts, ts)).run().changes;
  }
}
