/**
 * Clés d'API (lot 8, doc 04 §1) — le modèle des sessions, copié intégralement : jeton aléatoire de
 * 256 bits montré UNE fois à la création, seul son SHA-256 en base, résolution par égalité du
 * hachage puis comparaison à temps constant. Différences : la clé porte un **rôle** (jamais
 * au-dessus de celui du propriétaire, ni à la création ni à la résolution — une clé ne peut jamais
 * élever un compte), une **expiration** facultative, et un **préfixe** visible (`mmo_xxxxxxxx`)
 * pour la reconnaître à l'écran. Une clé d'un compte limité hérite de ses portées : c'est le hook
 * d'auth qui juge, avec le rôle de la clé pour plafond (`PermissionsService.snapshotFor`).
 */
import { randomBytes } from 'node:crypto';

import { ulid } from '@mmo/protocol';
import {
  API_KEY_PREFIX,
  MAX_API_KEYS_PER_USER,
  type ApiKeyCreateInput,
  type ApiKeyDto,
  type Role,
} from '@mmo/protocol/client';
import { and, asc, count, eq, isNotNull, lt } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import { apiKeys, users, type ApiKeyRow, type UserRow } from '../db/schema.js';
import { AppError } from '../errors.js';
import { safeEqualHex, sha256Hex } from '../util/crypto.js';
import { hasRole } from './users.js';

/** Longueur de la partie aléatoire : 32 octets en base64url. */
const TOKEN_BODY_LENGTH = 43;
/** Caractères du jeton gardés en clair pour l'affichage (après le préfixe `mmo_`). */
const VISIBLE_CHARS = 8;
const TOUCH_INTERVAL_MS = 60_000;
/** Une clé expirée reste listée (badge « expirée ») puis disparaît après ce délai. */
export const EXPIRED_KEY_GRACE_MS = 30 * 24 * 3_600_000;

export interface ResolvedApiKey {
  /** Le propriétaire, avec pour `role` le plus faible entre le sien et celui de la clé. */
  user: UserRow;
  key: ApiKeyRow;
}

export function generateApiKeyToken(): string {
  return API_KEY_PREFIX + randomBytes(32).toString('base64url');
}

/** `mmo_` + les premiers caractères : ce qui s'affiche dans les listes et le journal d'accès. */
export function apiKeyPrefixOf(token: string): string {
  return token.slice(0, API_KEY_PREFIX.length + VISIBLE_CHARS);
}

/** Forme attendue d'un jeton : évite un hachage (et une requête) sur n'importe quel `Bearer`. */
export function looksLikeApiKey(token: string): boolean {
  return (
    token.startsWith(API_KEY_PREFIX) &&
    token.length === API_KEY_PREFIX.length + TOKEN_BODY_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(token.slice(API_KEY_PREFIX.length))
  );
}

/** Le plus faible des deux rôles. */
export function weakerRole(a: Role, b: Role): Role {
  return hasRole(a, b) ? b : a;
}

function toDto(row: ApiKeyRow, username: string): ApiKeyDto {
  return {
    id: row.id,
    userId: row.userId,
    username,
    name: row.name,
    prefix: row.prefix,
    role: row.role,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
  };
}

export class ApiKeysService {
  constructor(
    private readonly db: MmoDatabase,
    private readonly now: () => number,
  ) {}

  listOf(userId: string): ApiKeyDto[] {
    return this.db
      .select({ key: apiKeys, username: users.username })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(eq(apiKeys.userId, userId))
      .orderBy(asc(apiKeys.createdAt))
      .all()
      .map((r) => toDto(r.key, r.username));
  }

  listAll(): ApiKeyDto[] {
    return this.db
      .select({ key: apiKeys, username: users.username })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .orderBy(asc(users.username), asc(apiKeys.createdAt))
      .all()
      .map((r) => toDto(r.key, r.username));
  }

  get(id: string): ApiKeyRow | undefined {
    return this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  }

  /**
   * Crée une clé pour `owner`. Le rôle demandé ne dépasse jamais le sien (`KEY_ABOVE_ROLE`) ;
   * défaut `viewer` (moindre privilège). Le jeton n'est rendu qu'ici, jamais relu.
   */
  create(owner: UserRow, input: ApiKeyCreateInput): { key: ApiKeyDto; token: string } {
    const role = input.role ?? 'viewer';
    if (!hasRole(owner.role, role)) {
      throw new AppError('E_VALIDATION', `key role ${role} exceeds owner role ${owner.role}`, {
        details: { key: 'role', reason: 'KEY_ABOVE_ROLE' },
      });
    }
    const existing =
      this.db.select({ n: count() }).from(apiKeys).where(eq(apiKeys.userId, owner.id)).get()?.n ??
      0;
    if (existing >= MAX_API_KEYS_PER_USER) {
      throw new AppError('E_VALIDATION', 'too many API keys for this account', {
        details: { key: 'name', reason: 'TOO_MANY_KEYS', max: MAX_API_KEYS_PER_USER },
      });
    }
    const token = generateApiKeyToken();
    const createdAt = this.now();
    const row: ApiKeyRow = {
      id: ulid(createdAt),
      userId: owner.id,
      name: input.name,
      prefix: apiKeyPrefixOf(token),
      tokenHash: sha256Hex(token),
      role,
      createdAt,
      expiresAt:
        input.expiresInDays === undefined ? null : createdAt + input.expiresInDays * 86_400_000,
      lastUsedAt: null,
      lastUsedIp: null,
    };
    this.db.insert(apiKeys).values(row).run();
    return { key: toDto(row, owner.username), token };
  }

  /**
   * Résout un jeton `Bearer` ; `undefined` si mal formé, inconnu, expiré ou propriétaire inactif.
   * Le rôle rendu est le plus faible entre celui de la clé et celui du propriétaire AUJOURD'HUI
   * (un compte rétrogradé après la création ne garde pas ses anciens droits par sa clé).
   */
  resolve(token: string, ip: string | undefined): ResolvedApiKey | undefined {
    if (!looksLikeApiKey(token)) return undefined;
    const hash = sha256Hex(token);
    const row = this.db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(eq(apiKeys.tokenHash, hash))
      .get();
    if (!row || !safeEqualHex(row.key.tokenHash, hash)) return undefined;
    const t = this.now();
    if (row.key.expiresAt !== null && row.key.expiresAt <= t) return undefined;
    if (row.user.isActive !== 1) return undefined;
    if (row.key.lastUsedAt === null || t - row.key.lastUsedAt > TOUCH_INTERVAL_MS) {
      this.db
        .update(apiKeys)
        .set({ lastUsedAt: t, lastUsedIp: ip ?? null })
        .where(eq(apiKeys.id, row.key.id))
        .run();
    }
    return {
      user: { ...row.user, role: weakerRole(row.key.role, row.user.role) },
      key: row.key,
    };
  }

  revoke(id: string): void {
    this.db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  }

  /** Rôle du propriétaire abaissé : ses clés au-dessus redescendent en base (l'écran dit vrai). */
  clampToRole(userId: string, role: Role): void {
    if (role === 'admin') return;
    const rows = this.db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).all();
    for (const row of rows) {
      if (hasRole(role, row.role)) continue;
      this.db.update(apiKeys).set({ role }).where(eq(apiKeys.id, row.id)).run();
    }
  }

  /** Maintenance : les clés expirées depuis plus de `EXPIRED_KEY_GRACE_MS` sont supprimées. */
  purgeExpired(): number {
    return this.db
      .delete(apiKeys)
      .where(
        and(isNotNull(apiKeys.expiresAt), lt(apiKeys.expiresAt, this.now() - EXPIRED_KEY_GRACE_MS)),
      )
      .run().changes;
  }
}
