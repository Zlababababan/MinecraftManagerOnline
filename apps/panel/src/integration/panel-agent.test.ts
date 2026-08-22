/**
 * Critère « terminé quand » de la phase 4 (doc 07) : panel + agent **réels** in-process —
 * appairage → scan → start → console live → coupure/reconnexion avec rattrapage `seq` → stop.
 * L'agent est importé depuis ses sources (`apps/agent/src`), Java est remplacé par le fake Java server.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerDto } from '@mmo/protocol/client';

import { Agent } from '../../../agent/src/agent.js';
import { Logger } from '../../../agent/src/log.js';
import {
  connectClient,
  createTestPanel,
  freePort,
  setupAdmin,
  tmpDir,
  waitFor,
  type TestPanel,
} from '../test/helpers.js';

const FAKE_SERVER = path.resolve(import.meta.dirname, '../../../agent/test/fake-java-server.mjs');

interface Msg {
  type: string;
  [k: string]: unknown;
}

describe('intégration panel ↔ agent réels', () => {
  let panel: TestPanel;
  let admin: string;
  let stateDir: string;
  let serversRoot: string;
  let cleanups: (() => Promise<void>)[] = [];
  let agent: Agent | undefined;

  beforeEach(async () => {
    panel = await createTestPanel({
      now: () => Date.now(),
      config: { heartbeatIntervalSec: 1, offlineAfterMs: 10_000 },
    });
    await panel.listen();
    admin = await setupAdmin(panel);
    const s = await tmpDir('mmo-int-state-');
    const r = await tmpDir('mmo-int-servers-');
    stateDir = s.dir;
    serversRoot = r.dir;
    cleanups = [s.cleanup, r.cleanup];
  });
  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
    await panel.close();
    for (const c of cleanups) await c();
  });

  it('appairage → scan → start → console live → coupure/reconnexion (rattrapage seq) → stop', async () => {
    // Un serveur Vanilla minimal (comme dans le test e2e de l'agent).
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

    // 1. « Ajouter machine » → code d'appairage.
    let res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Tour' },
      headers: { cookie: admin },
    });
    const { machine, pairing } = res.json<{ machine: { id: string }; pairing: { code: string } }>();

    // 2. Agent réel démarré avec le code : appairage, reconnexion, auth.hello, sync.state.
    const rconFrom = await freePort();
    agent = new Agent({
      stateDir,
      panelUrl: `${panel.wsUrl}/ws/agent`,
      pairCode: pairing.code,
      logger: new Logger('agent', { stderr: false }),
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
    await agent.start();
    await waitFor(() => panel.ctx.registry.isConnected(machine.id), 10_000);
    expect(agent.store.get().agentId).toBe(machine.id);
    expect(panel.ctx.machines.require(machine.id)).toMatchObject({
      status: 'online',
      agentVersion: '0.9.0',
    });
    await waitFor(
      () => panel.ctx.events.list({ machineId: machine.id, type: 'agent.online' }).length === 1,
    );

    // 3. Répertoire surveillé + scan → adoption automatique (ID attribué par le panel).
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/machines/${machine.id}/directories`,
      payload: { path: serversRoot },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(201);
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/machines/${machine.id}/scan`,
      payload: {},
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    const scan = res.json<{ scannedPaths: string[]; servers: ServerDto[]; conflicts: unknown[] }>();
    expect(scan.scannedPaths).toEqual([serversRoot]);
    expect(scan.servers).toHaveLength(1);
    const server = scan.servers[0]!;
    expect(server).toMatchObject({
      name: 'Vanilla',
      loader: 'vanilla',
      mcVersion: '1.20.1',
      gamePort,
      eulaAccepted: true,
      provisioning: 'ready',
      runState: 'stopped',
      reachable: true,
      javaMajorRequired: 17,
      detection: { launch: { kind: 'jar', jar: 'server.jar' } },
    });
    expect(scan.conflicts).toEqual([]);
    // Le marqueur `.mmo-server.json` porte l'ID du panel, la config est persistée côté agent.
    await waitFor(async () => {
      try {
        const marker = JSON.parse(await readFile(path.join(dir, '.mmo-server.json'), 'utf8')) as {
          serverId?: string;
        };
        return marker.serverId === server.id;
      } catch {
        return false;
      }
    });
    expect(agent.store.get().servers[server.id]?.config).toMatchObject({
      path: server.path,
      maxRamMb: server.maxRamMb,
    });

    // 4. Navigateur : abonnement console avant le démarrage.
    const client = await connectClient(panel.wsUrl, admin);
    const msgs = client.messages as Msg[];
    client.send({ type: 'subscribe', channels: [`console:${server.id}`] });
    await waitFor(() => msgs.some((m) => m.type === 'console.snapshot'));

    // 5. Start via REST → événements d'état relayés, console live (« Done »).
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/servers/${server.id}/start`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ pid: number }>().pid).toBeGreaterThan(0);
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'running', 15_000);
    expect(panel.ctx.servers.require(server.id)).toMatchObject({
      desiredState: 'running',
      attachMode: 'attached',
    });
    const consoleText = (): string =>
      msgs
        .filter((m) => m.type === 'console.lines')
        .flatMap((m) => (m.lines as { text: string }[]).map((l) => l.text))
        .join('\n');
    await waitFor(() => consoleText().includes('Done ('));
    await waitFor(() =>
      msgs.some((m) => m.type === 'server.state' && (m.server as ServerDto).runState === 'running'),
    );
    await waitFor(() => panel.ctx.servers.onlinePlayers(server.id).length === 1);
    expect(panel.ctx.servers.onlinePlayers(server.id)[0]).toMatchObject({ name: 'Alice' });

    // 6. Commande console (stdin) → historique + ligne relayée.
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/servers/${server.id}/command`,
      payload: { command: '/say coucou' },
      headers: { cookie: admin },
    });
    expect(res.json()).toEqual({ via: 'stdin' });
    await waitFor(() => consoleText().includes('[Server] coucou'));
    res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/${server.id}/command-history`,
      headers: { cookie: admin },
    });
    expect(res.json<{ history: { command: string }[] }>().history[0]?.command).toBe('say coucou');

    // 7. Coupure côté panel → reconnexion de l'agent, ré-abonnement console avec `sinceSeq`,
    //    réconciliation (serveur toujours en marche, attaché), rattrapage sans doublon.
    const seqsBefore = msgs
      .filter((m) => m.type === 'console.lines')
      .flatMap((m) => (m.lines as { seq: number }[]).map((l) => l.seq));
    const lastSeq = Math.max(...seqsBefore);
    panel.ctx.registry.require(machine.id).close(4000, 'test drop');
    await waitFor(() => panel.ctx.machines.require(machine.id).status === 'offline');
    await waitFor(() => panel.ctx.registry.isConnected(machine.id), 10_000);
    await waitFor(
      () => panel.ctx.events.list({ machineId: machine.id, type: 'agent.online' }).length === 2,
    );
    expect(panel.ctx.servers.require(server.id)).toMatchObject({
      runState: 'running',
      attachMode: 'attached',
    });
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/servers/${server.id}/command`,
      payload: { command: 'say after-reconnect' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => consoleText().includes('[Server] after-reconnect'));
    const seqsAfter = msgs
      .filter((m) => m.type === 'console.lines')
      .flatMap((m) => (m.lines as { seq: number }[]).map((l) => l.seq));
    expect(new Set(seqsAfter).size).toBe(seqsAfter.length); // aucun doublon
    expect(seqsAfter.filter((s) => s > lastSeq).length).toBeGreaterThan(0);
    for (let i = 1; i < seqsAfter.length; i++)
      expect(seqsAfter[i]!).toBeGreaterThan(seqsAfter[i - 1]!);

    // 8. Joueurs et RCON.
    res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/${server.id}/players`,
      headers: { cookie: admin },
    });
    expect(res.json<{ online: number; players: { name: string }[] }>()).toMatchObject({
      online: 1,
      players: [{ name: 'Alice' }],
    });
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/servers/${server.id}/rcon`,
      payload: { command: 'list' },
      headers: { cookie: admin },
    });
    expect(res.json<{ response: string }>().response).toContain('Alice');

    // 9. Stop propre → stopped, exitReason stop, sessions joueurs clôturées, desired stopped.
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/servers/${server.id}/stop`,
      payload: { timeoutSec: 5 },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ forced: boolean }>().forced).toBe(false);
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'stopped');
    expect(panel.ctx.servers.require(server.id)).toMatchObject({
      lastExitReason: 'stop',
      desiredState: 'stopped',
      pid: null,
    });
    expect(panel.ctx.servers.onlinePlayers(server.id)).toEqual([]);
    const states = panel.ctx.events
      .list({ serverId: server.id, type: 'server.stateChanged', limit: 100 })
      .map((e) => (e.payload as { state: string }).state)
      .reverse();
    expect(states).toEqual(['starting', 'running', 'stopping', 'stopped']);
    expect(panel.ctx.events.list({ serverId: server.id, type: 'player.joined' })).toHaveLength(1);
    expect(panel.ctx.audit.list().map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'server.start',
        'server.command',
        'server.rcon',
        'server.stop',
        'machine.paired',
      ]),
    );

    // 10. Garde-fous typés traversent jusqu'au front : E_NOT_FOUND (404), agent hors ligne (503).
    res = await panel.app.inject({
      method: 'POST',
      url: '/api/servers/ghost/start',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(404);
    client.close();
    await agent.stop();
    agent = undefined;
    await waitFor(() => !panel.ctx.registry.isConnected(machine.id));
    res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/${server.id}`,
      headers: { cookie: admin },
    });
    expect(res.json<{ server: ServerDto }>().server.reachable).toBe(false);
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/servers/${server.id}/start`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('E_AGENT_OFFLINE');
  });
});
