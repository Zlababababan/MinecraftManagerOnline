/**
 * Launcher (doc 03 §3) avec de faux bundles : bascule `next.json` → essai → `healthy` → `applied` ;
 * bundle **volontairement cassé** (crash au démarrage) → 2 crashs → **rollback N-1** + `update-result`
 * `rolled_back`/`crash_loop` ; bundle muet (jamais `healthy`) → `health_timeout` → rollback ;
 * code de sortie 75 → relance immédiate avec la nouvelle version.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { tmpDir, waitFor } from '../test/helpers.js';

const LAUNCHER = path.resolve(import.meta.dirname, '../../launcher/launcher.cjs');

/** Bundle factice : écrit `started-<version>` dans `home`, puis selon le mode. */
function fakeBundle(mode: 'healthy' | 'crash' | 'mute' | 'update-then-healthy'): string {
  return `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.MMO_AGENT_HOME;
const version = process.env.MMO_AGENT_VERSION;
fs.appendFileSync(path.join(home, 'starts.log'), version + '\\n');
const mode = ${JSON.stringify(mode)};
if (mode === 'crash') { throw new Error('broken bundle'); }
if (mode === 'update-then-healthy') {
  if (!fs.existsSync(path.join(home, 'next.json'))) {
    // Première exécution : simule agent.update (next.json puis exit 75).
    fs.writeFileSync(path.join(home, 'next.json'), JSON.stringify({ version: '1.1.0', previous: version }));
    process.exit(75);
  }
}
if (mode !== 'mute') { if (process.send) process.send({ type: 'healthy', version }); }
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

describe('launcher : bascule, health-check, rollback', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    const running = child;
    if (running?.exitCode === null) {
      running.kill('SIGTERM');
      await new Promise((r) => running.once('exit', r));
    }
    child = undefined;
    await cleanup();
  });

  async function setup(versions: Record<string, string>, current: string): Promise<void> {
    ({ dir: home, cleanup } = await tmpDir('mmo-launcher-'));
    for (const [v, code] of Object.entries(versions)) {
      await mkdir(path.join(home, 'versions', v), { recursive: true });
      await writeFile(path.join(home, 'versions', v, 'agent.js'), code);
    }
    await writeFile(path.join(home, 'current.json'), JSON.stringify({ version: current }));
  }

  function start(healthMs = 1500): ChildProcess {
    child = spawn(process.execPath, [LAUNCHER], {
      env: { ...process.env, MMO_AGENT_HOME: home, MMO_LAUNCHER_HEALTH_MS: String(healthMs) },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', () => undefined);
    return child;
  }

  const json = async (file: string): Promise<Record<string, unknown> | undefined> => {
    try {
      return JSON.parse(await readFile(path.join(home, file), 'utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const starts = async (): Promise<string[]> =>
    (await readFile(path.join(home, 'starts.log'), 'utf8').catch(() => ''))
      .split('\n')
      .filter((l) => l !== '');

  it('bundle cassé → 2 crashs → rollback N-1, update-result rolled_back', async () => {
    await setup({ '1.0.0': fakeBundle('healthy'), '1.1.0': fakeBundle('crash') }, '1.0.0');
    await writeFile(
      path.join(home, 'next.json'),
      JSON.stringify({ version: '1.1.0', previous: '1.0.0' }),
    );
    start();
    await waitFor(async () => (await json('update-result.json')) !== undefined, 20_000);
    const result = await json('update-result.json');
    expect(result).toMatchObject({
      kind: 'agent',
      status: 'rolled_back',
      version: '1.0.0',
      otherVersion: '1.1.0',
      reason: 'crash_loop',
    });
    expect(await json('current.json')).toEqual({ version: '1.0.0' });
    expect(await json('trial.json')).toBeUndefined();
    expect(await json('next.json')).toBeUndefined();
    // Le bundle cassé a été essayé deux fois, puis l'ancien relancé.
    await waitFor(async () => (await starts()).filter((v) => v === '1.0.0').length >= 1, 10_000);
    expect((await starts()).filter((v) => v === '1.1.0')).toHaveLength(2);
    expect(await readFile(path.join(home, 'versions', '1.1.0', '.broken'), 'utf8')).toContain(
      'crash_loop',
    );
  });

  it('bundle muet → health_timeout → rollback', async () => {
    await setup({ '1.0.0': fakeBundle('healthy'), '1.1.0': fakeBundle('mute') }, '1.0.0');
    await writeFile(
      path.join(home, 'next.json'),
      JSON.stringify({ version: '1.1.0', previous: '1.0.0' }),
    );
    start(800);
    await waitFor(async () => (await json('update-result.json')) !== undefined, 20_000);
    expect(await json('update-result.json')).toMatchObject({
      status: 'rolled_back',
      version: '1.0.0',
      reason: 'health_timeout',
    });
    expect(await json('current.json')).toEqual({ version: '1.0.0' });
  });

  it('exit 75 → relance sur la nouvelle version → healthy → applied', async () => {
    await setup(
      { '1.0.0': fakeBundle('update-then-healthy'), '1.1.0': fakeBundle('healthy') },
      '1.0.0',
    );
    start();
    await waitFor(async () => (await json('update-result.json')) !== undefined, 20_000);
    expect(await json('update-result.json')).toMatchObject({
      kind: 'agent',
      status: 'applied',
      version: '1.1.0',
      otherVersion: '1.0.0',
    });
    expect(await json('current.json')).toEqual({ version: '1.1.0' });
    expect(await starts()).toEqual(['1.0.0', '1.1.0']);
    expect(await json('trial.json')).toBeUndefined();
  });
});
