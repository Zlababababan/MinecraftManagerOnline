/**
 * Droits par serveur et par machine (lot 8) — miroir front de `services/permissions.ts` du panel.
 *
 * Un compte non limité (`user.scoped === false`) a son rôle partout : c'est le cas historique. Un
 * compte limité reçoit ses portées avec `/api/auth/me` (`grants`) : un serveur accordé porte son
 * rôle, une machine accordée couvre tous ses serveurs, et un serveur accordé rend sa machine
 * lisible. Le panel reste l'autorité (404 hors portée, 403 sous le rôle) — ces helpers ne servent
 * qu'à montrer ou cacher les boutons.
 */
import type { Role, UserDto, UserGrantsDto } from '@mmo/protocol/client';

import { hasRole } from './format.js';

export interface MeAccess {
  user: UserDto;
  /** `null` ou absent : le rôle vaut partout. */
  grants?: UserGrantsDto | null | undefined;
}

/** Ce qu'il faut d'un serveur pour décider : son id et sa machine (un `ServerDto` convient). */
export interface ServerRef {
  id: string;
  machineId: string;
}

/** Rôle effectif sur un serveur ; `null` = invisible. */
export function serverRole(me: MeAccess | undefined, server: ServerRef): Role | null {
  if (me === undefined) return null;
  if (!me.user.scoped) return me.user.role;
  const grants = me.grants ?? { servers: [], machines: [] };
  const direct = grants.servers.find((g) => g.serverId === server.id);
  if (direct !== undefined) return cap(me.user.role, direct.role);
  const machine = grants.machines.find((g) => g.machineId === server.machineId);
  if (machine !== undefined) return cap(me.user.role, machine.role);
  return null;
}

/** Rôle effectif sur une machine ; `null` = invisible. */
export function machineRole(me: MeAccess | undefined, machineId: string): Role | null {
  if (me === undefined) return null;
  if (!me.user.scoped) return me.user.role;
  const grants = me.grants ?? { servers: [], machines: [] };
  const direct = grants.machines.find((g) => g.machineId === machineId);
  if (direct !== undefined) return cap(me.user.role, direct.role);
  // La liste des machines reçue du panel ne contient déjà que les siennes : une machine qui
  // s'affiche sans être accordée porte un serveur accordé, donc se lit.
  return 'viewer';
}

export function canServer(me: MeAccess | undefined, server: ServerRef, required: Role): boolean {
  const role = serverRole(me, server);
  return role !== null && hasRole(role, required);
}

export function canMachine(me: MeAccess | undefined, machineId: string, required: Role): boolean {
  const role = machineRole(me, machineId);
  return role !== null && hasRole(role, required);
}

/** Une task suit son serveur, sinon sa machine, sinon le rôle global. */
export function canTask(
  me: MeAccess | undefined,
  task: { serverId: string | null; machineId: string | null },
  required: Role,
): boolean {
  if (me === undefined) return false;
  if (task.serverId !== null) {
    return canServer(me, { id: task.serverId, machineId: task.machineId ?? '' }, required);
  }
  if (task.machineId !== null) return canMachine(me, task.machineId, required);
  return hasRole(me.user.role, required);
}

function cap(ceiling: Role, granted: Role): Role {
  return hasRole(ceiling, granted) ? granted : 'viewer';
}
