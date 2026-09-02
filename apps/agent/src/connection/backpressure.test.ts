/**
 * Lot 9 — contre-pression côté agent : quand le panel ne lit plus, les échantillons et lignes de
 * console sont abandonnés, les autres événements passent. Le seuil est abaissé sous zéro pour que
 * n'importe quel `bufferedAmount` (même 0) déclenche l'abandon — le socket de test ne sature pas.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BACKPRESSURE, PROTOCOL_VERSION, type EventPayload } from '@mmo/protocol';

import { Logger } from '../log.js';
import { StateStore } from '../state/store.js';
import {
  createFakePanel,
  tmpDir,
  waitFor,
  type FakePanel,
  type PanelPeer,
} from '../test/helpers.js';
import { AgentConnection } from './connection.js';

const SECRET = 'b'.repeat(64);
const SAMPLE: EventPayload<'metrics.sample'> = {
  ts: 1_787_300_000_000,
  machine: { cpuPct: 1, ramUsedMb: 100, ramTotalMb: 1000 },
  servers: [],
};

describe('contre-pression agent → panel', () => {
  let stateDir: string;
  let cleanup: () => Promise<void>;
  let panel: FakePanel | undefined;
  let conn: AgentConnection | undefined;
  const received: string[] = [];

  beforeEach(async () => {
    ({ dir: stateDir, cleanup } = await tmpDir('mmo-bp-'));
    received.length = 0;
  });
  afterEach(async () => {
    await conn?.stop();
    await panel?.close();
    await cleanup();
  });

  const behaviour = (peer: PanelPeer) => {
    peer.handle('auth.hello', () => ({
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalSec: 60,
      wantFullSync: false,
      subscriptions: [],
      compression: 'gzip' as const,
    }));
    peer.on('metrics.sample', () => {
      received.push('metrics.sample');
    });
    peer.on('agent.log', () => {
      received.push('agent.log');
    });
  };

  async function connect(backpressure?: { dropAboveBytes: number; closeAboveBytes: number }) {
    panel = await createFakePanel(behaviour);
    const store = new StateStore(stateDir, { restrictPermissions: false });
    await store.load();
    await store.update((s) => {
      s.agentId = 'agt_bp';
      s.agentSecret = SECRET;
      s.panelUrl = panel!.url;
    });
    conn = new AgentConnection({
      panelUrl: panel.url,
      store,
      logger: new Logger('test', { stderr: false }),
      agentVersion: '1.0.8-test',
      registerHandlers: () => undefined,
      buildSyncState: () => ({
        servers: [],
        tasks: [],
        seqs: {},
        portsInUse: [],
        javaRuntimes: [],
      }),
      buildHeartbeat: () => ({ ts: Date.now(), activeServers: 0, activeTasks: 0 }),
      backoff: { baseMs: 50, maxMs: 200 },
      ...(backpressure === undefined ? {} : { backpressure }),
    });
    conn.start();
    await waitFor(() => conn!.isConnected, 5000);
    return conn;
  }

  it('sous pression : les échantillons sont abandonnés, les autres événements passent', async () => {
    const c = await connect({ dropAboveBytes: -1, closeAboveBytes: Number.MAX_SAFE_INTEGER });
    c.emit('metrics.sample', SAMPLE);
    c.emit('agent.log', { ts: Date.now(), level: 'INFO', message: 'still here' });
    await waitFor(() => received.includes('agent.log'), 5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toEqual(['agent.log']);
  });

  it('sans pression (seuils par défaut) : tout passe', async () => {
    const c = await connect();
    expect(BACKPRESSURE.dropAboveBytes).toBeGreaterThan(0);
    c.emit('metrics.sample', SAMPLE);
    c.emit('agent.log', { ts: Date.now(), level: 'INFO', message: 'still here' });
    await waitFor(() => received.length >= 2, 5000);
    expect(received.sort()).toEqual(['agent.log', 'metrics.sample']);
  });
});
