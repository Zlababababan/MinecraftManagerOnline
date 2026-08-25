/**
 * Phase 7 de bout en bout (faux panel + fake Java server) : crash et freeze simulés → événements
 * corrects (`server.stateChanged`, `watchdog.alert`), auto-restart borné par `crashLoopMax`,
 * `metrics.sample` (CPU/RSS/joueurs/TPS) avec tampon hors ligne rejoué, `port.conflict`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, type ParsedEventPayload, type RequestPayload } from '@mmo/protocol';

import { Agent } from './agent.js';
import { Logger } from './log.js';
import {
  FAKE_SERVER,
  createFakePanel,
  freePort,
  tmpDir,
  waitFor,
  type FakePanel,
  type PanelPeer,
} from './test/helpers.js';

const logger = new Logger('test', { stderr: false });

interface Captured {
  states: ParsedEventPayload<'server.stateChanged'>[];
  alerts: ParsedEventPayload<'watchdog.alert'>[];
  samples: ParsedEventPayload<'metrics.sample'>[];
  conflicts: ParsedEventPayload<'port.conflict'>[];
  heartbeats: ParsedEventPayload<'agent.heartbeat'>[];
}

function panelBehaviour(cap: Captured) {
  return (peer: PanelPeer) => {
    peer.handle('auth.hello', () => ({
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalSec: 1,
      wantFullSync: true,
      subscriptions: [],
    }));
    peer.handle('sync.state', () => ({}));
    const ack = (id: string | undefined) => {
      if (id !== undefined)
        void peer.request('event.ack', { eventIds: [id] }).catch(() => undefined);
    };
    peer.on('server.stateChanged', (p, ctx) => {
      cap.states.push(p);
      ack(ctx.id);
    });
    peer.on('watchdog.alert', (p, ctx) => {
      cap.alerts.push(p);
      ack(ctx.id);
    });
    peer.on('metrics.sample', (p) => {
      cap.samples.push(p);
    });
    peer.on('port.conflict', (p) => {
      cap.conflicts.push(p);
    });
    peer.on('agent.heartbeat', (p) => {
      cap.heartbeats.push(p);
    });
  };
}

describe('phase 7 : watchdog et métriques de bout en bout', () => {
  let stateDir: string;
  let cleanupState: () => Promise<void>;
  let serversRoot: string;
  let cleanupServers: () => Promise<void>;
  let panel: FakePanel;
  let agent: Agent | undefined;
  let cap: Captured;
  let starts = 0;

  beforeEach(async () => {
    ({ dir: stateDir, cleanup: cleanupState } = await tmpDir('mmo-wd-state-'));
    ({ dir: serversRoot, cleanup: cleanupServers } = await tmpDir('mmo-wd-servers-'));
    cap = { states: [], alerts: [], samples: [], conflicts: [], heartbeats: [] };
    starts = 0;
    panel = await createFakePanel(panelBehaviour(cap));
  });
  afterEach(async () => {
    await agent?.stop();
    await panel.close();
    await cleanupState();
    await cleanupServers();
  });

  async function prepareServer(name: string): Promise<{ dir: string; gamePort: number }> {
    const dir = path.join(serversRoot, name);
    await mkdir(path.join(dir, 'logs'), { recursive: true });
    const gamePort = await freePort();
    await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
    await writeFile(path.join(dir, 'server.properties'), `server-port=${String(gamePort)}\n`);
    await writeFile(path.join(dir, 'server.jar'), '');
    return { dir, gamePort };
  }

  async function bootAgent(
    fakeArgs: string[],
    options: { metricsIntervalMs?: number } = {},
  ): Promise<PanelPeer> {
    const rconFrom = await freePort();
    agent = new Agent({
      stateDir,
      panelUrl: panel.url,
      logger,
      scanIntervalMs: 0,
      trashPurgeIntervalMs: 0,
      restrictPermissions: false,
      backoff: { baseMs: 50, maxMs: 200 },
      metricsIntervalMs: options.metricsIntervalMs ?? 0,
      watchdog: {
        restartDelayMs: 50,
        restartDelayMaxMs: 200,
        minProbeIntervalMs: 150,
        probeTimeoutMs: 300,
        crashWindowMs: 60_000,
      },
      manager: {
        commandBuilder: (ctx) => {
          starts += 1;
          return {
            file: process.execPath,
            args: [FAKE_SERVER, '--done-after', '50', ...fakeArgs],
            cwd: ctx.config.path,
            cmdlineKey: 'fake-java-server.mjs',
            files: [],
          };
        },
        javaResolver: () =>
          Promise.resolve({
            majorVersion: 17,
            vendor: 'fake',
            path: process.execPath,
            managed: false,
          }),
        totalRamMb: () => 16_384,
        rconPortRange: [rconFrom, 65000],
        rconProbeIntervalMs: 100,
        exitPollMs: 100,
      },
    });
    await agent.store.update((s) => {
      s.agentId = 'agt_1';
      s.agentSecret = 'b'.repeat(64);
    });
    await agent.start();
    return panel.peers.length > 0 ? panel.peers[panel.peers.length - 1]! : panel.nextPeer();
  }

  function configure(
    peer: PanelPeer,
    dir: string,
    watchdog: Omit<NonNullable<RequestPayload<'agent.configure'>['watchdog']>[number], 'serverId'>,
  ) {
    return peer.request('agent.configure', {
      servers: [
        {
          serverId: 'srv_1',
          path: dir,
          maxRamMb: 1024,
          mcVersion: '1.20.1',
          loader: 'forge',
          launch: { kind: 'jar', jar: 'server.jar' },
        },
      ],
      watchdog: [{ serverId: 'srv_1', ...watchdog }],
      desiredStates: { srv_1: 'running' },
    });
  }

  it('crash simulé → alertes restart ×2 puis crash_loop gave_up (crashLoopMax = 2), 3 lancements au total', async () => {
    const { dir } = await prepareServer('Crashy');
    const peer = await bootAgent(['--crash-after', '150']);
    await configure(peer, dir, {
      autoRestart: true,
      crashLoopMax: 2,
      freezeTimeoutSec: 120,
      freezeAction: 'kill_restart',
    });
    expect(agent?.store.get().watchdog.srv_1).toMatchObject({ autoRestart: true, crashLoopMax: 2 });
    await peer.request('server.start', { serverId: 'srv_1' });

    await waitFor(() => cap.alerts.some((a) => a.kind === 'crash_loop'), 20_000);
    expect(cap.alerts.map((a) => [a.kind, a.action, a.attempt])).toEqual([
      ['crash', 'restart', 1],
      ['crash', 'restart', 2],
      ['crash_loop', 'gave_up', 2],
    ]);
    expect(cap.alerts[0]?.detail).toMatch(/unexpected_exception/);
    expect(cap.alerts[0]?.detail).toMatch(/crash-reports/);
    expect(starts).toBe(3);
    const crashed = cap.states.filter((s) => s.state === 'crashed');
    expect(crashed).toHaveLength(3);
    expect(crashed[0]).toMatchObject({ exitReason: 'crash', exitCode: 1 });
    expect(crashed[0]?.crashReportPath).toMatch(/crash-reports/);
    // Plus aucune relance après l'abandon
    await new Promise((r) => setTimeout(r, 500));
    expect(starts).toBe(3);
    expect(agent?.manager.get('srv_1')?.state).toBe('crashed');
  });

  it('autoRestart désactivé : alerte crash « none », pas de relance', async () => {
    const { dir } = await prepareServer('NoRestart');
    const peer = await bootAgent(['--crash-after', '100']);
    await configure(peer, dir, {
      autoRestart: false,
      crashLoopMax: 3,
      freezeTimeoutSec: 120,
      freezeAction: 'none',
    });
    await peer.request('server.start', { serverId: 'srv_1' });
    await waitFor(() => cap.alerts.length === 1, 10_000);
    expect(cap.alerts[0]).toMatchObject({ kind: 'crash', action: 'none', attempt: 0 });
    await new Promise((r) => setTimeout(r, 400));
    expect(starts).toBe(1);
  });

  it('freeze simulé (RCON muet, processus vivant) → kill_restart, exit « freeze_kill », relance bornée', async () => {
    const { dir } = await prepareServer('Frozen');
    const peer = await bootAgent(['--freeze-after', '100']);
    await configure(peer, dir, {
      autoRestart: true,
      crashLoopMax: 1,
      freezeTimeoutSec: 1,
      freezeAction: 'kill_restart',
    });
    await peer.request('server.start', { serverId: 'srv_1' });

    await waitFor(() => cap.alerts.some((a) => a.kind === 'crash_loop'), 30_000);
    expect(cap.alerts.map((a) => [a.kind, a.action, a.attempt])).toEqual([
      ['freeze', 'kill_restart', 1],
      ['crash', 'restart', 1],
      ['freeze', 'kill_restart', 2],
      ['crash_loop', 'gave_up', 1],
    ]);
    expect(cap.alerts[0]?.detail).toMatch(/3 consecutive rcon probe failures/);
    const crashed = cap.states.filter((s) => s.state === 'crashed');
    expect(crashed).toHaveLength(2);
    expect(crashed[0]).toMatchObject({ exitReason: 'freeze_kill' });
    expect(cap.alerts[1]?.detail).toMatch(/freeze_kill/);
    expect(starts).toBe(2);
  }, 40_000);

  it('metrics.sample : CPU/RSS/joueurs/TPS (forge) toutes les 300 ms, tampon rejoué après une coupure', async () => {
    const { dir } = await prepareServer('Metrics');
    const peer = await bootAgent(['--tps', 'forge', '--tps-value', '18.5', '--join', 'Alice'], {
      metricsIntervalMs: 300,
    });
    await configure(peer, dir, {
      autoRestart: false,
      crashLoopMax: 3,
      freezeTimeoutSec: 120,
      freezeAction: 'none',
    });
    await peer.request('server.start', { serverId: 'srv_1' });
    await waitFor(
      () =>
        cap.samples.some(
          (s) =>
            s.servers[0]?.tps !== undefined &&
            s.servers[0].players === 1 &&
            s.servers[0].rssMb !== undefined,
        ),
      30_000, // premier échantillon RSS : démarrage du sidecar Windows lent sur les runners CI
    );
    const full = cap.samples.find(
      (s) => s.servers[0]?.tps !== undefined && s.servers[0].players === 1,
    )!;
    expect(full.servers[0]).toMatchObject({
      serverId: 'srv_1',
      tps: 18.5,
      mspt: 54.05,
      tpsSource: 'forge',
      players: 1,
    });
    expect(full.machine.ramTotalMb).toBeGreaterThan(0);
    expect(['cycles', 'proc', 'ticks']).toContain(full.cpuSource);
    // Le CPU par processus arrive dès le second relevé
    await waitFor(() => cap.samples.some((s) => s.servers[0]?.cpuPct !== undefined), 15_000);
    // Le heartbeat reprend la charge machine et sa source
    await waitFor(() => cap.heartbeats.some((h) => h.cpuSource !== undefined), 10_000);

    // Coupure : les échantillons sont tamponnés puis rejoués (timestamps d'origine) à la reconnexion
    panel.pause();
    await waitFor(() => !(agent?.isConnected ?? true), 5000);
    const before = cap.samples.length;
    await waitFor(() => (agent?.metrics.buffered ?? 0) >= 3, 5000);
    expect(cap.samples.length).toBe(before);
    panel.resume();
    await waitFor(
      () => (agent?.isConnected ?? false) && (agent?.metrics.buffered ?? 1) === 0,
      10_000,
    );
    await waitFor(() => cap.samples.length >= before + 3, 5000);
    const replayed = cap.samples.slice(before);
    for (let i = 1; i < replayed.length; i++) {
      expect(replayed[i]!.ts).toBeGreaterThan(replayed[i - 1]!.ts);
    }
    // Aucune alerte : pas de crash, pas de freeze
    expect(cap.alerts).toEqual([]);
  }, 90_000); // premier échantillon RSS : jusqu'à ~30 s de démarrage du sidecar sur les runners CI

  it('port de jeu pris après les garde-fous (« FAILED TO BIND ») → port.conflict + crash', async () => {
    const { dir } = await prepareServer('Bind');
    const blocker = net.createServer();
    const taken = await freePort();
    await new Promise<void>((resolve) => blocker.listen(taken, '0.0.0.0', resolve));
    try {
      // server.properties annonce un port libre (garde-fou OK) ; le « vrai » serveur tente un port pris.
      const peer = await bootAgent(['--port', String(taken)]);
      await configure(peer, dir, {
        autoRestart: false,
        crashLoopMax: 3,
        freezeTimeoutSec: 120,
        freezeAction: 'none',
      });
      await peer.request('server.start', { serverId: 'srv_1' });
      await waitFor(() => cap.conflicts.length === 1, 10_000);
      expect(cap.conflicts[0]).toMatchObject({ serverId: 'srv_1' });
      await waitFor(() => cap.states.some((s) => s.state === 'crashed'), 10_000);
    } finally {
      blocker.close();
    }
  });
});
