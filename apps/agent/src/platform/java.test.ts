import { describe, expect, it } from 'vitest';

import type { JavaRuntime } from '@mmo/protocol';

import { parseJavaVersionOutput, probeJavaVersion, selectJavaRuntime } from './java.js';

const rt = (majorVersion: number, managed = false): JavaRuntime => ({
  majorVersion,
  vendor: 'test',
  path: `/java/${String(majorVersion)}`,
  managed,
});

describe('découverte Java', () => {
  it('interprète `java -version` (8, 17, 21, fournisseurs)', () => {
    expect(
      parseJavaVersionOutput(
        'java version "1.8.0_281"\nJava(TM) SE Runtime Environment (build 1.8.0_281-b09)',
      ),
    ).toEqual({ majorVersion: 8, fullVersion: '1.8.0_281', vendor: 'oracle' });
    expect(
      parseJavaVersionOutput(
        'openjdk version "17.0.5" 2022-10-18\nOpenJDK Runtime Environment Temurin-17.0.5+8',
      ),
    ).toMatchObject({ majorVersion: 17, vendor: 'temurin' });
    expect(
      parseJavaVersionOutput('openjdk version "21.0.3" 2024-04-16 LTS\nZulu21.34+19-CA'),
    ).toMatchObject({
      majorVersion: 21,
      vendor: 'zulu',
    });
    expect(parseJavaVersionOutput('garbage')).toBeUndefined();
  });

  it('sélection : exacte, sinon la plus petite supérieure, jamais en mode strict', () => {
    const runtimes = [rt(8), rt(17), rt(21, true), rt(21)];
    expect(selectJavaRuntime(runtimes, { majorVersion: 17, strict: false })?.majorVersion).toBe(17);
    expect(selectJavaRuntime(runtimes, { majorVersion: 19, strict: false })?.majorVersion).toBe(21);
    expect(selectJavaRuntime(runtimes, { majorVersion: 19, strict: false })?.managed).toBe(true);
    expect(selectJavaRuntime(runtimes, { majorVersion: 11, strict: true })).toBeUndefined();
    expect(selectJavaRuntime(runtimes, { majorVersion: 25, strict: false })).toBeUndefined();
  });

  it('sonde un exécutable inexistant sans lever', async () => {
    expect(await probeJavaVersion('/definitely/not/java')).toBeUndefined();
  });
});
