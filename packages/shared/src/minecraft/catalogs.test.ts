import { describe, expect, it } from 'vitest';

import {
  CatalogFormatError,
  fabricServerJarName,
  fabricServerJarUrl,
  parseFabricGameVersions,
  parseFabricInstallers,
  parseFabricLoaders,
  parseMcVersionDetail,
  parseMcVersionManifest,
  pickStable,
} from './catalogs.js';

/** Extraits réels (2026-09-04), réduits aux champs que le code lit. */
const MANIFEST = {
  latest: { release: '26.2', snapshot: '26.3-pre-2' },
  versions: [
    {
      id: '26.3-pre-2',
      type: 'snapshot',
      url: 'https://piston-meta.mojang.com/v1/packages/168cea/26.3-pre-2.json',
      releaseTime: '2026-09-04T11:54:52+00:00',
    },
    {
      id: '1.20.1',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/19f5ae/1.20.1.json',
      releaseTime: '2023-06-12T13:25:51+00:00',
    },
    { id: 'sans url', type: 'release' },
    { id: 'type inconnu', type: 'experiment', url: 'https://example.invalid/x.json' },
  ],
};

const DETAIL_1_20_1 = {
  javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  downloads: {
    server: {
      sha1: '84194a2f286ef7c14ed7ce0090dba59902951553',
      size: 47_791_053,
      url: 'https://piston-data.mojang.com/v1/objects/84194a/server.jar',
    },
    client: { url: 'https://example.invalid/client.jar' },
  },
};

describe('catalogue vanilla (manifest Mojang)', () => {
  it('retient les versions exploitables et laisse tomber les autres', () => {
    const parsed = parseMcVersionManifest(MANIFEST);
    expect(parsed.latestRelease).toBe('26.2');
    expect(parsed.latestSnapshot).toBe('26.3-pre-2');
    // Ni l'entrée sans url, ni le type inconnu : deux versions sur quatre.
    expect(parsed.versions.map((v) => v.id)).toEqual(['26.3-pre-2', '1.20.1']);
    expect(parsed.versions[1]).toMatchObject({ type: 'release' });
    expect(parsed.versions[1]?.releasedAt).toBe(Date.parse('2023-06-12T13:25:51+00:00'));
  });

  it('un manifest sans aucune version exploitable est une panne du fournisseur', () => {
    expect(() => parseMcVersionManifest({ versions: [] })).toThrow(CatalogFormatError);
    expect(() => parseMcVersionManifest({ versions: [{ id: 'x' }] })).toThrow(/no_versions/);
    expect(() => parseMcVersionManifest({})).toThrow(/not_an_array/);
    expect(() => parseMcVersionManifest(null)).toThrow(/not_an_array/);
  });

  it('le détail donne le serveur, son empreinte, sa taille et le Java attendu', () => {
    expect(parseMcVersionDetail(DETAIL_1_20_1)).toEqual({
      url: 'https://piston-data.mojang.com/v1/objects/84194a/server.jar',
      sha1: '84194a2f286ef7c14ed7ce0090dba59902951553',
      size: 47_791_053,
      javaMajor: 17,
    });
  });

  it('une version sans serveur téléchargeable le dit, et une empreinte douteuse est refusée', () => {
    // Avant 1.2.5 : pas de `downloads.server` — version non installable, pas une panne.
    expect(() => parseMcVersionDetail({ downloads: { client: {} } })).toThrow(/no_server_download/);
    const badSha = {
      downloads: { server: { url: 'https://x.invalid/s.jar', sha1: 'court', size: 1 } },
    };
    expect(() => parseMcVersionDetail(badSha)).toThrow(/bad_sha1/);
    const badSize = {
      downloads: {
        server: {
          url: 'https://x.invalid/s.jar',
          sha1: '84194a2f286ef7c14ed7ce0090dba59902951553',
          size: 0,
        },
      },
    };
    expect(() => parseMcVersionDetail(badSize)).toThrow(/bad_size/);
  });

  it('le Java attendu reste facultatif (vieilles versions du manifest)', () => {
    const detail = {
      downloads: {
        server: {
          url: 'https://x.invalid/s.jar',
          sha1: '84194a2f286ef7c14ed7ce0090dba59902951553',
          size: 10,
        },
      },
    };
    expect(parseMcVersionDetail(detail).javaMajor).toBeUndefined();
  });
});

describe('catalogue Fabric (meta.fabricmc.net)', () => {
  it('lit les versions de jeu et d’installeur, stabilité comprise', () => {
    const games = parseFabricGameVersions([
      { version: '26.3-pre-2', stable: false },
      { version: '1.20.1', stable: true },
      { stable: true },
    ]);
    expect(games).toEqual([
      { version: '26.3-pre-2', stable: false },
      { version: '1.20.1', stable: true },
    ]);
    const installers = parseFabricInstallers([
      {
        url: 'https://maven.fabricmc.net/…/fabric-installer-1.1.2.jar',
        version: '1.1.2',
        stable: true,
      },
    ]);
    expect(installers).toEqual([{ version: '1.1.2', stable: true }]);
    expect(() => parseFabricInstallers([])).toThrow(/no_versions/);
  });

  it('lit les loaders et leur Java minimal', () => {
    const loaders = parseFabricLoaders([
      {
        loader: { version: '0.19.5', stable: true },
        intermediary: { version: '1.20.1' },
        launcherMeta: { min_java_version: 8 },
      },
      { loader: { version: '0.19.4', stable: false }, launcherMeta: {} },
      { intermediary: { version: '1.20.1' } },
    ]);
    expect(loaders).toEqual([
      { version: '0.19.5', stable: true, minJavaVersion: 8 },
      { version: '0.19.4', stable: false, minJavaVersion: undefined },
    ]);
  });

  it('une version de jeu que Fabric ne supporte pas rend une liste vide, pas une erreur', () => {
    expect(parseFabricLoaders([])).toEqual([]);
    // En revanche une réponse qui n'est pas une liste reste une panne.
    expect(() => parseFabricLoaders({ error: 'nope' })).toThrow(/not_an_array/);
  });

  it('le nom du lanceur porte le triplet que la détection sait relire', () => {
    // Ce motif est celui de `FABRIC_MC_LAUNCHER` (doc 06 §2) : le changer casserait la détection.
    expect(fabricServerJarName('1.20.1', '0.16.14', '1.0.1')).toBe(
      'fabric-server-mc.1.20.1-loader.0.16.14-launcher.1.0.1.jar',
    );
    expect(fabricServerJarUrl('1.20.1', '0.16.14', '1.0.1')).toBe(
      'https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.16.14/1.0.1/server/jar',
    );
  });

  it('choisit la première stable, à défaut la première tout court', () => {
    expect(pickStable([{ stable: false }, { stable: true }])).toEqual({ stable: true });
    expect(pickStable([{ stable: false }])).toEqual({ stable: false });
    // Le tableau vide est typé explicitement : sans cela, T se réduit à never.
    const none: { stable: boolean }[] = [];
    expect(pickStable(none)).toBeUndefined();
  });
});
