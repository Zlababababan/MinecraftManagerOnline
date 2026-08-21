import { describe, expect, it } from 'vitest';

import { compareMcVersions, normalizeMcVersion, parseMcVersion } from '../minecraft/version.js';
import {
  createMojangJavaSource,
  isStrictJava8,
  javaMajorFromTable,
  javaRequirementFromTable,
  resolveJavaRequirement,
} from './index.js';

describe('versions Minecraft', () => {
  it('parse releases, pré-releases et snapshots', () => {
    expect(parseMcVersion('1.20.1')).toEqual({
      id: '1.20.1',
      parts: [1, 20, 1],
      prerelease: false,
    });
    expect(parseMcVersion('1.21')).toEqual({ id: '1.21', parts: [1, 21, 0], prerelease: false });
    expect(parseMcVersion('1.21.2-pre1')?.prerelease).toBe(true);
    expect(parseMcVersion('24w14a')).toEqual({ id: '24w14a', parts: undefined, prerelease: true });
    expect(parseMcVersion('forge')).toBeUndefined();
  });

  it('compare et normalise', () => {
    expect(compareMcVersions('1.20.5', '1.20.4')).toBeGreaterThan(0);
    expect(compareMcVersions('1.21', '1.21.0')).toBe(0);
    expect(compareMcVersions('1.12.2', '1.17')).toBeLessThan(0);
    expect(compareMcVersions('24w14a', '1.21')).toBeUndefined();
    expect(normalizeMcVersion('1.21.0')).toBe('1.21');
    expect(normalizeMcVersion('1.21.1')).toBe('1.21.1');
  });
});

describe('table de repli MC → Java', () => {
  it.each([
    ['1.12.2', 8],
    ['1.16.5', 8],
    ['1.17', 17],
    ['1.18.2', 17],
    ['1.20.1', 17],
    ['1.20.4', 17],
    ['1.20.5', 21],
    ['1.21.1', 21],
    ['1.7.10', 8],
    ['24w14a', 21],
  ])('%s → Java %i', (mc, major) => {
    expect(javaMajorFromTable(mc)).toBe(major);
  });

  it('Forge ≤ 1.16.5 = strictement Java 8', () => {
    expect(isStrictJava8('forge', '1.12.2')).toBe(true);
    expect(isStrictJava8('forge', '1.16.5')).toBe(true);
    expect(isStrictJava8('forge', '1.17.1')).toBe(false);
    expect(isStrictJava8('vanilla', '1.12.2')).toBe(false);
    expect(javaRequirementFromTable('1.16.5', 'forge')).toEqual({
      majorVersion: 8,
      strict: true,
      source: 'table',
    });
  });

  it('override par serveur toujours prioritaire', () => {
    expect(javaRequirementFromTable('1.21.1', 'neoforge', 25)).toEqual({
      majorVersion: 25,
      strict: false,
      source: 'override',
    });
  });
});

describe('manifest Mojang', () => {
  const index = {
    latest: { release: '1.21.1', snapshot: '24w33a' },
    versions: [
      { id: '1.21.1', type: 'release', url: 'https://meta/1.21.1.json' },
      { id: '1.20.1', type: 'release', url: 'https://meta/1.20.1.json' },
      { id: '1.17', type: 'release', url: 'https://meta/1.17.json' },
      { id: '1.12.2', type: 'release', url: 'https://meta/1.12.2.json' },
    ],
  };
  const details: Record<string, unknown> = {
    'https://meta/1.21.1.json': {
      id: '1.21.1',
      javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
    },
    'https://meta/1.20.1.json': {
      id: '1.20.1',
      javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
    },
    'https://meta/1.17.json': {
      id: '1.17',
      javaVersion: { component: 'java-runtime-alpha', majorVersion: 16 },
    },
    'https://meta/1.12.2.json': {
      id: '1.12.2',
      javaVersion: { component: 'jre-legacy', majorVersion: 8 },
    },
  };
  function fakeFetch(calls: string[]): typeof fetch {
    return (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const body = url.endsWith('version_manifest_v2.json') ? index : details[url];
      if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
  }

  it('lit javaVersion.majorVersion et met en cache index + détails', async () => {
    const calls: string[] = [];
    const source = createMojangJavaSource({ fetch: fakeFetch(calls) });
    expect(await source.lookup('1.21.1')).toBe(21);
    expect(await source.lookup('1.21.1')).toBe(21);
    expect(await source.lookup('1.17')).toBe(16);
    expect(calls.filter((u) => u.endsWith('version_manifest_v2.json'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('1.21.1.json'))).toHaveLength(1);
    expect(await source.lookup('9.9.9')).toBeUndefined();
  });

  it('resolveJavaRequirement : manifest prioritaire, table en repli, strict conservé', async () => {
    const source = createMojangJavaSource({ fetch: fakeFetch([]) });
    expect(await resolveJavaRequirement({ mcVersion: '1.17', loader: 'fabric' }, source)).toEqual({
      majorVersion: 16,
      strict: false,
      source: 'manifest',
    });
    expect(await resolveJavaRequirement({ mcVersion: '1.12.2', loader: 'forge' }, source)).toEqual({
      majorVersion: 8,
      strict: true,
      source: 'manifest',
    });
    expect(await resolveJavaRequirement({ mcVersion: '1.19.2', loader: 'forge' }, source)).toEqual({
      majorVersion: 17,
      strict: false,
      source: 'table',
    });
    const failing = createMojangJavaSource({
      fetch: () => Promise.reject(new Error('offline')),
    });
    expect(await resolveJavaRequirement({ mcVersion: '1.21.1' }, failing)).toEqual({
      majorVersion: 21,
      strict: false,
      source: 'table',
    });
    expect(
      await resolveJavaRequirement({ mcVersion: '1.21.1', override: 17 }, source),
    ).toMatchObject({
      majorVersion: 17,
      source: 'override',
    });
  });
});
