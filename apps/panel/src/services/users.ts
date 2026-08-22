/** Utilisateurs (doc 04 §1) et RBAC admin > operator > viewer. */
import { ulid } from '@mmo/protocol';
import type { Role, UserDto } from '@mmo/protocol/client';
import { asc, count, eq } from 'drizzle-orm';

import { hashPassword, verifyPassword } from '../auth/password.js';
import type { MmoDatabase } from '../db/client.js';
import { users, type UserRow } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';

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
  };
}

export interface CreateUserInput {
  username: string;
  password: string;
  role?: Role | undefined;
  locale?: 'fr' | 'en' | undefined;
}

export interface UpdateUserInput {
  role?: Role | undefined;
  locale?: 'fr' | 'en' | undefined;
  theme?: string | undefined;
  isActive?: boolean | undefined;
  password?: string | undefined;
}

export class UsersService {
  constructor(
    private readonly db: MmoDatabase,
    private readonly now: () => number,
  ) {}

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
    const row: UserRow = {
      id: ulid(this.now()),
      username: input.username,
      passwordHash: await hashPassword(input.password),
      role: input.role ?? 'viewer',
      locale: input.locale ?? 'fr',
      theme: 'dark',
      isActive: 1,
      createdAt: this.now(),
      lastLoginAt: null,
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
    const patch: Partial<UserRow> = {};
    if (input.role !== undefined) patch.role = input.role;
    if (input.locale !== undefined) patch.locale = input.locale;
    if (input.theme !== undefined) patch.theme = input.theme;
    if (input.isActive !== undefined) patch.isActive = input.isActive ? 1 : 0;
    if (input.password !== undefined) patch.passwordHash = await hashPassword(input.password);
    if (Object.keys(patch).length > 0)
      this.db.update(users).set(patch).where(eq(users.id, id)).run();
    return this.require(id);
  }

  delete(id: string): void {
    const current = this.require(id);
    if (current.role === 'admin' && current.isActive === 1 && this.activeAdminCount() <= 1) {
      throw conflict('cannot delete the last active admin', { userId: id });
    }
    this.db.delete(users).where(eq(users.id, id)).run();
  }

  /** Vérifie le mot de passe ; `undefined` si inconnu, inactif ou mauvais mot de passe. */
  async authenticate(username: string, password: string): Promise<UserRow | undefined> {
    const row = this.findByUsername(username);
    if (row?.isActive !== 1) return undefined;
    if (!(await verifyPassword(row.passwordHash, password))) return undefined;
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
