/**
 * Groupes de démarrage (lot 7) : CRUD, appartenance par PATCH serveur (rang auto en fin de
 * groupe), et actions ordonnées contre un faux agent — démarrage ascendant en ATTENDANT `running`
 * (posé ici par le handler du faux agent, avec un délai), arrêt descendant, série interrompue au
 * premier refus avec `server.startFailed` publié, E_BUSY pendant une action en cours.
 */
import { eq, inArray } from 'drizzle-orm';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProtocolError } from '@mmo/protocol';

import { events, servers } from '../db/schema.js';
import {
  connectFakeAgent,
  createTestPanel,
  helloPayload,
  pairPayload,
  setupAdmin,
  waitFor,
  type FakeAgent,
  type TestPanel,
} from '../test/helpers.js';

function detected(path: string, name: string, gamePort: number) {
  return {
    path,
    name,
    loader: { value: 'vanilla' as const, confidence: 'high' as const, source: 'jar_name' },
    mcVersion: { value: '1.20.1', confidence: 'high' as const, source: 'jar_manifest' },
    maxRamMb: { value: 2048, confidence: 'medium' as const, source: 'run_script' },
    gamePort,
    eulaAccepted: true,
    launch: { kind: 'jar' as const, jar: 'server.jar' },
    javaRequirement: { majorVersion: 17, strict: false, source: 'table' as const },
    confidence: 'high' as const,
    evidence: [],
  };
}

describe('API groupes — CRUD, appartenance, démarrage/arrêt ordonnés', () => {
  let panel: TestPanel;
  let admin: string;
  let machineId: string;
  let agent: FakeAgent;
  let a: string;
  let b: string;
  let c: string;
  let startOrder: string[];
  let stopOrder: string[];
  /** Serveurs dont le prochain `server.start` est refusé par le faux agent. */
  let refuse: Set<string>;

  const setRunState = (serverId: string, runState: 'running' | 'stopped'): void => {
    panel.ctx.db.update(servers).set({ runState }).where(eq(servers.id, serverId)).run();
  };

  beforeEach(async () => {
    panel = await createTestPanel({
      config: { heartbeatIntervalSec: 1 },
      groupWait: { startTimeoutMs: 5000, stopTimeoutMs: 5000, pollMs: 15 },
    });
    await panel.listen();
    admin = await setupAdmin(panel);
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'PC' },
      headers: { cookie: admin },
    });
    const body = res.json<{ machine: { id: string }; pairing: { code: string } }>();
    machineId = body.machine.id;
    const pairing = await connectFakeAgent(panel.wsUrl);
    const { secret } = await pairing.peer.request('pair.request', pairPayload(body.pairing.code));
    await pairing.close();
    a = (
      await panel.ctx.servers.adoptDetected(machineId, detected('/srv/a', 'A', 25_001), undefined)
    ).server!.id;
    b = (
      await panel.ctx.servers.adoptDetected(machineId, detected('/srv/b', 'B', 25_002), undefined)
    ).server!.id;
    c = (
      await panel.ctx.servers.adoptDetected(machineId, detected('/srv/c', 'C', 25_003), undefined)
    ).server!.id;

    startOrder = [];
    stopOrder = [];
    refuse = new Set();
    agent = await connectFakeAgent(panel.wsUrl);
    agent.peer
      .handle('agent.configure', () => ({ applied: true }))
      .handle('server.start', (payload) => {
        const { serverId } = payload;
        if (refuse.has(serverId)) {
          throw new ProtocolError('E_RAM_GUARD', 'not enough memory to start this server');
        }
        startOrder.push(serverId);
        // L'état `running` arrive après coup, comme le ferait un vrai `server.stateChanged`.
        setTimeout(() => {
          setRunState(serverId, 'running');
        }, 40);
        return { alreadyRunning: false, pid: 1234 };
      })
      .handle('server.stop', (payload) => {
        const { serverId } = payload;
        stopOrder.push(serverId);
        setTimeout(() => {
          setRunState(serverId, 'stopped');
        }, 40);
        return { alreadyStopped: false, forced: false };
      });
    await agent.peer.request('auth.hello', helloPayload(machineId, secret));
    await agent.peer.request('sync.state', { servers: [] });
  });
  afterEach(async () => {
    await agent.close().catch(() => undefined);
    await panel.close();
  });

  const api = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<LightMyRequestResponse> =>
    panel.app.inject({
      method,
      url,
      ...(payload === undefined
        ? {}
        : { payload: payload as NonNullable<InjectOptions['payload']> }),
      headers: { cookie: admin },
    });

  async function createGroup(name: string): Promise<string> {
    const res = await api('POST', '/api/groups', { name });
    expect(res.statusCode).toBe(201);
    return res.json<{ group: { id: string } }>().group.id;
  }

  async function fillGroup(): Promise<string> {
    const groupId = await createGroup('Réseau');
    for (const id of [a, b, c]) {
      const res = await api('PATCH', `/api/servers/${id}`, { groupId });
      expect(res.statusCode).toBe(200);
    }
    return groupId;
  }

  it('CRUD + appartenance : rang auto en fin de groupe, groupe inconnu refusé, suppression détachante', async () => {
    const groupId = await createGroup('Réseau');
    // Nom déjà pris (insensible à la casse) : refus explicite.
    expect((await api('POST', '/api/groups', { name: 'réseau' })).statusCode).toBe(409);
    // Rang automatique : chaque nouveau membre passe en fin de groupe.
    await api('PATCH', `/api/servers/${a}`, { groupId });
    await api('PATCH', `/api/servers/${b}`, { groupId });
    expect(panel.ctx.servers.require(a).groupPosition).toBe(0);
    expect(panel.ctx.servers.require(b).groupPosition).toBe(1);
    // Rang explicite conservé ; groupe inconnu → 404.
    await api('PATCH', `/api/servers/${c}`, { groupId, groupPosition: 5 });
    expect(panel.ctx.servers.require(c).groupPosition).toBe(5);
    expect((await api('PATCH', `/api/servers/${a}`, { groupId: 'nope' })).statusCode).toBe(404);
    expect(panel.ctx.servers.listByGroup(groupId).map((s) => s.id)).toEqual([a, b, c]);
    // Le DTO expose le groupe (l'UI de la flotte s'en sert).
    const dto = (await api('GET', `/api/servers/${a}`)).json<{
      server: { groupId: string; groupPosition: number };
    }>().server;
    expect(dto.groupId).toBe(groupId);
    expect(dto.groupPosition).toBe(0);
    // Renommage, liste, puis suppression : les membres sont détachés, jamais supprimés.
    expect((await api('PATCH', `/api/groups/${groupId}`, { name: 'Prod' })).statusCode).toBe(200);
    const list = (await api('GET', '/api/groups')).json<{ groups: { name: string }[] }>();
    expect(list.groups.map((g) => g.name)).toEqual(['Prod']);
    expect((await api('DELETE', `/api/groups/${groupId}`)).statusCode).toBe(204);
    expect(panel.ctx.servers.require(a).groupId).toBeNull();
    expect(panel.ctx.servers.require(a).name).toBe('A');
  });

  it('start ascendant en attendant `running`, stop descendant, E_BUSY pendant l’action', async () => {
    const groupId = await fillGroup();
    // Groupe vide : refus (on vide un groupe jetable pour le vérifier).
    const empty = await createGroup('Vide');
    expect((await api('POST', `/api/groups/${empty}/action`, { action: 'start' })).statusCode).toBe(
      409,
    );

    let res = await api('POST', `/api/groups/${groupId}/action`, { action: 'start' });
    expect(res.statusCode).toBe(202);
    // Une seconde action pendant la première : E_BUSY (503 dans ce dépôt).
    res = await api('POST', `/api/groups/${groupId}/action`, { action: 'restart' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('E_BUSY');

    await waitFor(() => panel.ctx.servers.require(c).runState === 'running', 5000);
    // Ordre strict : chaque serveur n'est demandé qu'une fois le précédent en marche.
    expect(startOrder).toEqual([a, b, c]);
    expect(panel.ctx.servers.require(a).desiredState).toBe('running');
    await waitFor(() => !panel.ctx.groups.isRunning(groupId), 5000);

    // Arrêt : ordre inverse, `desired_state` posé à `stopped`.
    res = await api('POST', `/api/groups/${groupId}/action`, { action: 'stop' });
    expect(res.statusCode).toBe(202);
    await waitFor(() => panel.ctx.servers.require(a).runState === 'stopped', 5000);
    expect(stopOrder).toEqual([c, b, a]);
    expect(panel.ctx.servers.require(c).desiredState).toBe('stopped');
    await waitFor(() => !panel.ctx.groups.isRunning(groupId), 5000);
  });

  it('série interrompue au premier refus : suivants non tentés, échec signalé, desired honnête', async () => {
    const groupId = await fillGroup();
    refuse.add(b);
    const res = await api('POST', `/api/groups/${groupId}/action`, { action: 'start' });
    expect(res.statusCode).toBe(202);
    await waitFor(() => !panel.ctx.groups.isRunning(groupId), 5000);
    // A démarré, B refusé, C jamais tenté.
    expect(startOrder).toEqual([a]);
    expect(panel.ctx.servers.require(a).runState).toBe('running');
    expect(panel.ctx.servers.require(c).runState).toBe('stopped');
    expect(panel.ctx.servers.require(c).desiredState).toBe('stopped');
    // Le refus n'a pas laissé `desired_state=running` mentir sur B…
    expect(panel.ctx.servers.require(b).desiredState).toBe('stopped');
    // …et il est signalé (notification « démarrage échoué », avec le nom du groupe).
    const failed = panel.ctx.db
      .select()
      .from(events)
      .where(inArray(events.type, ['server.startFailed']))
      .all();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.serverId).toBe(b);
    expect(failed[0]?.payload).toContain('Réseau');
  });
});
