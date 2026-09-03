/**
 * Droits par serveur et par machine (lot 8, doc 04 §1 — « partager avec des amis sans leur donner
 * tout le panel »).
 *
 * Modèle : un utilisateur **`scoped`** ne voit que les portées qui lui sont accordées —
 * `user_server_permissions` (un serveur, un rôle) et `user_machine_permissions` (une machine, un
 * rôle, qui couvre tous ses serveurs présents et futurs). Son `users.role` est le **plafond** des
 * rôles accordés (un opérateur limité à trois serveurs) et vaut tel quel hors de toute portée
 * (macros, actions groupées). Un utilisateur non `scoped` garde le comportement historique : son
 * rôle vaut sur tout le parc. Un administrateur n'est jamais `scoped`.
 *
 * Trois points de branchement seulement (doc 03 §6) : le hook d'auth pour les routes qui portent
 * un identifiant de serveur ou de machine (`roleOn`), l'abonnement à un canal console
 * (`canSubscribe`) et la diffusion du hub (`visibleMessage`, qui retaille aussi les échantillons
 * de métriques). Les listes (serveurs, machines, tasks, événements…) se filtrent par `visible*`.
 *
 * Réponse à un serveur hors portée : **404**, pas 403 — un compte limité ne doit pas pouvoir
 * énumérer ce qu'il ne voit pas.
 */
import {
  parseConsoleChannel,
  type GrantRole,
  type Role,
  type ServerMessage,
  type UserGrantsDto,
  type UserGrantsInput,
} from '@mmo/protocol/client';
import { eq } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import { userMachinePermissions, userServerPermissions, users } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { hasRole } from './users.js';

export type Scope = { kind: 'server'; id: string } | { kind: 'machine'; id: string };

/** Vue figée des droits d'un utilisateur, lue en base à la première demande puis mise en cache. */
export interface AccessSnapshot {
  readonly userId: string;
  readonly role: Role;
  readonly scoped: boolean;
  readonly servers: ReadonlyMap<string, GrantRole>;
  readonly machines: ReadonlyMap<string, GrantRole>;
}

export interface PermissionsDeps {
  db: MmoDatabase;
  now: () => number;
  /** Machine d'un serveur (une machine accordée couvre ses serveurs) ; `undefined` = inconnu. */
  machineOf: (serverId: string) => string | undefined;
  machineExists: (machineId: string) => boolean;
}

/** Portée d'une route : `/api/servers/:id…` ou `/api/machines/:id…` (paramètre `id` normalisé partout). */
export function routeScope(routeUrl: string, params: unknown): Scope | undefined {
  const id =
    typeof params === 'object' && params !== null && 'id' in params ? params.id : undefined;
  if (typeof id !== 'string' || id === '') return undefined;
  if (routeUrl.startsWith('/api/servers/:id')) return { kind: 'server', id };
  if (routeUrl.startsWith('/api/machines/:id')) return { kind: 'machine', id };
  return undefined;
}

function validation(message: string, reason: string, key: string): AppError {
  return new AppError('E_VALIDATION', message, { details: { key, reason } });
}

/** Le rôle accordé ne dépasse jamais le plafond (`users.role`), même si la base dit autre chose. */
function capped(ceiling: Role, granted: GrantRole): GrantRole {
  if (hasRole(ceiling, granted)) return granted;
  return 'viewer';
}

const NOBODY: AccessSnapshot = {
  userId: '',
  role: 'viewer',
  scoped: true,
  servers: new Map(),
  machines: new Map(),
};

export class PermissionsService {
  private readonly cache = new Map<string, AccessSnapshot>();

  constructor(private readonly deps: PermissionsDeps) {}

  // --- Lecture ---------------------------------------------------------------------------------

  snapshot(userId: string): AccessSnapshot {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const row = this.deps.db
      .select({ id: users.id, role: users.role, scoped: users.scoped })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!row) return NOBODY;
    const built: AccessSnapshot = {
      userId,
      role: row.role,
      scoped: row.scoped === 1 && row.role !== 'admin',
      servers: new Map(
        this.deps.db
          .select()
          .from(userServerPermissions)
          .where(eq(userServerPermissions.userId, userId))
          .all()
          .map((g) => [
            g.serverId,
            capped(row.role, g.role === 'operator' ? 'operator' : 'viewer'),
          ]),
      ),
      machines: new Map(
        this.deps.db
          .select()
          .from(userMachinePermissions)
          .where(eq(userMachinePermissions.userId, userId))
          .all()
          .map((g) => [
            g.machineId,
            capped(row.role, g.role === 'operator' ? 'operator' : 'viewer'),
          ]),
      ),
    };
    this.cache.set(userId, built);
    return built;
  }

  /**
   * Vue plafonnée au rôle porté par la requête : identique à `snapshot` pour une session ; par une
   * clé d'API, `user.role` est le plus faible des deux rôles et les portées accordées redescendent
   * avec lui (une clé `viewer` d'un opérateur limité ne fait que lire ses serveurs).
   */
  snapshotFor(user: { id: string; role: Role }): AccessSnapshot {
    const base = this.snapshot(user.id);
    if (base.userId === '' || hasRole(user.role, base.role)) return base;
    const cap = (m: ReadonlyMap<string, GrantRole>): ReadonlyMap<string, GrantRole> =>
      new Map([...m].map(([id, r]) => [id, capped(user.role, r)]));
    return { ...base, role: user.role, servers: cap(base.servers), machines: cap(base.machines) };
  }

  /** À appeler après tout changement de rôle, de `scoped` ou de portées ; `undefined` = tous. */
  invalidate(userId?: string): void {
    if (userId === undefined) this.cache.clear();
    else this.cache.delete(userId);
  }

  grantsOf(userId: string): UserGrantsDto {
    return {
      servers: this.deps.db
        .select()
        .from(userServerPermissions)
        .where(eq(userServerPermissions.userId, userId))
        .all()
        .map((g) => ({
          serverId: g.serverId,
          role: g.role === 'operator' ? 'operator' : 'viewer',
        })),
      machines: this.deps.db
        .select()
        .from(userMachinePermissions)
        .where(eq(userMachinePermissions.userId, userId))
        .all()
        .map((g) => ({
          machineId: g.machineId,
          role: g.role === 'operator' ? 'operator' : 'viewer',
        })),
    };
  }

  // --- Décision --------------------------------------------------------------------------------

  /** Rôle effectif sur une portée ; `null` = invisible (répondre 404). */
  roleOn(snapshot: AccessSnapshot, scope: Scope): Role | null {
    if (!snapshot.scoped) return snapshot.role;
    if (scope.kind === 'server') {
      const direct = snapshot.servers.get(scope.id);
      if (direct !== undefined) return direct;
      if (snapshot.machines.size === 0) return null;
      const machineId = this.deps.machineOf(scope.id);
      if (machineId === undefined) return null;
      return snapshot.machines.get(machineId) ?? null;
    }
    const direct = snapshot.machines.get(scope.id);
    if (direct !== undefined) return direct;
    // Un serveur accordé rend sa machine lisible (page machine, métriques, heartbeat).
    for (const serverId of snapshot.servers.keys()) {
      if (this.deps.machineOf(serverId) === scope.id) return 'viewer';
    }
    return null;
  }

  can(snapshot: AccessSnapshot, scope: Scope, required: Role): boolean {
    const role = this.roleOn(snapshot, scope);
    return role !== null && hasRole(role, required);
  }

  /**
   * Portée d'un objet qui porte `serverId` et/ou `machineId` (événement, task) : le serveur prime,
   * une task de machine (Java, mise à jour d'agent) suit la machine, et ce qui n'a ni l'un ni
   * l'autre (panel, webhooks, comptes) reste invisible à un compte limité.
   */
  visibleRef(
    snapshot: AccessSnapshot,
    ref: { serverId?: string | null | undefined; machineId?: string | null | undefined },
  ): boolean {
    if (!snapshot.scoped) return true;
    if (typeof ref.serverId === 'string') {
      return this.roleOn(snapshot, { kind: 'server', id: ref.serverId }) !== null;
    }
    if (typeof ref.machineId === 'string') {
      return this.roleOn(snapshot, { kind: 'machine', id: ref.machineId }) !== null;
    }
    return false;
  }

  /** Canal navigateur : la console d'un serveur exige de le voir. Canal inconnu : au hub de décider. */
  canSubscribe(snapshot: AccessSnapshot, channel: string): boolean {
    const serverId = parseConsoleChannel(channel);
    if (serverId === undefined) return true;
    return this.roleOn(snapshot, { kind: 'server', id: serverId }) !== null;
  }

  /**
   * Message du hub tel qu'un utilisateur a le droit de le recevoir : le message lui-même, une
   * copie retaillée (échantillon de métriques limité à ses serveurs), ou `undefined` (rien).
   */
  visibleMessage(snapshot: AccessSnapshot, message: ServerMessage): ServerMessage | undefined {
    if (!snapshot.scoped) return message;
    switch (message.type) {
      // Les canaux console sont filtrés à l'abonnement, le reste ne porte aucune portée.
      case 'hello':
      case 'pong':
      case 'error':
      case 'console.snapshot':
      case 'console.lines':
        return message;
      case 'event':
        return this.visibleRef(snapshot, message.event) ? message : undefined;
      case 'server.state':
        return this.roleOn(snapshot, { kind: 'server', id: message.server.id }) === null
          ? undefined
          : message;
      case 'machine.heartbeat':
        return this.roleOn(snapshot, { kind: 'machine', id: message.machineId }) === null
          ? undefined
          : message;
      case 'metrics.sample': {
        if (this.roleOn(snapshot, { kind: 'machine', id: message.machineId }) === null) {
          return undefined;
        }
        // Machine accordée en entier : tout l'échantillon. Sinon, seuls ses serveurs — un
        // compte limité à un serveur ne doit pas lire le TPS des autres serveurs de la machine.
        if (snapshot.machines.has(message.machineId)) return message;
        return {
          ...message,
          sample: {
            ...message.sample,
            servers: message.sample.servers.filter(
              (s) => this.roleOn(snapshot, { kind: 'server', id: s.serverId }) !== null,
            ),
          },
        };
      }
      case 'task.update':
        return this.visibleRef(snapshot, message.task) ? message : undefined;
      case 'backup.update':
        return this.visibleRef(snapshot, message.backup) ? message : undefined;
      case 'migration.update': {
        const m = message.migration;
        const visible =
          this.roleOn(snapshot, { kind: 'server', id: m.serverId }) !== null ||
          (m.targetServerId !== null &&
            this.roleOn(snapshot, { kind: 'server', id: m.targetServerId }) !== null);
        return visible ? message : undefined;
      }
    }
  }

  // --- Écriture --------------------------------------------------------------------------------

  /**
   * Remplace les portées d'un utilisateur. Refus : administrateur (`ADMIN_SCOPED`), rôle accordé
   * au-dessus de `users.role` (`GRANT_ABOVE_ROLE`), serveur ou machine inconnus (404).
   */
  setGrants(
    userId: string,
    input: UserGrantsInput,
    serverExists: (serverId: string) => boolean,
  ): UserGrantsDto {
    const row = this.deps.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!row) throw notFound('user', userId);
    if (row.role === 'admin') {
      throw validation('an administrator sees everything', 'ADMIN_SCOPED', 'role');
    }
    const servers = new Map<string, GrantRole>();
    for (const g of input.servers ?? []) {
      if (!serverExists(g.serverId)) throw notFound('server', g.serverId);
      if (!hasRole(row.role, g.role)) {
        throw validation(`grant ${g.role} exceeds role ${row.role}`, 'GRANT_ABOVE_ROLE', 'role');
      }
      servers.set(g.serverId, g.role);
    }
    const machines = new Map<string, GrantRole>();
    for (const g of input.machines ?? []) {
      if (!this.deps.machineExists(g.machineId)) throw notFound('machine', g.machineId);
      if (!hasRole(row.role, g.role)) {
        throw validation(`grant ${g.role} exceeds role ${row.role}`, 'GRANT_ABOVE_ROLE', 'role');
      }
      machines.set(g.machineId, g.role);
    }
    const now = this.deps.now();
    this.deps.db.transaction((tx) => {
      tx.delete(userServerPermissions).where(eq(userServerPermissions.userId, userId)).run();
      tx.delete(userMachinePermissions).where(eq(userMachinePermissions.userId, userId)).run();
      for (const [serverId, role] of servers) {
        tx.insert(userServerPermissions).values({ userId, serverId, role, createdAt: now }).run();
      }
      for (const [machineId, role] of machines) {
        tx.insert(userMachinePermissions).values({ userId, machineId, role, createdAt: now }).run();
      }
    });
    this.invalidate(userId);
    return this.grantsOf(userId);
  }

  /** Rôle abaissé : les portées accordées au-dessus redescendent (un opérateur devenu lecteur). */
  clampToRole(userId: string, role: Role): void {
    if (role !== 'viewer') return;
    this.deps.db
      .update(userServerPermissions)
      .set({ role: 'viewer' })
      .where(eq(userServerPermissions.userId, userId))
      .run();
    this.deps.db
      .update(userMachinePermissions)
      .set({ role: 'viewer' })
      .where(eq(userMachinePermissions.userId, userId))
      .run();
    this.invalidate(userId);
  }
}
