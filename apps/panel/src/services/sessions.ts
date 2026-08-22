/** Sessions cookie (doc 04 §1) : token aléatoire 256 bits, seul son SHA-256 est stocké. */
import { and, eq, gt, lt } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import { sessions, users, type UserRow } from '../db/schema.js';
import { generateSessionToken, sha256Hex } from '../util/crypto.js';

export interface ResolvedSession {
  user: UserRow;
  sessionId: number;
  expiresAt: number;
}

const TOUCH_INTERVAL_MS = 60_000;

export class SessionsService {
  constructor(
    private readonly db: MmoDatabase,
    private readonly now: () => number,
    private readonly ttlMs: number,
  ) {}

  create(userId: string, meta: { ip?: string | undefined; userAgent?: string | undefined }) {
    const token = generateSessionToken();
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    this.db
      .insert(sessions)
      .values({
        userId,
        tokenHash: sha256Hex(token),
        createdAt,
        expiresAt,
        lastSeenAt: createdAt,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      })
      .run();
    return { token, expiresAt };
  }

  /** Résout un token de cookie ; `undefined` si absent, expiré ou utilisateur inactif. */
  resolve(token: string | undefined): ResolvedSession | undefined {
    if (token === undefined || token === '') return undefined;
    const t = this.now();
    const row = this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, t)))
      .get();
    if (row?.user.isActive !== 1) return undefined;
    if (row.session.lastSeenAt === null || t - row.session.lastSeenAt > TOUCH_INTERVAL_MS) {
      this.db.update(sessions).set({ lastSeenAt: t }).where(eq(sessions.id, row.session.id)).run();
    }
    return { user: row.user, sessionId: row.session.id, expiresAt: row.session.expiresAt };
  }

  revoke(token: string): void {
    this.db
      .delete(sessions)
      .where(eq(sessions.tokenHash, sha256Hex(token)))
      .run();
  }

  revokeAllForUser(userId: string): void {
    this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }

  purgeExpired(): number {
    return this.db.delete(sessions).where(lt(sessions.expiresAt, this.now())).run().changes;
  }
}
