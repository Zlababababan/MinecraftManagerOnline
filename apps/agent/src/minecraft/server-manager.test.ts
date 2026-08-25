import net from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerConfig } from '@mmo/protocol';

import { Logger } from '../log.js';
import { StateStore } from '../state/store.js';
import { FAKE_SERVER, freePort, sleep, tmpDir, waitFor, testBudget } from '../test/helpers.js';
import { parseProperties } from './properties.js';
import { ServerManager, type CommandContext } from './server-manager.js';
import type { ServerProcessEvent } from './server-process.js';

const logger = new Logger('test', { stderr: false });

/** Le fake server remplace java : il lit RCON dans server.properties (auto-provisionné). */
function commandBuilder(extra: string[] = []) {
  return (ctx: CommandContext) => ({
    file: process.execPath,
    args: [FAKE_SERVER, '--done-after', '50', ...extra],
    cwd: ctx.config.path,
    cmdlineKey: 'fake-java-server.mjs',
    files: [],
  });
}

function config(dir: string, over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    serverId: 'srv_1',
    path: dir,
    maxRamMb: 2048,
    mcVersion: '1.20.1',
    loader: 'vanilla',
    launch: { kind: 'jar', jar: 'server.jar' },
    ...over,
  };
}

async function serverDir(port: number) {
  const { dir, cleanup } = await tmpDir();
  await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(dir, 'server.properties'), `server-port=${String(port)}\nmotd=Test\n`);
  await writeFile(path.join(dir, 'server.jar'), '');
  return { dir, cleanup };
}

describe('gestionnaire de serveurs (garde-fous doc 05 §6, provisionnement doc 06 §5)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let stateDir: string;
  let cleanupState: () => Promise<void>;
  let gamePort: number;
  let events: [string, ServerProcessEvent][];
  let managers: ServerManager[];

  const makeManager = async (
    over: Partial<ConstructorParameters<typeof ServerManager>[0]> = {},
  ) => {
    const store = new StateStore(stateDir, { restrictPermissions: false });
    await store.load();
    const m = new ServerManager({
      store,
      logger,
      os: 'linux',
      onEvent: (id, e) => events.push([id, e]),
      commandBuilder: commandBuilder(),
      javaResolver: () =>
        Promise.resolve({
          majorVersion: 17,
          vendor: 'fake',
          path: process.execPath,
          managed: false,
        }),
      totalRamMb: () => 8192,
      rconPortRange: [await freePort(), 65000],
      rconProbeIntervalMs: 200,
      exitPollMs: 100,
      ...over,
    });
    managers.push(m);
    return m;
  };

  beforeEach(async () => {
    gamePort = await freePort();
    ({ dir, cleanup } = await serverDir(gamePort));
    ({ dir: stateDir, cleanup: cleanupState } = await tmpDir('mmo-state-'));
    events = [];
    managers = [];
  });
  afterEach(async () => {
    for (const m of managers) {
      for (const id of Object.keys(m.store.get().servers)) {
        const p = m.get(id);
        if (p?.isRunning) await p.kill();
      }
      m.dispose();
    }
    await cleanup();
    await cleanupState();
  });

  it('E_NOT_FOUND pour un serveur inconnu, E_EULA_REQUIRED sans eula, puis eulaAccept', async () => {
    const m = await makeManager();
    await expect(m.start('nope')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await writeFile(path.join(dir, 'eula.txt'), 'eula=false\n');
    await m.applyConfigs([config(dir)]);
    await expect(m.start('srv_1')).rejects.toMatchObject({ code: 'E_EULA_REQUIRED' });
    await m.acceptEula('srv_1');
    expect(await readFile(path.join(dir, 'eula.txt'), 'utf8')).toContain('eula=true');
    // Marqueur déposé (doc 04 §3)
    const marker = JSON.parse(await readFile(path.join(dir, '.mmo-server.json'), 'utf8')) as {
      serverId: string;
    };
    expect(marker.serverId).toBe('srv_1');
  });

  it('E_RAM_GUARD quand la mémoire machine est insuffisante (réserve + serveurs en marche)', async () => {
    const m = await makeManager({ totalRamMb: () => 2048, ramReserveMb: 1024 });
    await m.applyConfigs([config(dir, { maxRamMb: 1500 })]);
    await expect(m.start('srv_1')).rejects.toMatchObject({
      code: 'E_RAM_GUARD',
      details: { requestedMb: 1500, availableMb: 1024, totalMb: 2048 },
    });
  });

  it('E_JAVA_UNAVAILABLE typé (javaPath invalide)', async () => {
    const m = await makeManager({ javaResolver: undefined });
    await m.applyConfigs([config(dir, { javaPath: '/nope/java' })]);
    await expect(m.start('srv_1')).rejects.toMatchObject({ code: 'E_JAVA_UNAVAILABLE' });
  });

  it('E_PORT_IN_USE si le port de jeu est occupé', async () => {
    const blocker = net.createServer().listen(gamePort, '0.0.0.0');
    await new Promise((r) => blocker.once('listening', r));
    try {
      const m = await makeManager();
      await m.applyConfigs([config(dir)]);
      await expect(m.start('srv_1')).rejects.toMatchObject({
        code: 'E_PORT_IN_USE',
        details: { port: gamePort },
      });
    } finally {
      blocker.close();
    }
  });

  it('provisionne RCON dans server.properties, démarre, idempotent (alreadyRunning), restart, snapshot', async () => {
    const m = await makeManager();
    await m.applyConfigs([config(dir)]);
    const r = await m.start('srv_1');
    expect(r.alreadyRunning).toBe(false);
    expect(r.pid).toBeGreaterThan(0);
    const props = parseProperties(await readFile(path.join(dir, 'server.properties'), 'utf8'));
    expect(props.get('enable-rcon')).toBe('true');
    expect(props.get('motd')).toBe('Test');
    const rconPort = Number(props.get('rcon.port'));
    expect(props.get('rcon.password')?.length).toBeGreaterThan(20);
    expect(m.store.getServer('srv_1')?.rcon).toEqual({
      port: rconPort,
      password: props.get('rcon.password'),
    });

    const proc = m.require('srv_1');
    await waitFor(() => proc.state === 'running', 5000);
    expect(await m.start('srv_1')).toEqual({ alreadyRunning: true, pid: r.pid });
    expect(await m.rcon('srv_1', 'list')).toContain('There are 0');
    expect(m.portsInUse()).toEqual([gamePort, rconPort].sort((a, b) => a - b));
    expect(m.snapshotServers()).toEqual([
      expect.objectContaining({
        serverId: 'srv_1',
        runState: 'running',
        attachMode: 'attached',
        pid: r.pid,
        gamePort,
        rconPort,
      }),
    ]);
    // runtime persisté pour la ré-adoption
    const runtime = m.store.getServer('srv_1')?.runtime;
    expect(runtime).toMatchObject({ pid: r.pid, cmdlineKey: 'fake-java-server.mjs', rconPort });

    await m.restart('srv_1', { timeoutMs: 3000 });
    await waitFor(() => proc.state === 'running', 5000);
    expect(proc.pid).not.toBe(r.pid);
    await m.stop('srv_1', { timeoutMs: 3000 });
    expect(m.store.getServer('srv_1')?.runtime).toBeUndefined();
    expect(
      events
        .filter(([, e]) => e.kind === 'state')
        .map(([, e]) => (e.kind === 'state' ? e.state : '')),
    ).toEqual([
      'starting',
      'running',
      'stopping',
      'stopped',
      'starting',
      'running',
      'stopping',
      'stopped',
    ]);
  });

  it(
    'ré-adoption par une nouvelle instance (agent redémarré) : detached, puis stop RCON',
    async () => {
      const m1 = await makeManager();
      await m1.applyConfigs([config(dir)]);
      const { pid } = await m1.start('srv_1');
      await waitFor(() => m1.require('srv_1').state === 'running', 5000);
      await sleep(300); // laisse l'heure de démarrage observée se persister
      m1.dispose(); // l'agent « meurt » : le serveur survit (détaché)
      managers.length = 0;

      const m2 = await makeManager();
      await m2.init();
      const proc = m2.require('srv_1');
      expect(proc.pid).toBe(pid);
      expect(proc.attachMode).toBe('detached');
      await waitFor(() => proc.state === 'running', 5000);
      expect(m2.snapshotServers()[0]).toMatchObject({
        runState: 'running',
        attachMode: 'detached',
        pid,
      });
      expect(await m2.command('srv_1', 'say hello')).toBe('rcon');
      await m2.stop('srv_1', { timeoutMs: 5000 });
      expect(proc.state).toBe('stopped');
      expect(m2.store.getServer('srv_1')?.runtime).toBeUndefined();
    },
    testBudget(90_000),
  ); // première requête CIM à froid : jusqu'à ~20 s sur les runners CI

  it('runtime obsolète (processus mort) nettoyé à l’init ; restoreOnBoot relance les desired_state', async () => {
    const m1 = await makeManager();
    await m1.applyConfigs([config(dir)]);
    await m1.start('srv_1');
    await waitFor(() => m1.require('srv_1').state === 'running', 5000);
    await m1.require('srv_1').kill();
    // Simule un état persisté avec un PID mort
    await m1.store.update((s) => {
      s.servers.srv_1!.runtime = {
        pid: 2_147_483_644,
        startedAt: Date.now(),
        cmdlineKey: 'x',
        attachMode: 'attached',
      };
      s.desiredStates.srv_1 = 'running';
      s.restoreOnBoot = true;
    });
    m1.dispose();
    managers.length = 0;
    const m2 = await makeManager();
    await m2.init();
    const proc = m2.require('srv_1');
    expect(proc.attachMode).toBe('attached');
    await waitFor(() => proc.state === 'running', 5000);
    await m2.stop('srv_1', { timeoutMs: 3000 });
  });

  it('applyConfigs oublie un serveur retiré (arrêté) mais garde un serveur en marche', async () => {
    const m = await makeManager();
    await m.applyConfigs([config(dir), config(dir, { serverId: 'srv_2', path: `${dir}-other` })]);
    await m.start('srv_1');
    await waitFor(() => m.require('srv_1').state === 'running', 5000);
    await m.applyConfigs([]);
    expect(Object.keys(m.store.get().servers)).toEqual(['srv_1']);
    await m.stop('srv_1', { timeoutMs: 3000 });
  });
});
