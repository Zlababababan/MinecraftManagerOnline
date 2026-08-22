/**
 * Phase 6 — relais REST vers l'agent : configuration typée, explorateur de fichiers, journaux,
 * actions joueurs, historique `player_sessions`. Faux agent = `RpcPeer` rôle `agent` qui enregistre
 * les requêtes reçues.
 */
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ulid } from '@mmo/protocol';

import {
  connectFakeAgent,
  createTestPanel,
  createUser,
  helloPayload,
  pairPayload,
  setupAdmin,
  waitFor,
  type FakeAgent,
  type TestPanel,
} from '../test/helpers.js';

function detected(path: string, name: string) {
  return {
    path,
    name,
    loader: { value: 'vanilla' as const, confidence: 'high' as const, source: 'jar_name' },
    mcVersion: { value: '1.20.1', confidence: 'high' as const, source: 'jar_manifest' },
    maxRamMb: { value: 2048, confidence: 'medium' as const, source: 'run_script' },
    gamePort: 25565,
    eulaAccepted: true,
    launch: { kind: 'jar' as const, jar: 'server.jar' },
    javaRequirement: { majorVersion: 17, strict: false, source: 'table' as const },
    confidence: 'high' as const,
    evidence: [],
  };
}

describe('API phase 6 — config / fichiers / logs / joueurs relayés à l’agent', () => {
  let panel: TestPanel;
  let admin: string;
  let viewer: string;
  let serverId: string;
  let machineId: string;
  let agent: FakeAgent;
  let received: { type: string; payload: unknown }[];

  beforeEach(async () => {
    panel = await createTestPanel({ config: { heartbeatIntervalSec: 1 } });
    await panel.listen();
    admin = await setupAdmin(panel);
    viewer = await createUser(panel, admin, {
      username: 'viewer',
      password: 'correct horse battery',
      role: 'viewer',
    });
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
    const adopted = await panel.ctx.servers.adoptDetected(
      machineId,
      detected('/srv/a', 'A'),
      undefined,
    );
    serverId = adopted.server!.id;

    received = [];
    agent = await connectFakeAgent(panel.wsUrl);
    const record = <T>(type: string, value: T) => {
      return (payload: unknown): T => {
        received.push({ type, payload });
        return value;
      };
    };
    agent.peer
      .handle('agent.configure', () => ({ applied: true }))
      .handle(
        'config.get',
        record('config.get', {
          file: 'whitelist.json' as const,
          data: [{ uuid: '00000000-0000-3000-8000-000000000001', name: 'Bob' }],
          sha256: 'a'.repeat(64),
          source: 'file' as const,
        }),
      )
      .handle(
        'config.set',
        record('config.set', {
          applied: 'commands' as const,
          restartRequired: false,
          commands: ['whitelist add Carol'],
        }),
      )
      .handle(
        'fs.list',
        record('fs.list', {
          entries: [
            { name: 'world', kind: 'dir' as const, modifiedAt: 1 },
            { name: 'server.properties', kind: 'file' as const, size: 12, modifiedAt: 2 },
          ],
        }),
      )
      .handle(
        'fs.read',
        record('fs.read', {
          content: 'motd=Hi\n',
          encoding: 'utf8' as const,
          sha256: 'b'.repeat(64),
          size: 8,
          truncated: false,
        }),
      )
      .handle('fs.write', record('fs.write', { sha256: 'c'.repeat(64) }))
      .handle('fs.mkdir', record('fs.mkdir', {}))
      .handle('fs.rename', record('fs.rename', {}))
      .handle('fs.delete', record('fs.delete', { trashedAs: '.mmo-trash/1-x' }))
      .handle(
        'logs.listFiles',
        record('logs.listFiles', {
          files: [{ name: 'latest.log', sizeBytes: 10, modifiedAt: 3 }],
        }),
      )
      .handle(
        'logs.search',
        record('logs.search', {
          matches: [{ file: 'latest.log', line: 1, text: 'Done' }],
          truncated: false,
        }),
      )
      .handle(
        'player.resolve',
        record('player.resolve', {
          players: [{ name: 'Carol', uuid: null, source: 'unknown' as const }],
          onlineMode: true,
        }),
      )
      .handle(
        'player.action',
        record('player.action', { applied: 'commands' as const, response: 'Kicked Carol' }),
      );
    await agent.peer.request('auth.hello', helloPayload(machineId, secret));
    await agent.peer.request('sync.state', { servers: [] });
  });
  afterEach(async () => {
    await agent.close().catch(() => undefined);
    await panel.close();
  });

  const get = (url: string, cookie = admin): Promise<LightMyRequestResponse> =>
    panel.app.inject({ method: 'GET', url, headers: { cookie } });
  const send = (
    method: 'POST' | 'PUT',
    url: string,
    payload: unknown,
    cookie = admin,
  ): Promise<LightMyRequestResponse> =>
    panel.app.inject({
      method,
      url,
      payload: payload as NonNullable<InjectOptions['payload']>,
      headers: { cookie },
    });

  it('config.get/set : relais, validation du nom de fichier, RBAC opérateur, audit + événement', async () => {
    let res = await get(`/api/servers/${serverId}/config/whitelist.json`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ file: 'whitelist.json', source: 'file' });
    expect(received.at(-1)).toEqual({
      type: 'config.get',
      payload: { serverId, file: 'whitelist.json' },
    });
    res = await get(`/api/servers/${serverId}/config/passwd`);
    expect(res.statusCode).toBe(400);

    res = await send(
      'PUT',
      `/api/servers/${serverId}/config/whitelist.json`,
      { data: [{ uuid: 'u', name: 'Carol' }], expectedSha256: 'a'.repeat(64) },
      viewer,
    );
    expect(res.statusCode).toBe(403);
    res = await send('PUT', `/api/servers/${serverId}/config/whitelist.json`, {
      data: [{ uuid: 'u', name: 'Carol' }],
      expectedSha256: 'a'.repeat(64),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 'commands', commands: ['whitelist add Carol'] });
    expect(received.at(-1)).toEqual({
      type: 'config.set',
      payload: {
        serverId,
        file: 'whitelist.json',
        data: [{ uuid: 'u', name: 'Carol' }],
        expectedSha256: 'a'.repeat(64),
      },
    });
    const events = await get(`/api/events?serverId=${serverId}`);
    expect(events.json<{ events: { type: string }[] }>().events.map((e) => e.type)).toContain(
      'server.configChanged',
    );
    const audit = await get('/api/audit');
    expect(audit.json<{ audit: { action: string }[] }>().audit[0]).toMatchObject({
      action: 'server.configChanged',
    });
  });

  it('fs.* : liste, lecture, écriture, mkdir, rename, corbeille ; chemins jailés refusés par le schéma', async () => {
    let res = await get(`/api/servers/${serverId}/files`);
    expect(res.json()).toEqual({
      path: '',
      entries: [
        { name: 'world', kind: 'dir', modifiedAt: 1 },
        { name: 'server.properties', kind: 'file', size: 12, modifiedAt: 2 },
      ],
    });
    await get(`/api/servers/${serverId}/files?path=world/region`);
    expect(received.at(-1)).toEqual({
      type: 'fs.list',
      payload: { serverId, path: 'world/region' },
    });
    res = await get(`/api/servers/${serverId}/files?path=../etc`);
    expect(res.statusCode).toBe(400);
    res = await get(`/api/servers/${serverId}/files/read?path=server.properties`);
    expect(res.json()).toMatchObject({ content: 'motd=Hi\n', truncated: false });
    res = await send('PUT', `/api/servers/${serverId}/files/write`, {
      path: 'server.properties',
      content: 'motd=Bye\n',
      expectedSha256: 'b'.repeat(64),
    });
    expect(res.json()).toEqual({ sha256: 'c'.repeat(64) });
    res = await send('POST', `/api/servers/${serverId}/files/mkdir`, { path: 'plugins' });
    expect(res.statusCode).toBe(204);
    res = await send('POST', `/api/servers/${serverId}/files/rename`, {
      from: 'plugins',
      to: 'mods',
    });
    expect(res.statusCode).toBe(204);
    res = await send('POST', `/api/servers/${serverId}/files/delete`, { path: 'mods' });
    expect(res.json()).toEqual({ trashedAs: '.mmo-trash/1-x' });
    res = await send('POST', `/api/servers/${serverId}/files/delete`, { path: 'mods' }, viewer);
    expect(res.statusCode).toBe(403);
    expect(received.map((r) => r.type)).toEqual([
      'fs.list',
      'fs.list',
      'fs.read',
      'fs.write',
      'fs.mkdir',
      'fs.rename',
      'fs.delete',
    ]);
    const audit = await get('/api/audit');
    expect(
      audit
        .json<{ audit: { action: string }[] }>()
        .audit.map((e) => e.action)
        .slice(0, 4),
    ).toEqual([
      'server.fileDeleted',
      'server.fileRename',
      'server.fileMkdir',
      'server.fileWritten',
    ]);
  });

  it('logs : liste et recherche relayées (lecture seule, viewer autorisé)', async () => {
    let res = await get(`/api/servers/${serverId}/logs`, viewer);
    expect(res.json()).toEqual({ files: [{ name: 'latest.log', sizeBytes: 10, modifiedAt: 3 }] });
    res = await send(
      'POST',
      `/api/servers/${serverId}/logs/search`,
      { query: 'Done', regex: false, limit: 10 },
      viewer,
    );
    expect(res.json()).toMatchObject({ matches: [{ file: 'latest.log', line: 1 }] });
    expect(received.at(-1)).toEqual({
      type: 'logs.search',
      payload: { serverId, query: 'Done', regex: false, limit: 10 },
    });
  });

  it('joueurs : résolution, action (RBAC + audit + événement), historique des sessions', async () => {
    let res = await send('POST', `/api/servers/${serverId}/players/resolve`, { names: ['Carol'] });
    expect(res.json()).toMatchObject({ onlineMode: true, players: [{ name: 'Carol' }] });
    res = await send(
      'POST',
      `/api/servers/${serverId}/players/action`,
      { action: 'kick', target: 'Carol', reason: 'afk' },
      viewer,
    );
    expect(res.statusCode).toBe(403);
    res = await send('POST', `/api/servers/${serverId}/players/action`, {
      action: 'kick',
      target: 'Carol',
      reason: 'afk',
    });
    expect(res.json()).toEqual({ applied: 'commands', response: 'Kicked Carol' });
    expect(received.at(-1)).toEqual({
      type: 'player.action',
      payload: { serverId, action: 'kick', target: 'Carol', reason: 'afk' },
    });
    res = await send('POST', `/api/servers/${serverId}/players/action`, {
      action: 'nuke',
      target: 'Carol',
    });
    expect(res.statusCode).toBe(400);
    const audit = await get('/api/audit');
    expect(audit.json<{ audit: { action: string }[] }>().audit[0]).toMatchObject({
      action: 'player.kick',
    });

    // Historique : join/leave via événements agent, clôture sur arrêt.
    const ts = panel.clock.now();
    agent.peer.emit(
      'player.event',
      { eventId: ulid(ts), serverId, ts, kind: 'join', name: 'Alice', online: 1 },
      { id: ulid(ts) },
    );
    await waitFor(() => panel.ctx.servers.onlinePlayers(serverId).length === 1);
    panel.clock.advance(60_000);
    const later = panel.clock.now();
    agent.peer.emit(
      'player.event',
      {
        eventId: ulid(later),
        serverId,
        ts: later,
        kind: 'join',
        name: 'Bob',
        uuid: '00000000-0000-4000-8000-000000000002',
        online: 2,
      },
      { id: ulid(later) },
    );
    await waitFor(() => panel.ctx.servers.onlinePlayers(serverId).length === 2);
    res = await get(`/api/servers/${serverId}/players/history?limit=10`, viewer);
    const history = res.json<{
      sessions: { playerName: string; playerUuid: string | null; leftAt: number | null }[];
    }>().sessions;
    expect(history).toEqual([
      {
        id: expect.any(Number) as number,
        playerName: 'Bob',
        playerUuid: '00000000-0000-4000-8000-000000000002',
        joinedAt: later,
        leftAt: null,
      },
      {
        id: expect.any(Number) as number,
        playerName: 'Alice',
        playerUuid: null,
        joinedAt: ts,
        leftAt: null,
      },
    ]);
    const closedAt = later + 1000;
    panel.ctx.servers.closePlayerSessions(serverId, closedAt);
    res = await get(`/api/servers/${serverId}/players/history`);
    expect(
      res.json<{ sessions: { leftAt: number | null }[] }>().sessions.map((s) => s.leftAt),
    ).toEqual([closedAt, closedAt]);
  });

  it('agent hors ligne → E_AGENT_OFFLINE (503)', async () => {
    await agent.close();
    await waitFor(() => !panel.ctx.registry.isConnected(machineId));
    const res = await get(`/api/servers/${serverId}/config/server.properties`);
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('E_AGENT_OFFLINE');
  });
});
