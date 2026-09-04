/** Utilisateurs (doc 04 §1) et RBAC admin > operator > viewer. */
import { ulid } from '@mmo/protocol';
import type { Role, UserDto } from '@mmo/protocol/client';
import { asc, count, eq } from 'drizzle-orm';

import { DEFAULT_LOCALE } from '@mmo/shared';

import { dummyPasswordHash, hashPassword, verifyPassword } from '../auth/password.js';
import type { MmoDatabase } from '../db/client.js';
import { users, type UserRow } from '../db/schema.js';
import { AppError, conflict, notFound } from '../errors.js';

export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 1, operator: 2, admin: 3 };

export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    locale: row.locale,
    theme: row.theme,
    isActive: row.isActive === 1,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    scoped: row.scoped === 1,
  };
}

export interface CreateUserInput {
  username: string;
  password: string;
  role?: Role | undefined;
  locale?: 'fr' | 'en' | undefined;
  /** Lot 8 : compte limité aux portées accordées. */
  scoped?: boolean | undefined;
}

export interface UpdateUserInput {
  role?: Role | undefined;
  locale?: 'fr' | 'en' | undefined;
  theme?: string | undefined;
  isActive?: boolean | undefined;
  password?: string | undefined;
  scoped?: boolean | undefined;
}

/** Un administrateur voit tout par définition : `scoped` n'a pas de sens pour lui. */
function assertNotScopedAdmin(role: Role, scoped: boolean): void {
  if (role === 'admin' && scoped) {
    throw new AppError('E_VALIDATION', 'an administrator cannot be limited to some servers', {
      details: { key: 'scoped', reason: 'ADMIN_SCOPED' },
    });
  }
}

export class UsersService {
  private readonly listeners = new Set<(userId: string) => void>();

  constructor(
    private readonly db: MmoDatabase,
    private readonly now: () => number,
  ) {}

  /** Appelé après toute modification ou suppression d'un compte (caches de droits, lot 8). */
  onChanged(listener: (userId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(userId: string): void {
    for (const listener of this.listeners) listener(userId);
  }

  count(): number {
    return this.db.select({ n: count() }).from(users).get()?.n ?? 0;
  }

  list(): UserRow[] {
    return this.db.select().from(users).orderBy(asc(users.createdAt)).all();
  }

  get(id: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  require(id: string): UserRow {
    const row = this.get(id);
    if (!row) throw notFound('user', id);
    return row;
  }

  /** Recherche insensible à la casse (`COLLATE NOCASE` sur la colonne). */
  findByUsername(username: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.username, username)).get();
  }

  async create(input: CreateUserInput): Promise<UserRow> {
    if (this.findByUsername(input.username)) {
      throw conflict(`username ${input.username} already exists`, { username: input.username });
    }
    const role = input.role ?? 'viewer';
    const scoped = input.scoped ?? false;
    assertNotScopedAdmin(role, scoped);
    const row: UserRow = {
      id: ulid(this.now()),
      username: input.username,
      passwordHash: await hashPassword(input.password),
      role,
      locale: input.locale ?? DEFAULT_LOCALE,
      theme: 'dark',
      isActive: 1,
      createdAt: this.now(),
      lastLoginAt: null,
      notificationsSeenId: 0,
      quietFrom: null,
      quietTo: null,
      scoped: scoped ? 1 : 0,
    };
    this.db.insert(users).values(row).run();
    return row;
  }

  async update(id: string, input: UpdateUserInput): Promise<UserRow> {
    const current = this.require(id);
    if (
      (input.role !== undefined && input.role !== 'admin') ||
      (input.isActive !== undefined && !input.isActive)
    ) {
      // Jamais sans administrateur actif.
      if (current.role === 'admin' && current.isActive === 1 && this.activeAdminCount() <= 1) {
        throw conflict('cannot demote or deactivate the last active admin', { userId: id });
      }
    }
    // L'état résultant est jugé, pas le champ modifié : passer admin un compte limité, ou limiter
    // un admin, échouent pareil.
    assertNotScopedAdmin(input.role ?? current.role, input.scoped ?? current.scoped === 1);
    const patch: Partial<UserRow> = {};
    if (input.role !== undefined) patch.role = input.role;
    if (input.locale !== undefined) patch.locale = input.locale;
    if (input.theme !== undefined) patch.theme = input.theme;
    if (input.isActive !== undefined) patch.isActive = input.isActive ? 1 : 0;
    if (input.password !== undefined) patch.passwordHash = await hashPassword(input.password);
    if (input.scoped !== undefined) patch.scoped = input.scoped ? 1 : 0;
    if (Object.keys(patch).length > 0) {
      this.db.update(users).set(patch).where(eq(users.id, id)).run();
      this.changed(id);
    }
    return this.require(id);
  }

  delete(id: string): void {
    const current = this.require(id);
    if (current.role === 'admin' && current.isActive === 1 && this.activeAdminCount() <= 1) {
      throw conflict('cannot delete the last active admin', { userId: id });
    }
    this.db.delete(users).where(eq(users.id, id)).run();
    this.changed(id);
  }

  /**
   * Vérifie le mot de passe ; `undefined` si inconnu, inactif ou mauvais mot de passe.
   * Les trois chemins d'échec coûtent le même temps : un utilisateur inconnu est vérifié contre
   * un hachage factice, sinon la réponse immédiate révélerait l'existence du compte (doc 03 §6).
   */
  async authenticate(username: string, password: string): Promise<UserRow | undefined> {
    const row = this.findByUsername(username);
    const ok = await verifyPassword(row?.passwordHash ?? (await dummyPasswordHash()), password);
    if (row?.isActive !== 1 || !ok) return undefined;
    this.db.update(users).set({ lastLoginAt: this.now() }).where(eq(users.id, row.id)).run();
    return row;
  }

  verifyPassword(row: UserRow, password: string): Promise<boolean> {
    return verifyPassword(row.passwordHash, password);
  }

  private activeAdminCount(): number {
    return this.list().filter((u) => u.role === 'admin' && u.isActive === 1).length;
  }
}
