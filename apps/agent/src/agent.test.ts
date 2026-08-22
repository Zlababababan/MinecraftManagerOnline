import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  type EventPayload,
  type ParsedEventPayload,
  type RequestPayload,
} from '@mmo/protocol';

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
  syncs: RequestPayload<'sync.state'>[];
  states: ParsedEventPayload<'server.stateChanged'>[];
  detected: ParsedEventPayload<'server.detected'>[];
  players: ParsedEventPayload<'player.event'>[];
  lines: ParsedEventPayload<'console.lines'>[];
  heartbeats: EventPayload<'agent.heartbeat'>[];
  acked: string[];
}

function panelBehaviour(cap: Captured) {
  return (peer: PanelPeer) => {
    peer.handle('auth.hello', () => ({
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalSec: 1,
      wantFullSync: true,
      subscriptions: [],
    }));
    peer.handle('sync.state', (p) => {
      cap.syncs.push(p);
      return {};
    });
    peer.on('server.stateChanged', (p, ctx) => {
      cap.states.push(p);
      void peer.request('event.ack', { eventIds: [ctx.id!] }).then(() => cap.acked.push(ctx.id!));
    });
    peer.on('server.detected', (p) => {
      cap.detected.push(p);
    });
    peer.on('player.event', (p) => {
      cap.players.push(p);
    });
    peer.on('console.lines', (p) => {
      cap.lines.push(p);
    });
    peer.on('agent.heartbeat', (p) => {
      cap.heartbeats.push(p);
    });
  };
}

describe('agent de bout en bout (faux panel + fake Java server)', () => {
  let stateDir: string;
  let cleanupState: () => Promise<void>;
  let serversRoot: string;
  let cleanupServers: () => Promise<void>;
  let panel: FakePanel;
  let agent: Agent | undefined;
  let cap: Captured;

  beforeEach(async () => {
    ({ dir: stateDir, cleanup: cleanupState } = await tmpDir('mmo-e2e-state-'));
    ({ dir: serversRoot, cleanup: cleanupServers } = await tmpDir('mmo-e2e-servers-'));
    cap = {
      syncs: [],
      states: [],
      detected: [],
      players: [],
      lines: [],
      heartbeats: [],
      acked: [],
    };
    panel = await createFakePanel(panelBehaviour(cap));
  });
  afterEach(async () => {
    await agent?.stop();
    await panel.close();
    await cleanupState();
    await cleanupServers();
  });

  it('configure → scan.run → server.detected → start → console → joueurs → stop, avec ack des événements', async () => {
    const dir = path.join(serversRoot, 'Vanilla');
    await mkdir(path.join(dir, 'logs'), { recursive: true });
    const gamePort = await freePort();
    await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
    await writeFile(path.join(dir, 'server.properties'), `server-port=${String(gamePort)}\n`);
    await writeFile(path.join(dir, 'server.jar'), '');
    await writeFile(
      path.join(dir, 'logs', 'latest.log'),
      '[10:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.1\n',
    );

    const rconFrom = await freePort();
    agent = new Agent({
      stateDir,
      panelUrl: panel.url,
      logger,
      scanIntervalMs: 0,
      restrictPermissions: false,
      backoff: { baseMs: 50, maxMs: 200 },
      manager: {
        commandBuilder: (ctx) => ({
          file: process.execPath,
          args: [FAKE_SERVER, '--done-after', '50', '--join', 'Alice'],
          cwd: ctx.config.path,
          cmdlineKey: 'fake-java-server.mjs',
          files: [],
        }),
        javaResolver: () =>
          Promise.resolve({
            majorVersion: 17,
            vendor: 'fake',
            path: process.execPath,
            managed: false,
          }),
        totalRamMb: () => 16_384,
        rconPortRange: [rconFrom, 65000],
        rconProbeIntervalMs: 200,
        exitPollMs: 100,
      },
    });
    await agent.store.update((s) => {
      s.agentId = 'agt_1';
      s.agentSecret = 'b'.repeat(64);
    });
    await agent.start();
    const peer = await waitForPeer(panel);
    await waitFor(() => cap.syncs.length === 1, 5000);
    expect(cap.syncs[0]?.servers).toEqual([]);

    // Configuration : répertoire surveillé → scan → server.detected (critique, journalisé)
    expect(
      await peer.request('agent.configure', {
        watchedDirectories: [{ id: 'd1', path: serversRoot, enabled: true }],
      }),
    ).toEqual({ applied: true });
    const scan = await peer.request('scan.run', {});
    expect(scan.scannedPaths).toEqual([serversRoot]);
    expect(scan.servers).toHaveLength(1);
    expect(scan.servers[0]).toMatchObject({
      name: 'Vanilla',
      loader: { value: 'vanilla' },
      mcVersion: { value: '1.20.1' },
      gamePort,
      eulaAccepted: true,
      launch: { kind: 'jar', jar: 'server.jar' },
    });
    await waitFor(() => cap.detected.length === 1, 5000);
    expect(cap.detected[0]?.directoryId).toBe('d1');

    // Le panel adopte le serveur (autorité des IDs) et pousse sa configuration
    await peer.request('agent.configure', {
      servers: [
        {
          serverId: 'srv_vanilla',
          path: dir,
          maxRamMb: 2048,
          mcVersion: '1.20.1',
          loader: 'vanilla',
          launch: { kind: 'jar', jar: 'server.jar' },
        },
      ],
    });
    const info = await peer.request('agent.info', {});
    expect(info.watchedDirectories).toEqual([serversRoot]);
    expect(info.agentVersion).toBe('0.6.0');

    // Phase 6, serveur arrêté : fichiers, configuration et joueurs via la session
    const listing = await peer.request('fs.list', { serverId: 'srv_vanilla', path: '' });
    expect(listing.entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['server.properties', 'eula.txt', 'logs']),
    );
    const props = await peer.request('config.get', {
      serverId: 'srv_vanilla',
      file: 'server.properties',
    });
    expect(props.data).toMatchObject({ 'server-port': String(gamePort) });
    const resolved = await peer.request('player.resolve', {
      serverId: 'srv_vanilla',
      names: ['Bob'],
    });
    expect(resolved.onlineMode).toBe(true);
    await peer.request('config.set', {
      serverId: 'srv_vanilla',
      file: 'server.properties',
      data: { 'online-mode': 'false' },
    });
    const offline = await peer.request('player.resolve', {
      serverId: 'srv_vanilla',
      names: ['Bob'],
    });
    expect(offline).toMatchObject({
      onlineMode: false,
      players: [{ name: 'Bob', source: 'offline' }],
    });
    expect(
      await peer.request('player.action', {
        serverId: 'srv_vanilla',
        action: 'whitelistAdd',
        target: 'Bob',
      }),
    ).toEqual({ applied: 'file' });
    const wl = await peer.request('config.get', {
      serverId: 'srv_vanilla',
      file: 'whitelist.json',
    });
    expect(wl.data).toMatchObject([{ name: 'Bob' }] as unknown[]);
    const logs = await peer.request('logs.listFiles', { serverId: 'srv_vanilla' });
    expect(logs.files.map((f) => f.name)).toEqual(['latest.log']);
    const found = await peer.request('logs.search', { serverId: 'srv_vanilla', query: 'starting' });
    expect(found.matches).toHaveLength(1);

    // Démarrage
    const started = await peer.request('server.start', { serverId: 'srv_vanilla' });
    expect(started.alreadyRunning).toBe(false);
    await waitFor(() => cap.states.some((s) => s.state === 'running'), 5000);
    expect(cap.states.map((s) => s.state)).toEqual(['starting', 'running']);
    expect(cap.states[0]?.pid).toBe(started.pid);
    await waitFor(() => cap.acked.length === 2, 5000);
    expect(agent.store.get().pendingEvents.filter((e) => e.type === 'server.stateChanged')).toEqual(
      [],
    );

    // Console : abonnement avec rattrapage, puis flux
    const sub = await peer.request('console.subscribe', { serverId: 'srv_vanilla', sinceSeq: 0 });
    expect(sub.truncated).toBe(false);
    expect(sub.lines.some((l) => l.text.includes('Done ('))).toBe(true);
    expect(sub.latestSeq).toBe(sub.lines.at(-1)?.seq);
    expect(
      await peer.request('server.command', { serverId: 'srv_vanilla', command: 'say coucou' }),
    ).toEqual({
      via: 'stdin',
    });
    await waitFor(
      () => cap.lines.some((b) => b.lines.some((l) => l.text.includes('[Server] coucou'))),
      5000,
    );

    // Joueurs
    await waitFor(() => cap.players.length === 1, 5000);
    expect(cap.players[0]).toMatchObject({ kind: 'join', name: 'Alice', online: 1 });
    expect(await peer.request('player.list', { serverId: 'srv_vanilla' })).toEqual({
      online: 1,
      players: [{ name: 'Alice', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5' }],
    });
    expect(
      (await peer.request('server.rcon', { serverId: 'srv_vanilla', command: 'list' })).response,
    ).toContain('Alice');

    // Heartbeat : serveurs actifs
    await waitFor(() => cap.heartbeats.some((h) => h.activeServers === 1), 5000);

    // Phase 6, serveur en marche : routage en commandes
    const live = await peer.request('config.set', {
      serverId: 'srv_vanilla',
      file: 'whitelist.json',
      data: [],
    });
    expect(live).toMatchObject({ applied: 'commands', commands: ['whitelist remove Bob'] });
    await waitFor(
      async () =>
        (
          (await peer.request('config.get', { serverId: 'srv_vanilla', file: 'whitelist.json' }))
            .data as unknown[]
        ).length === 0,
      5000,
    );
    const trashed = await peer.request('fs.delete', {
      serverId: 'srv_vanilla',
      path: 'whitelist.json',
    });
    expect(trashed.trashedAs).toMatch(/^\.mmo-trash\/\d+-whitelist\.json$/);

    // Arrêt propre
    expect(await peer.request('server.stop', { serverId: 'srv_vanilla', timeoutSec: 5 })).toEqual({
      alreadyStopped: false,
      forced: false,
    });
    await waitFor(() => cap.states.at(-1)?.state === 'stopped', 5000);
    expect(cap.states.at(-1)).toMatchObject({ exitReason: 'stop', previous: 'stopping' });
    expect(await peer.request('server.kill', { serverId: 'srv_vanilla' })).toEqual({
      wasRunning: false,
    });
  });

  it('types inconnus et erreurs typées traversent la session (E_UNSUPPORTED_TYPE, E_NOT_FOUND)', async () => {
    agent = new Agent({
      stateDir,
      panelUrl: panel.url,
      logger,
      scanIntervalMs: 0,
      restrictPermissions: false,
      backoff: { baseMs: 50, maxMs: 200 },
    });
    await agent.store.load();
    await agent.store.update((s) => {
      s.agentId = 'agt_1';
      s.agentSecret = 'b'.repeat(64);
    });
    await agent.start();
    const peer = await waitForPeer(panel);
    await waitFor(() => cap.syncs.length === 1, 5000);
    await expect(peer.request('server.start', { serverId: 'ghost' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
    // Chemin absolu refusé par le schéma (jail), serveur inconnu, type non géré par l'agent.
    await expect(peer.request('fs.list', { serverId: 'ghost', path: '/' })).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    await expect(peer.request('fs.list', { serverId: 'ghost', path: '' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
    await expect(
      peer.request('fs.list', { serverId: 'ghost', path: '../x' }),
    ).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    const java = await peer.request('java.list', {});
    expect(Array.isArray(java.runtimes)).toBe(true);
  });
});

async function waitForPeer(panel: FakePanel): Promise<PanelPeer> {
  await waitFor(() => panel.peers.length >= 1, 5000);
  return panel.peers.at(-1)!;
}
