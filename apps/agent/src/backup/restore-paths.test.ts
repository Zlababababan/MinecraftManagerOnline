/**
 * Lot 4 — restauration partielle, fonctions pures : résumé d'une liste tar pour `backup.browse`
 * (agrégats par dossier, plafonds), normalisation des chemins demandés (jail, réservés,
 * couverture), prédicat d'inclusion, allocation du dossier `restored-<date>`.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RESTORED_DIR } from '@mmo/shared';
import type { TarListEntry } from '@mmo/shared/node';

import { defaultExclude } from './archive.js';
import {
  allocateRestoredDir,
  includePredicate,
  normalizeRestorePaths,
  summarizeListing,
} from './backup-service.js';

const MTIME = 1_700_000_000_000;

function file(rel: string, size: number, mtimeMs = MTIME): TarListEntry {
  return { rel, kind: 'file', size, mtimeMs };
}
function dir(rel: string, mtimeMs = MTIME): TarListEntry {
  return { rel, kind: 'dir', size: 0, mtimeMs };
}

function thrown(fn: () => unknown): { code?: string; details?: Record<string, unknown> } {
  try {
    fn();
    return {};
  } catch (error) {
    return error as { code?: string; details?: Record<string, unknown> };
  }
}

describe('lot 4 — restauration partielle (fonctions pures)', () => {
  it('summarizeListing : agrégats par dossier, dossiers d’abord, parent absent synthétisé', () => {
    const out = summarizeListing([
      dir('world'),
      dir('world/region'),
      file('world/region/r.0.0.mca', 100),
      file('world/region/r.0.1.mca', 50),
      file('world/level.dat', 7),
      file('server.properties', 3),
      // `mods/` n'a pas d'entrée de dossier (archive étrangère) : synthétisé, avec ses agrégats.
      file('mods/a.jar', 20),
    ]);
    expect(out).toMatchObject({ totalFiles: 5, totalBytes: 180, truncated: false });
    expect(out.entries.map((e) => e.path)).toEqual([
      'mods',
      'world',
      'world/region',
      'mods/a.jar',
      'server.properties',
      'world/level.dat',
      'world/region/r.0.0.mca',
      'world/region/r.0.1.mca',
    ]);
    const byPath = new Map(out.entries.map((e) => [e.path, e]));
    expect(byPath.get('world')).toEqual({
      path: 'world',
      kind: 'dir',
      size: 157,
      files: 3,
      modifiedAt: MTIME,
    });
    expect(byPath.get('world/region')).toMatchObject({ size: 150, files: 2 });
    expect(byPath.get('mods')).toEqual({ path: 'mods', kind: 'dir', size: 20, files: 1 });
    expect(byPath.get('world/level.dat')).toEqual({
      path: 'world/level.dat',
      kind: 'file',
      size: 7,
      modifiedAt: MTIME,
    });
  });

  it('summarizeListing : plafond par dossier (le dossier le dit, ses agrégats restent exacts) et plafond global', () => {
    const entries = [
      dir('world/region'),
      ...Array.from({ length: 5 }, (_, i) => file(`world/region/r.${String(i)}.mca`, 10)),
      file('a.txt', 1),
    ];
    const out = summarizeListing(entries, { perDir: 2, maxEntries: 50 });
    expect(out.truncated).toBe(true);
    const byPath = new Map(out.entries.map((e) => [e.path, e]));
    expect(byPath.get('world/region')).toMatchObject({ size: 50, files: 5, truncated: true });
    expect(byPath.get('world')).toMatchObject({ size: 50, files: 5 });
    expect(byPath.get('world')?.truncated).toBeUndefined();
    expect(out.entries.filter((e) => e.path.startsWith('world/region/'))).toHaveLength(2);
    expect(out.totalFiles).toBe(6);
    // Plafond global : tous les dossiers passent, les fichiers de la fin tombent.
    const capped = summarizeListing(entries, { perDir: 100, maxEntries: 3 });
    expect(capped.truncated).toBe(true);
    expect(capped.entries.map((e) => e.path)).toEqual(['world', 'world/region', 'a.txt']);
  });

  it('normalizeRestorePaths : jail, dédoublonnage, couverture, chemins réservés', () => {
    const reserved = defaultExclude(['.mmo-server.json']);
    expect(
      normalizeRestorePaths(
        ['world/region', './world/', 'world', 'mods/a.jar', 'mods/a.jar'],
        reserved,
      ),
    ).toEqual(['mods/a.jar', 'world']);
    expect(thrown(() => normalizeRestorePaths(['../x'], reserved))).toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    for (const p of [
      'logs/latest.log',
      '.mmo-server.json',
      '.mmo-trash/x',
      'world/session.lock',
      'restored-20260902-101010/world',
      'a.tar.part',
    ]) {
      expect(thrown(() => normalizeRestorePaths([p], reserved))).toMatchObject({
        code: 'E_INVALID_PAYLOAD',
        details: { reason: 'RESERVED_PATH', path: p },
      });
    }
    // Un nom voisin n'est pas réservé.
    expect(normalizeRestorePaths(['restored-things/x', 'logs2'], reserved)).toEqual([
      'logs2',
      'restored-things/x',
    ]);
  });

  it('includePredicate : un chemin vaut lui-même et son contenu, jamais un voisin', () => {
    const include = includePredicate(['world', 'mods/a.jar']);
    expect(include('world', 'dir')).toBe(true);
    expect(include('world/region/r.0.0.mca', 'file')).toBe(true);
    expect(include('worldx', 'dir')).toBe(false);
    expect(include('mods/a.jar', 'file')).toBe(true);
    expect(include('mods/a.jar.bak', 'file')).toBe(false);
    expect(include('mods', 'dir')).toBe(false);
  });

  it('allocateRestoredDir : nom horodaté reconnu par le scanner, suffixe quand la seconde est prise', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mmo-restored-'));
    try {
      const now = Date.UTC(2026, 8, 2, 10, 15, 30);
      const first = await allocateRestoredDir(root, now);
      const second = await allocateRestoredDir(root, now);
      expect(first).toMatch(RESTORED_DIR);
      expect(second).toMatch(RESTORED_DIR);
      expect(second).toBe(`${first}-2`);
      expect((await readdir(root)).sort()).toEqual([first, second].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
