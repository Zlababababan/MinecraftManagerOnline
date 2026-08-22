/** Dédup des événements critiques d'agent (rejoués jusqu'à `event.ack`) — table `processed_events`. */
import { eq, lt } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import { processedEvents } from '../db/schema.js';

export class ProcessedEventsService {
  constructor(
    private readonly db: MmoDatabase,
    private readonly now: () => number,
  ) {}

  /** `true` si l'événement est nouveau (et le marque traité) ; `false` s'il a déjà été traité. */
  claim(eventId: string): boolean {
    const r = this.db
      .insert(processedEvents)
      .values({ eventId, ts: this.now() })
      .onConflictDoNothing()
      .run();
    return r.changes === 1;
  }

  has(eventId: string): boolean {
    return (
      this.db.select().from(processedEvents).where(eq(processedEvents.eventId, eventId)).get() !==
      undefined
    );
  }

  purgeOlderThan(ts: number): number {
    return this.db.delete(processedEvents).where(lt(processedEvents.ts, ts)).run().changes;
  }
}
