/**
 * Planificateur de sauvegardes de l'agent : ce que le panel apprend d'une occurrence qui n'a PAS
 * été exécutée. Les trois sorties de `tick()` étaient muettes — côté panel, un serveur arrêté sous
 * `onlyIfRunning` et une politique réellement cassée produisaient exactement la même chose :
 * rien. Une politique morte était donc indiscernable d'une politique saine.
 */
import type { BackupSchedule } from '@mmo/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '../log.js';
import { BackupScheduler, type BackupSchedulerOptions } from './scheduler.js';

type Skip = Parameters<NonNullable<BackupSchedulerOptions['onSkipped']>>[0];

/** Occurrence due : le cron « toutes les minutes » tombe forcément dans la dernière minute. */
const T = Date.UTC(2026, 7, 30, 12, 0, 0);

function schedule(over: Partial<BackupSchedule> = {}): BackupSchedule {
  return {
    id: 'pol_1',
    serverId: 'srv_1',
    cron: '* * * * *',
    enabled: true,
    onlyIfRunning: false,
    ...over,
  };
}

describe('BackupScheduler — occurrences non exécutées', () => {
  let skipped: Skip[];
  let started: string[];
  let runs: Record<string, number>;
  let running: boolean;
  let taskActive: boolean;
  let startThrows: Error | undefined;

  beforeEach(() => {
    skipped = [];
    started = [];
    runs = {};
    running = true;
    taskActive = false;
    startThrows = undefined;
  });

  function build(schedules: BackupSchedule[]): BackupScheduler {
    const state = { backupSchedules: schedules, backupScheduleRuns: runs };
    return new BackupScheduler({
      store: {
        get: () => state,
        getServer: () => ({ config: { path: '/srv' } }),
        update: (fn: (s: typeof state) => void) => {
          fn(state);
          return Promise.resolve();
        },
      } as unknown as BackupSchedulerOptions['store'],
      manager: {
        get: () => ({ isRunning: running }),
      } as unknown as BackupSchedulerOptions['manager'],
      backups: {
        create: () => Promise.resolve({}),
      } as unknown as BackupSchedulerOptions['backups'],
      tasks: {
        activeFor: () => taskActive,
        start: (req: { taskId: string }) => {
          if (startThrows) return Promise.reject(startThrows);
          started.push(req.taskId);
          return Promise.resolve();
        },
      } as unknown as BackupSchedulerOptions['tasks'],
      logger: new Logger('test', { stderr: false }),
      now: () => T,
      onSkipped: (s) => skipped.push(s),
    });
  }

  it('lance la sauvegarde et ne signale rien quand tout va bien', async () => {
    await build([schedule()]).tick();
    expect(started).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('serveur arrêté sous onlyIfRunning : occurrence signalée, pas exécutée', async () => {
    running = false;
    await build([schedule({ onlyIfRunning: true })]).tick();
    expect(started).toEqual([]);
    expect(skipped).toMatchObject([
      { policyId: 'pol_1', serverId: 'srv_1', reason: 'server_stopped' },
    ]);
    // L'occurrence est consommée : elle ne sera pas rejouée à la minute suivante.
    expect(runs.pol_1).toBeDefined();
  });

  it('autre sauvegarde en cours : occurrence signalée', async () => {
    taskActive = true;
    await build([schedule()]).tick();
    expect(started).toEqual([]);
    expect(skipped).toMatchObject([{ reason: 'task_running' }]);
  });

  it('expression cron invalide : signalée au panel, pas seulement journalisée en local', async () => {
    await build([schedule({ cron: 'pas du cron' })]).tick();
    expect(skipped).toMatchObject([{ reason: 'invalid_cron' }]);
    expect(skipped[0]?.detail).toBeTruthy();
  });

  // `markRun` consomme l'occurrence AVANT le démarrage : si `start` jette, elle est perdue sans
  // sauvegarde ni trace, et la politique paraît simplement muette ce jour-là.
  it('démarrage impossible : occurrence signalée au lieu de disparaître', async () => {
    startThrows = new Error('disque plein');
    await build([schedule()]).tick();
    expect(started).toEqual([]);
    expect(skipped).toMatchObject([{ reason: 'start_failed', detail: 'disque plein' }]);
  });

  it('planning désactivé : aucune occurrence, aucun signalement', async () => {
    await build([schedule({ enabled: false })]).tick();
    expect(started).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('une occurrence déjà exécutée n’est ni rejouée ni signalée', async () => {
    const s = build([schedule()]);
    await s.tick();
    expect(started).toHaveLength(1);
    await s.tick();
    expect(started).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('le signalement n’est jamais fatal', async () => {
    const boom = vi.fn(() => {
      throw new Error('panel injoignable');
    });
    const s = build([schedule({ onlyIfRunning: true })]);
    running = false;
    (s as unknown as { options: { onSkipped: () => void } }).options.onSkipped = boom;
    await expect(s.tick()).resolves.toBeDefined();
  });
});
