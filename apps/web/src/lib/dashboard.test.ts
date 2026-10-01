import { describe, expect, it } from 'vitest';

import type { MachineDto, ServerDto } from '@mmo/protocol/client';

import {
  DASHBOARD_RECENT_MAX,
  creatableMachines,
  dashboardSections,
  lastUsedAt,
} from './dashboard.js';

const server = (id: string, over: Partial<ServerDto> = {}): ServerDto =>
  ({
    id,
    name: id,
    machineId: 'm1',
    provisioning: 'ready',
    runState: 'stopped',
    startedAt: null,
    stoppedAt: null,
    createdAt: 1,
    ...over,
  }) as ServerDto;

const ids = (list: readonly ServerDto[]) => list.map((s) => s.id);

describe('dashboardSections', () => {
  it('en marche : tout ce qui n’est pas à l’arrêt, par nom', () => {
    const { active, recent } = dashboardSections([
      server('zeta', { runState: 'running' }),
      server('alpha', { runState: 'starting' }),
      server('mid', { runState: 'stopping' }),
      server('repos'),
    ]);
    expect(ids(active)).toEqual(['alpha', 'mid', 'zeta']);
    expect(ids(recent)).toEqual(['repos']);
  });

  it('à regarder : installation en cours ou ratée, migration, plantage — et nulle part ailleurs', () => {
    const { attention, active, recent } = dashboardSections([
      server('rate', { provisioning: 'install_failed' }),
      server('install', { provisioning: 'installing' }),
      server('migre', { provisioning: 'migrating', runState: 'running' }),
      server('plante', { runState: 'crashed' }),
      server('sain', { runState: 'running' }),
    ]);
    expect(ids(attention)).toEqual(['install', 'migre', 'plante', 'rate']);
    expect(ids(active)).toEqual(['sain']);
    expect(recent).toEqual([]);
  });

  it('récents : les derniers utilisés d’abord, un serveur tout juste créé compris, bornés', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      server(`vieux-${String(i)}`, { stoppedAt: 100 + i }),
    );
    const { recent } = dashboardSections([
      ...many,
      server('neuf', { createdAt: 5_000 }),
      server('joue-hier', { startedAt: 3_000, stoppedAt: 4_000 }),
    ]);
    expect(recent).toHaveLength(DASHBOARD_RECENT_MAX);
    expect(ids(recent).slice(0, 3)).toEqual(['neuf', 'joue-hier', 'vieux-9']);
    expect(lastUsedAt(server('x', { startedAt: 9, stoppedAt: 7, createdAt: 2 }))).toBe(9);
  });

  it('un serveur archivé n’apparaît dans aucune section', () => {
    const sections = dashboardSections([
      server('range', { provisioning: 'archived' }),
      server('range-2', { provisioning: 'archived', runState: 'crashed' }),
    ]);
    expect(sections).toEqual({
      favorites: [],
      runningCount: 0,
      active: [],
      attention: [],
      recent: [],
    });
  });
});

describe('creatableMachines', () => {
  const machine = (id: string, connected: boolean, dirs: number): MachineDto =>
    ({
      id,
      connected,
      watchedDirectories: Array.from({ length: dirs }, (_, i) => ({ id: `d${String(i)}` })),
    }) as MachineDto;

  it('seulement en ligne, avec un répertoire surveillé, et où l’on a le droit d’agir', () => {
    const machines = [
      machine('ok', true, 1),
      machine('hors-ligne', false, 1),
      machine('sans-dossier', true, 0),
      machine('interdit', true, 2),
    ];
    expect(creatableMachines(machines, (id) => id !== 'interdit').map((m) => m.id)).toEqual(['ok']);
  });
});

describe('favoris du tableau de bord', () => {
  it('sont en tête, quel que soit leur état, et ne sont répétés nulle part', () => {
    const sections = dashboardSections([
      server('fav-arret', { favorite: true }),
      server('fav-marche', { favorite: true, runState: 'running' }),
      server('fav-plante', { favorite: true, runState: 'crashed' }),
      server('marche', { runState: 'running' }),
      server('plante', { runState: 'crashed' }),
      server('repos'),
    ]);
    expect(ids(sections.favorites)).toEqual(['fav-arret', 'fav-marche', 'fav-plante']);
    expect(ids(sections.active)).toEqual(['marche']);
    expect(ids(sections.attention)).toEqual(['plante']);
    expect(ids(sections.recent)).toEqual(['repos']);
    // La tuile « en marche » compte aussi les favoris qui tournent.
    expect(sections.runningCount).toBe(2);
  });

  it('un favori archivé est rangé comme les autres ; sans favori, la section est vide', () => {
    expect(
      dashboardSections([server('vieux', { favorite: true, provisioning: 'archived' })]).favorites,
    ).toEqual([]);
    expect(dashboardSections([server('a'), server('b')]).favorites).toEqual([]);
  });
});
