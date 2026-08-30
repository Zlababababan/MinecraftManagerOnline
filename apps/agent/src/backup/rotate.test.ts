/**
 * Règle de rotation des sauvegardes. Le cas décisif : un serveur qu'on n'a pas démarré depuis
 * longtemps ne doit pas se retrouver sans AUCUNE sauvegarde parce que les siennes ont dépassé
 * `keepDays` — aucune nouvelle n'est produite pour les remplacer.
 */
import { describe, expect, it } from 'vitest';

import { selectForRotation } from './backup-service.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** Du plus récent au plus ancien, comme `list()`. */
const archives = (agesInDays: number[]) =>
  agesInDays.map((days, i) => ({
    backupId: `bk_${String(i)}`,
    archivePath: `/backups/bk_${String(i)}.tar.gz`,
    createdAt: NOW - days * DAY,
  }));

const ids = (out: { backupId: string }[]) => out.map((d) => d.backupId);

describe('selectForRotation', () => {
  it('keep : garde les N plus récentes', () => {
    expect(ids(selectForRotation(archives([0, 1, 2, 3]), { keep: 2 }, NOW))).toEqual([
      'bk_2',
      'bk_3',
    ]);
  });

  it('keepDays : périme les plus anciennes', () => {
    expect(ids(selectForRotation(archives([1, 10, 20, 30]), { keepDays: 14 }, NOW))).toEqual([
      'bk_2',
      'bk_3',
    ]);
  });

  it('ne supprime jamais la dernière sauvegarde par l’âge seul', () => {
    // Toutes périmées : la plus récente survit quand même.
    expect(ids(selectForRotation(archives([20, 30, 40]), { keepDays: 14 }, NOW))).toEqual([
      'bk_1',
      'bk_2',
    ]);
    expect(ids(selectForRotation(archives([365]), { keepDays: 14 }, NOW))).toEqual([]);
  });

  it('keep explicite reste souverain (keep: 0 supprime tout)', () => {
    expect(ids(selectForRotation(archives([0, 1]), { keep: 0 }, NOW))).toEqual(['bk_0', 'bk_1']);
  });

  it('sans politique, rien n’est supprimé', () => {
    expect(selectForRotation(archives([0, 100]), {}, NOW)).toEqual([]);
  });
});
