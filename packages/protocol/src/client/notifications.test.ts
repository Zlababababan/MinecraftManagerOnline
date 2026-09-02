/**
 * Le catalogue des notifications a une propriété facile à casser en l'élargissant : une case à
 * cocher peut exister sans qu'aucun événement ne l'atteigne, ou l'inverse. Les deux se voient à
 * l'usage sous la forme « j'ai coché, je ne reçois rien » — indébogable pour l'utilisateur.
 */
import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_GROUPS,
  NOTIFICATION_TYPES,
  notificationTypeOf,
  type NotificationType,
} from './index.js';

/** Événements du bus, avec la charge minimale qui décide de la catégorie. */
const BUS_EVENTS: { type: string; severity: string; payload?: unknown }[] = [
  { type: 'server.stateChanged', severity: 'error', payload: { state: 'crashed' } },
  { type: 'server.stateChanged', severity: 'info', payload: { state: 'running' } },
  { type: 'server.stateChanged', severity: 'info', payload: { state: 'stopped' } },
  { type: 'server.startFailed', severity: 'error' },
  { type: 'watchdog.alert', severity: 'warning' },
  { type: 'alert.firing', severity: 'warning', payload: { rule: 'machine.offline' } },
  { type: 'alert.firing', severity: 'warning', payload: { rule: 'server.down' } },
  { type: 'alert.firing', severity: 'warning', payload: { rule: 'disk.low' } },
  { type: 'alert.firing', severity: 'warning', payload: { rule: 'tps.low' } },
  { type: 'alert.resolved', severity: 'info', payload: { rule: 'disk.low' } },
  { type: 'task.failed', severity: 'error', payload: { kind: 'backup.create' } },
  { type: 'task.failed', severity: 'error', payload: { kind: 'java.install' } },
  { type: 'task.completed', severity: 'info', payload: { kind: 'backup.create' } },
  { type: 'backup.overdue', severity: 'warning' },
  { type: 'backup.corrupted', severity: 'error' },
  { type: 'migration.done', severity: 'info' },
  { type: 'migration.failed', severity: 'error' },
  { type: 'agent.updateApplied', severity: 'info' },
  { type: 'agent.updateRolledBack', severity: 'error' },
  { type: 'schedule.run', severity: 'info' },
  { type: 'schedule.run', severity: 'warning' },
  { type: 'port.conflict', severity: 'warning' },
  { type: 'player.joined', severity: 'info' },
  { type: 'player.left', severity: 'info' },
  { type: 'player.action', severity: 'info' },
  { type: 'agent.log', severity: 'warning' },
  { type: 'machine.paired', severity: 'info' },
  { type: 'server.adopted', severity: 'info' },
  { type: 'server.removed', severity: 'warning' },
  { type: 'server.deleted', severity: 'info' },
  { type: 'server.migrated', severity: 'info' },
  { type: 'server.conflict', severity: 'warning' },
  { type: 'panel.updateAvailable', severity: 'info', payload: { version: '1.0.6' } },
];

describe('catalogue des notifications', () => {
  it('aucune case morte : chaque catégorie est atteignable par un événement réel', () => {
    const reached = new Set(BUS_EVENTS.map((e) => notificationTypeOf(e)).filter(Boolean));
    const dead = NOTIFICATION_TYPES.filter((type) => !reached.has(type));
    expect(dead, 'catégories qu’aucun événement ne produit').toEqual([]);
  });

  it('aucun événement muet : chaque événement notifiable du bus atteint une catégorie', () => {
    // La garde inverse de la précédente : sans elle, retirer un `case` de `notificationTypeOf`
    // laisse un événement publié mais jamais notifié, et aucun test ne le dit (vécu, lot 4).
    const silent = BUS_EVENTS.filter((e) => notificationTypeOf(e) === undefined).map(
      (e) => `${e.type}/${e.severity}`,
    );
    expect(silent, 'événements du bus sans catégorie').toEqual([]);
  });

  it('chaque catégorie a un défaut et apparaît dans exactement un groupe', () => {
    const grouped = NOTIFICATION_GROUPS.flatMap((g) => [...g.types]);
    expect([...grouped].sort()).toEqual([...NOTIFICATION_TYPES].sort());
    // Un doublon afficherait deux interrupteurs pour un même réglage.
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const type of NOTIFICATION_TYPES) {
      expect(typeof NOTIFICATION_DEFAULTS[type], type).toBe('boolean');
    }
  });

  it('les catégories bruyantes sont éteintes par défaut, les urgences allumées', () => {
    // Un premier scan sur un parc de cinquante serveurs en découvre cinquante d'un coup.
    const off: NotificationType[] = [
      'server.state',
      'server.discovered',
      'server.lifecycle',
      'task.done',
      'schedule.done',
      'player.activity',
      'player.action',
    ];
    for (const type of off) expect(NOTIFICATION_DEFAULTS[type], type).toBe(false);
    const on: NotificationType[] = [
      'server.crashed',
      'agent.offline',
      'agent.problem',
      'resource.disk',
      'resource.tps',
      'backup.failed',
    ];
    for (const type of on) expect(NOTIFICATION_DEFAULTS[type], type).toBe(true);
  });

  it('sépare le disque du TPS, et le succès de l’échec', () => {
    const of = (type: string, severity: string, payload?: unknown) =>
      notificationTypeOf({ type, severity, ...(payload === undefined ? {} : { payload }) });
    expect(of('alert.firing', 'warning', { rule: 'disk.low' })).toBe('resource.disk');
    expect(of('alert.firing', 'warning', { rule: 'tps.low' })).toBe('resource.tps');
    expect(of('task.completed', 'info', { kind: 'backup.create' })).toBe('task.done');
    expect(of('task.failed', 'error', { kind: 'backup.create' })).toBe('backup.failed');
    expect(of('backup.corrupted', 'error')).toBe('backup.failed');
    expect(of('schedule.run', 'info')).toBe('schedule.done');
    expect(of('schedule.run', 'warning')).toBe('schedule.failed');
  });

  it('un événement inconnu ne notifie rien (et n’invente pas de catégorie)', () => {
    expect(notificationTypeOf({ type: 'quelque.chose.de.neuf', severity: 'info' })).toBeUndefined();
    expect(notificationTypeOf({ type: 'machine.heartbeat', severity: 'info' })).toBeUndefined();
    // `server.stateChanged` vers un état intermédiaire ne réveille personne.
    expect(
      notificationTypeOf({
        type: 'server.stateChanged',
        severity: 'info',
        payload: { state: 'starting' },
      }),
    ).toBeUndefined();
  });
});
