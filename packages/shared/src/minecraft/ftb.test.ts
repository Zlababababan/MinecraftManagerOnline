/**
 * Intégration FTB : lecture des réponses de l'API v1 (forme mesurée le 2026-09-28 sur FTB Evolution,
 * doc 06 §6quinquies — ces fixtures en sont des extraits réduits, pas des copies).
 */
import { describe, expect, it } from 'vitest';

import { CatalogFormatError } from './catalogs.js';
import { ftbSearchUrl, parseFtbPack, parseFtbPackIds, parseFtbVersion } from './ftb.js';

const targets = [
  { name: 'minecraft', version: '1.21.1', type: 'game' },
  { name: 'neoforge', version: '21.1.248', type: 'modloader' },
  { name: 'java', version: '21.0.4+7-LTS', type: 'runtime' },
];
const file = (over: Record<string, unknown>) => ({
  path: './mods',
  name: 'a.jar',
  url: 'https://files.feed-the-beast.com/blob/aa/a.jar',
  mirrors: [],
  sha1: 'A'.repeat(40),
  size: 10,
  clientonly: false,
  ...over,
});

describe('FTB', () => {
  it('recherche : seuls les packs FTB, jamais les identifiants CurseForge', () => {
    expect(
      parseFtbPackIds({ status: 'success', packs: [125, 'x', 0], curseforge: [317007] }),
    ).toEqual([125]);
    expect(() => parseFtbPackIds({ status: 'success' })).toThrow(CatalogFormatError);
    expect(ftbSearchUrl('stone block', 20)).toContain('/search/20?term=stone%20block');
  });

  it('pack : versions de la plus récente à la plus ancienne, chargeur et mémoire lus dans les cibles', () => {
    const pack = parseFtbPack({
      id: 125,
      name: 'FTB Evolution',
      synopsis: 'Tech et magie',
      versions: [
        {
          id: 100487,
          name: '1.43.1',
          type: 'release',
          released: 1_780_000_000,
          targets,
          specs: { minimum: 6144, recommended: 8092 },
        },
        { id: 100506, name: '1.44.0', type: 'release', released: 1_789_495_031, targets },
        {
          id: 7,
          name: 'sans chargeur',
          type: 'alpha',
          released: 1,
          targets: [{ name: 'minecraft', version: '1.7.10' }],
        },
      ],
    });
    expect(pack.versions.map((v) => v.name)).toEqual(['1.44.0', '1.43.1', 'sans chargeur']);
    expect(pack.versions[1]).toMatchObject({
      mcVersion: '1.21.1',
      loader: 'neoforge',
      loaderVersion: '21.1.248',
      ramRecommendedMb: 8092,
      releasedAt: 1_780_000_000_000,
    });
    expect(pack.versions[2]?.loader).toBeUndefined();
  });

  it('version : fichiers côté serveur seulement, chemins relatifs, empreintes en minuscules', () => {
    const v = parseFtbVersion(
      {
        id: 100487,
        name: '1.43.1',
        targets,
        files: [
          file({}),
          file({ path: './config/sub', name: 'c.toml', mirrors: ['https://m/1', 42] }),
          file({ name: 'iris.jar', clientonly: true }),
        ],
      },
      125,
    );
    expect(v.files.map((f) => f.path)).toEqual(['mods/a.jar', 'config/sub/c.toml']);
    expect(v.files[0]?.sha1).toBe('a'.repeat(40));
    expect(v.files[1]?.mirrors).toEqual(['https://m/1']);
    expect(v.clientOnly).toBe(1);
    expect(v.packId).toBe(125);
  });

  it('version : un chemin qui sort du dossier, un doublon ou un fichier incomplet rendent la réponse inexploitable', () => {
    const bad = (files: unknown[]) => () =>
      parseFtbVersion({ id: 1, name: 'x', targets, files }, 1);
    for (const path of ['../..', './mods/../..', '/etc', 'C:/Windows']) {
      expect(bad([file({ path })])).toThrow(/unsafe_path/);
    }
    expect(bad([file({ name: '..' })])).toThrow(/unsafe_path/);
    // Deux chemins qui ne diffèrent que par la casse s'écraseraient sous Windows.
    expect(bad([file({}), file({ name: 'A.jar' })])).toThrow(/duplicate_path/);
    expect(bad([file({ sha1: 'court' })])).toThrow(/incomplete_file/);
    expect(bad([file({ size: undefined })])).toThrow(/incomplete_file/);
    expect(() => parseFtbVersion({ id: 1, name: 'x', targets }, 1)).toThrow(/no_files/);
  });
});
