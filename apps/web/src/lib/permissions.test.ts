/**
 * Lot 8 — rôle effectif côté front : un compte non limité garde son rôle partout ; un compte
 * limité ne voit que ses portées, une machine accordée couvre ses serveurs, un serveur accordé
 * rend sa machine lisible, et le rôle du compte plafonne ce qui est accordé.
 */
import { describe, expect, it } from 'vitest';

import type { UserDto } from '@mmo/protocol/client';

import { canMachine, canServer, canTask, machineRole, serverRole } from './permissions.js';

const base: UserDto = {
  id: 'u1',
  username: 'ami',
  role: 'operator',
  locale: 'fr',
  theme: 'dark',
  isActive: true,
  createdAt: 0,
  lastLoginAt: null,
  scoped: true,
};
const sA = { id: 's-a', machineId: 'm1' };
const sB = { id: 's-b', machineId: 'm1' };
const sC = { id: 's-c', machineId: 'm2' };

describe('permissions (web)', () => {
  it('un compte non limité a son rôle partout ; sans `me`, rien', () => {
    const me = { user: { ...base, scoped: false, role: 'viewer' as const }, grants: null };
    expect(serverRole(me, sA)).toBe('viewer');
    expect(machineRole(me, 'm9')).toBe('viewer');
    expect(canServer(me, sC, 'viewer')).toBe(true);
    expect(canServer(me, sC, 'operator')).toBe(false);
    expect(canServer(undefined, sA, 'viewer')).toBe(false);
    expect(canTask(undefined, { serverId: null, machineId: null }, 'viewer')).toBe(false);
  });

  it('compte limité : serveur accordé, machine accordée qui couvre ses serveurs, reste invisible', () => {
    const me = {
      user: base,
      grants: {
        servers: [{ serverId: 's-a', role: 'viewer' as const }],
        machines: [{ machineId: 'm2', role: 'operator' as const }],
      },
    };
    expect(serverRole(me, sA)).toBe('viewer');
    expect(canServer(me, sA, 'operator')).toBe(false);
    // s-c est couvert par sa machine m2, accordée en opérateur.
    expect(serverRole(me, sC)).toBe('operator');
    expect(canServer(me, sC, 'operator')).toBe(true);
    // s-b : même machine que s-a, mais ni accordé ni couvert.
    expect(serverRole(me, sB)).toBeNull();
    expect(canServer(me, sB, 'viewer')).toBe(false);
    // Machine m1 : lisible parce qu'elle porte s-a ; jamais opérable.
    expect(machineRole(me, 'm1')).toBe('viewer');
    expect(canMachine(me, 'm1', 'operator')).toBe(false);
    expect(canMachine(me, 'm2', 'operator')).toBe(true);
    // Tasks : serveur d'abord, machine sinon, rôle global si ni l'un ni l'autre.
    expect(canTask(me, { serverId: 's-c', machineId: 'm2' }, 'operator')).toBe(true);
    expect(canTask(me, { serverId: 's-b', machineId: 'm1' }, 'viewer')).toBe(false);
    expect(canTask(me, { serverId: null, machineId: 'm2' }, 'operator')).toBe(true);
    expect(canTask(me, { serverId: null, machineId: 'm1' }, 'operator')).toBe(false);
    expect(canTask(me, { serverId: null, machineId: null }, 'operator')).toBe(true);
  });

  it('le rôle du compte plafonne les portées : un lecteur reste lecteur', () => {
    const me = {
      user: { ...base, role: 'viewer' as const },
      grants: { servers: [{ serverId: 's-a', role: 'operator' as const }], machines: [] },
    };
    expect(serverRole(me, sA)).toBe('viewer');
    expect(canServer(me, sA, 'operator')).toBe(false);
  });

  it('compte limité sans portées reçues : rien de visible', () => {
    expect(serverRole({ user: base }, sA)).toBeNull();
    expect(serverRole({ user: base, grants: null }, sA)).toBeNull();
  });
});
