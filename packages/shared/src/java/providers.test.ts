import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  javaCandidates,
  parseTemurinAssets,
  parseZuluDetail,
  parseZuluPackages,
  temurinMetadataUrl,
  zuluMetadataUrl,
} from './providers.js';

describe('fournisseurs Java (doc 03 §4)', () => {
  it('chaîne Temurin → Zulu, puis x64 émulé seulement sur ARM', () => {
    expect(javaCandidates(17, 'windows', 'x64').map((c) => `${c.vendor}:${c.arch}`)).toEqual([
      'temurin:x64',
      'zulu:x64',
    ]);
    const arm = javaCandidates(8, 'windows', 'arm64');
    expect(arm.map((c) => `${c.vendor}:${c.arch}:${String(c.emulated)}`)).toEqual([
      'temurin:arm64:false',
      'zulu:arm64:false',
      'temurin:x64:true',
      'zulu:x64:true',
    ]);
  });

  it('URLs de métadonnées', () => {
    expect(temurinMetadataUrl(21, 'macos', 'arm64')).toBe(
      'https://api.adoptium.net/v3/assets/latest/21/hotspot?os=mac&architecture=aarch64&image_type=jre&vendor=eclipse',
    );
    const zulu = new URL(zuluMetadataUrl(8, 'linux', 'x64'));
    expect(zulu.searchParams.get('java_version')).toBe('8');
    expect(zulu.searchParams.get('arch')).toBe('x86');
    expect(zulu.searchParams.get('archive_type')).toBe('tar.gz');
  });

  it('interprète les réponses Adoptium et Zulu', () => {
    const temurin = parseTemurinAssets(
      [
        {
          binary: {
            image_type: 'jre',
            package: { link: 'https://x/jre.zip', checksum: 'A'.repeat(64), size: 10 },
          },
          version: { openjdk_version: '17.0.12+7' },
        },
      ],
      'windows',
      false,
    );
    expect(temurin).toMatchObject({
      vendor: 'temurin',
      url: 'https://x/jre.zip',
      archive: 'zip',
      sha256: 'a'.repeat(64),
      size: 10,
      fullVersion: '17.0.12+7',
    });
    expect(parseTemurinAssets({ errorMessage: 'not found' }, 'windows', false)).toBeUndefined();
    const zulu = parseZuluPackages(
      [{ package_uuid: 'u1', download_url: 'https://z/jre.tar.gz', java_version: [8, 0, 422] }],
      'macos',
      false,
    );
    expect(zulu).toMatchObject({ vendor: 'zulu', archive: 'tar.gz', packageUuid: 'u1' });
    expect(zulu?.sha256).toBeUndefined();
    expect(parseZuluDetail({ sha256_hash: 'B'.repeat(64) })).toBe('b'.repeat(64));
  });

  it('compareVersions', () => {
    expect(compareVersions('0.9.0', '0.8.0')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
  });
});
