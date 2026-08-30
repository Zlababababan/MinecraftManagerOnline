/**
 * Parcours UI (doc 04 §7) : clics/navigations envoyés par lots par le front → `metrics.db`
 * (`ui_events`). Diagnostic et maintenance uniquement : lecture réservée aux admins, purge par
 * rétention (`retention.uiEventsDays`, défaut 14 j) dans `runMaintenance`.
 */

import type { UiEventDto, UiEventInput } from '@mmo/protocol/client';

import type { SqliteHandle } from '../db/sqlite.js';

export interface UiEventUser {
  userId: string | null;
  username: string | null;
}

export class UiEventsService {
  private readonly insert;
  private readonly insertBatch: (user: UiEventUser, events: UiEventInput[]) => void;

  constructor(private readonly sqlite: SqliteHandle) {
    this.insert = sqlite.prepare(
      `INSERT INTO ui_events (ts, user_id, username, kind, page, target)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.insertBatch = sqlite.transaction((user: UiEventUser, events: UiEventInput[]) => {
      for (const e of events) {
        this.insert.run(e.ts, user.userId, user.username, e.kind, e.page, e.target ?? null);
      }
    });
  }

  record(user: UiEventUser, events: UiEventInput[]): void {
    this.insertBatch(user, events);
  }

  list(limit = 200): UiEventDto[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, ts, user_id, username, kind, page, target
         FROM ui_events ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      ts: number;
      user_id: string | null;
      username: string | null;
      kind: string;
      page: string;
      target: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      userId: r.user_id,
      username: r.username,
      kind: r.kind as UiEventDto['kind'],
      page: r.page,
      ...(r.target === null ? {} : { target: r.target }),
    }));
  }

  purgeOlderThan(ts: number): number {
    return this.sqlite.prepare('DELETE FROM ui_events WHERE ts < ?').run(ts).changes;
  }
}
