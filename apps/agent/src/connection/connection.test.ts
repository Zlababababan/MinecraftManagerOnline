import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  ProtocolError,
  type EventPayload,
  type RequestPayload,
} from '@mmo/protocol';

import { Logger } from '../log.js';
import { StateStore } from '../state/store.js';
import {
  createFakePanel,
  sleep,
  tmpDir,
  waitFor,
  type FakePanel,
  type PanelPeer,
} from '../test/helpers.js';
import { AgentConnection, supportedCompression } from './connection.js';

const logger = new Logger('test', { stderr: false });
const SECRET = 'a'.repeat(64);

interface PanelLog {
  pairs: RequestPayload<'pair.request'>[];
  hellos: RequestPayload<'auth.hello'>[];
  syncs: RequestPayload<'sync.state'>[];
  heartbeats: EventPayload<'agent.heartbeat'>[];
  events: { type: string; id: string | undefined; payload: unknown }[];
}

function panelBehaviour(
  log: PanelLog,
  opts: { wantFullSync?: boolean; rejectAuth?: boolean; heartbeatSec?: number } = {},
) {
  return (peer: PanelPeer) => {
    peer.handle('pair.request', (p) => {
      log.pairs.push(p);
      if (p.code !== 'MMOP-OK') throw new ProtocolError('E_PAIRING_CODE_INVALID', 'bad code');
      return { agentId: 'agt_1', secret: SECRET };
    });
    peer.handle('auth.hello', (p) => {
      log.hellos.push(p);
      if (opts.rejectAuth || p.agentSecret !== SECRET) throw new ProtocolError('E_AUTH', 'nope');
      return {
        protocolVersion: PROTOCOL_VERSION,
        heartbeatIntervalSec: opts.heartbeatSec ?? 1,
        wantFullSync: opts.wantFullSync ?? true,
        subscriptions: [{ channel: 'console:srv_1', sinceSeq: 3 }],
        compression: p.compression?.includes('zstd') ? 'zstd' : 'gzip',
      };
    });
    peer.handle('sync.state', (p) => {
      log.syncs.push(p);
      return {};
    });
    peer.on('agent.heartbeat', (p) => {
      log.heartbeats.push(p);
    });
    for (const type of ['server.stateChanged', 'server.detected', 'agent.log'] as const) {
      peer.on(type, (payload, ctx) => {
        log.events.push({ type, id: ctx.id, payload });
      });
    }
  };
}

describe('session panel↔agent (doc 05 §3–5, §10)', () => {
  let stateDir: string;
  let cleanup: () => Promise<void>;
  let panel: FakePanel | undefined;
  let conn: AgentConnection | undefined;
  let log: PanelLog;

  beforeEach(async () => {
    ({ dir: stateDir, cleanup } = await tmpDir('mmo-conn-'));
    log = { pairs: [], hellos: [], syncs: [], heartbeats: [], events: [] };
  });
  afterEach(async () => {
    await conn?.stop();
    await panel?.close();
    await cleanup();
  });

  function makeConnection(
    store: StateStore,
    over: Partial<ConstructorParameters<typeof AgentConnection>[0]> = {},
  ): AgentConnection {
    const c = new AgentConnection({
      panelUrl: panel!.url,
      store,
      logger,
      agentVersion: '0.3.0-test',
      registerHandlers: () => undefined,
      buildSyncState: () => ({
        servers: [],
        tasks: [],
        seqs: { 'console:srv_1': 7 },
        portsInUse: [],
        javaRuntimes: [],
      }),
      buildHeartbeat: () => ({ ts: Date.now(), activeServers: 0, activeTasks: 0 }),
      backoff: { baseMs: 50, maxMs: 200 },
      ...over,
    });
    conn = c;
    return c;
  }

  it('appaire (code valide), persiste l’identité, se reconnecte et s’authentifie, sync.state, heartbeat', async () => {
    panel = await createFakePanel(panelBehaviour(log));
    const store = new StateStore(stateDir, { restrictPermissions: false });
    await store.load();
    const sessions: string[] = [];
    const c = makeConnection(store, {
      pairCode: 'MMOP-OK',
      onSession: (s) => {
        sessions.push(`v${String(s.protocolVersion)}:${s.compression ?? '-'}`);
      },
    });
    c.start();
    await waitFor(() => c.isConnected, 5000);
    expect(log.pairs).toHaveLength(1);
    expect(log.pairs[0]?.machine.hostname).toBeTruthy();
    expect(store.get().agentId).toBe('agt_1');
    expect(store.get().agentSecret).toBe(SECRET);
    expect(log.hellos).toHaveLength(1);
    expect(log.hellos[0]).toMatchObject({
      agentId: 'agt_1',
      protoMin: PROTOCOL_VERSION,
      protoMax: PROTOCOL_VERSION,
      capabilities: ['rcon'],
    });
    expect(log.hellos[0]?.compression).toEqual(supportedCompression());
    expect(log.syncs).toHaveLength(1);
    expect(log.syncs[0]?.seqs).toEqual({ 'console:srv_1': 7 });
    expect(sessions).toEqual([
      `v${String(PROTOCOL_VERSION)}:${supportedCompression().includes('zstd') ? 'zstd' : 'gzip'}`,
    ]);
    expect(c.currentSession?.subscriptions).toEqual([{ channel: 'console:srv_1', sinceSeq: 3 }]);
    await waitFor(() => log.heartbeats.length >= 2, 5000);
  });

  it('code d’appairage invalide : E_PAIRING_CODE_INVALID, pas d’identité, nouvelle tentative en backoff', async () => {
    panel = await createFakePanel(panelBehaviour(log));
    const store = new StateStore(stateDir, { restrictPermissions: false });
    await store.load();
    const c = makeConnection(store, { pairCode: 'MMOP-BAD' });
    c.start();
    await waitFor(() => log.pairs.length >= 2, 5000);
    expect(store.get().agentId).toBeUndefined();
    expect(c.isConnected).toBe(false);
    expect(c.lastConnectionError).toContain('bad code');
  });

  it('reconnexion après coupure, avec rejeu des événements critiques jusqu’à event.ack', async () => {
    panel = await createFakePanel(panelBehaviour(log));
    const store = new StateStore(stateDir, { restrictPermissions: false });
    await store.load();
    await store.update((s) => {
      s.agentId = 'agt_1';
      s.agentSecret = SECRET;
    });
    const c = makeConnection(store);
    c.start();
    await waitFor(() => c.isConnected, 5000);

    // Événement critique émis en ligne : journalisé, id d'enveloppe = eventId
    const id1 = c.emit('server.stateChanged', (eventId) => ({
      eventId,
      serverId: 'srv_1',
      ts: Date.now(),
      state: 'running',
    }));
    expect(id1).toBeDefined();
    await waitFor(() => log.events.length === 1);
    expect(log.events[0]).toMatchObject({ type: 'server.stateChanged', id: id1 });
    expect((log.events[0]?.payload as { eventId: string }).eventId).toBe(id1);
    expect(store.get().pendingEvents.map((e) => e.id)).toEqual([id1]);

    // Non critique : pas journalisé
    c.emit('agent.log', { ts: Date.now(), level: 'INFO', message: 'x' });
    await waitFor(() => log.events.length === 2);
    expect(store.get().pendingEvents).toHaveLength(1);

    // Coupure : émission hors ligne journalisée, puis rejouée à la reconnexion
    panel.dropAll();
    await waitFor(() => !c.isConnected);
    const id2 = c.emit('server.stateChanged', (eventId) => ({
      eventId,
      serverId: 'srv_1',
      ts: Date.now(),
      state: 'stopped',
    }));
    await waitFor(() => c.isConnected, 5000);
    await waitFor(() => log.events.filter((e) => e.id === id2).length === 1, 5000);
    // id1 rejoué aussi (jamais acquitté)
    expect(log.events.filter((e) => e.id === id1).length).toBe(2);
    expect(log.hellos).toHaveLength(2);

    // Acquittement : retiré du journal
    const peer = panel.peers.at(-1)!;
    await peer.request('event.ack', { eventIds: [id1!, id2!] });
    await waitFor(() => store.get().pendingEvents.length === 0);
  });

  it('E_AUTH (secret révoqué) : pas de session, réessais au rythme maximal', async () => {
    panel = await createFakePanel(panelBehaviour(log, { rejectAuth: true }));
    const store = new StateStore(stateDir, { restrictPermissions: false });
    await store.load();
    await store.update((s) => {
      s.agentId = 'agt_1';
      s.agentSecret = SECRET;
    });
    const c = makeConnection(store, { backoff: { baseMs: 20, maxMs: 100 } });
    c.start();
    await waitFor(() => log.hellos.length >= 2, 5000);
    expect(c.isConnected).toBe(false);
    expect(log.syncs).toHaveLength(0);
  });

  it('panel absent : backoff, puis connexion dès qu’il apparaît', async () => {
    const store = new StateStore(stateDir, { restrictPermissions: false });
    await store.load();
    await store.update((s) => {
      s.agentId = 'agt_1';
      s.agentSecret = SECRET;
    });
    panel = await createFakePanel(panelBehaviour(log));
    const url = panel.url;
    await panel.close();
    const c = makeConnection(store, { panelUrl: url, backoff: { baseMs: 30, maxMs: 100 } });
    c.start();
    await sleep(250);
    expect(c.isConnected).toBe(false);
    // Le panel revient sur le même port
    const port = Number(new URL(url).port);
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port, path: '/ws/agent' });
    const { createRpcPeer } = await import('@mmo/protocol');
    wss.on('connection', (ws) => {
      const peer = createRpcPeer({
        role: 'panel',
        transport: {
          send: (d) => {
            ws.send(d);
          },
          onMessage: (h) => {
            ws.on('message', (d) => {
              h(typeof d === 'string' ? d : Buffer.from(d as Buffer).toString('utf8'));
            });
          },
          onClose: (h) => {
            ws.on('close', () => {
              h();
            });
          },
        },
      });
      panelBehaviour(log)(peer);
    });
    try {
      await waitFor(() => c.isConnected, 5000);
      expect(log.hellos).toHaveLength(1);
    } finally {
      await c.stop();
      await new Promise<void>((r) => {
        wss.close(() => {
          r();
        });
      });
    }
  });
});
