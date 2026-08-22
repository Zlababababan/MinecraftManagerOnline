/** Audit des actions humaines et système (doc 04 §6) ; `username` dénormalisé. */
import { desc, lt } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { parseJson, toJson } from '../util/json.js';

export interface AuditEntry {
  userId?: string | undefined;
  username?: string | undefined;
  action: string;
  targetType?: string | undefined;
  targetId?: string | undefined;
  targetLabel?: string | undefined;
  details?: unknown;
  ip?: string | undefined;
}

export class AuditService {
  constructor(
    private readonly db: MmoDatabase,
    private readonly now: () => number,
  ) {}

  record(entry: AuditEntry): void {
    this.db
      .insert(auditLog)
      .values({
        ts: this.now(),
        userId: entry.userId ?? null,
        username: entry.username ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        targetLabel: entry.targetLabel ?? null,
        details: entry.details === undefined ? null : toJson(entry.details),
        ip: entry.ip ?? null,
      })
      .run();
  }

  list(limit = 200) {
    return this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(limit)
      .all()
      .map((r) => ({ ...r, details: parseJson<unknown>(r.details, null) }));
  }

  purgeOlderThan(ts: number): number {
    return this.db.delete(auditLog).where(lt(auditLog.ts, ts)).run().changes;
  }
}
