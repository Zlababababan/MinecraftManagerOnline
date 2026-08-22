/**
 * Phase 7 — `metrics.sample` d'un agent → `metrics.db` + diffusion `/ws/client`, API métriques
 * serveur/machine (résolution, dernier échantillon, sources), `watchdog.alert` → événement + audit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ulid } from '@mmo/protocol';
import type { ServerMetricsResult } from '@mmo/protocol/client';

import {
  connectClient,
  connectFakeAgent,
  createTestPanel,
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
    loader: { value: 'forge' as const, confidence: 'high' as const, source: 'jar_name' },
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

describe('API phase 7 — métriques et alertes watchdog', () => {
  let panel: TestPanel;
  let admin: string;
  let serverId: string;
  let machineId: string;
  let agent: FakeAgent;

  beforeEach(async () => {
    panel = await createTestPanel({ config: { heartbeatIntervalSec: 1 } });
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
    const adopted = await panel.ctx.servers.adoptDetected(
      machineId,
      detected('/srv/a', 'A'),
      undefined,
    );
    serverId = adopted.server!.id;
    agent = await connectFakeAgent(panel.wsUrl);
    agent.peer.handle('agent.configure', () => ({ applied: true }));
    agent.peer.handle('event.ack', () => ({}));
    await agent.peer.request('auth.hello', helloPayload(machineId, secret));
    await agent.peer.request('sync.state', { servers: [] });
  });
  afterEach(async () => {
    await agent.close().catch(() => undefined);
    await panel.close();
  });

  it('metrics.sample → metrics.db (lots), diffusion aux navigateurs, API brut / 1 min, sources', async () => {
    const client = await connectClient(panel.wsUrl, admin);
    const t = panel.clock.now();
    for (let i = 0; i < 8; i++) {
      agent.peer.emit('metrics.sample', {
        ts: t - (8 - i) * 15_000,
        machine: { cpuPct: 10 + i, ramUsedMb: 4000 + i, ramTotalMb: 8192 },
        servers: [
          {
            serverId,
            cpuPct: 50 + i,
            rssMb: 1500,
            tps: 19.5,
            mspt: 12,
            tpsSource: 'forge',
            players: 2,
          },
          // Serveur inconnu du panel : ignoré
          { serverId: 'srv_ghost', cpuPct: 1, players: 0 },
        ],
        cpuSource: 'ticks',
      });
    }
    await waitFor(
      () =>
        client.messages.filter((m) => (m as { type: string }).type === 'metrics.sample').length ===
        8,
    );
    const live = client.messages.find((m) => (m as { type: string }).type === 'metrics.sample') as {
      machineId: string;
      sample: { servers: { serverId: string }[] };
    };
    expect(live.machineId).toBe(machineId);
    expect(live.sample.servers.map((s) => s.serverId)).toEqual([serverId]);

    let res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/metrics?from=${String(t - 3_600_000)}`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.json<ServerMetricsResult>();
    expect(raw.resolution).toBe('raw');
    expect(raw.points).toHaveLength(8);
    expect(raw.points[0]).toMatchObject({ cpu: 50, ram: 1500, tps: 19.5, mspt: 12, players: 2 });
    expect(raw.latest).toMatchObject({ ts: t - 15_000, cpu: 57 });
    expect(raw.tpsSource).toBe('forge');
    expect(raw.cpuSource).toBe('ticks');

    // Downsampling par le job de maintenance : minutes complètes en 1 min
    panel.clock.advance(3_600_000);
    panel.ctx.metricsService.maintain(panel.clock.now());
    res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/metrics?from=${String(t - 7_200_000)}&resolution=1m`,
      headers: { cookie: admin },
    });
    const minutes = res.json<ServerMetricsResult>();
    expect(minutes.resolution).toBe('1m');
    expect(minutes.points.length).toBeGreaterThanOrEqual(2);
    expect(minutes.points.reduce((n, p) => n + (p.samples ?? 0), 0)).toBe(8);

    res = await panel.app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/metrics?from=${String(t - 3_600_000)}&to=${String(t)}`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ points: unknown[]; cpuSource: string }>()).toMatchObject({
      resolution: 'raw',
      cpuSource: 'ticks',
    });
    expect(res.json<{ points: unknown[] }>().points).toHaveLength(8);

    // Validation : `from` obligatoire, résolution inconnue refusée, serveur inconnu = 404
    res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/metrics`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(400);
    res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/nope/metrics?from=0`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(404);
    res = await panel.app.inject({ method: 'GET', url: `/api/servers/${serverId}/metrics?from=0` });
    expect(res.statusCode).toBe(401);

    // Agent déconnecté : le « maintenant » est oublié, l'historique reste
    await agent.close();
    await waitFor(() => !panel.ctx.registry.get(machineId));
    res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/metrics?from=${String(t - 3_600_000)}&to=${String(t)}`,
      headers: { cookie: admin },
    });
    expect(res.json<ServerMetricsResult>()).toMatchObject({ latest: null, tpsSource: null });
    expect(res.json<ServerMetricsResult>().points).toHaveLength(8);
    client.close();
  });

  it('watchdog.alert → événement (sévérité) + audit des actions automatiques, acquitté', async () => {
    const acked: string[] = [];
    agent.peer.handle('event.ack', ({ eventIds }) => {
      acked.push(...eventIds);
      return {};
    });
    const id1 = ulid();
    agent.peer.emit(
      'watchdog.alert',
      {
        eventId: id1,
        serverId,
        ts: panel.clock.now(),
        kind: 'crash',
        action: 'restart',
        attempt: 1,
        detail: 'out_of_memory',
      },
      { id: id1 },
    );
    const id2 = ulid();
    agent.peer.emit(
      'watchdog.alert',
      {
        eventId: id2,
        serverId,
        ts: panel.clock.now(),
        kind: 'crash_loop',
        action: 'gave_up',
        attempt: 3,
      },
      { id: id2 },
    );
    const id3 = ulid();
    agent.peer.emit(
      'watchdog.alert',
      { eventId: id3, serverId, ts: panel.clock.now(), kind: 'ram', action: 'none', attempt: 0 },
      { id: id3 },
    );
    await waitFor(() => acked.length === 3);
    const events = panel.ctx.events.list({ serverId, type: 'watchdog.alert' });
    expect(events.map((e) => [e.severity, (e.payload as { kind: string }).kind])).toEqual([
      ['warning', 'ram'],
      ['critical', 'crash_loop'],
      ['warning', 'crash'],
    ]);
    const audit = panel.ctx.audit.list().filter((a) => a.action.startsWith('watchdog.'));
    expect(audit.map((a) => a.action)).toEqual(['watchdog.gave_up', 'watchdog.restart']);
    expect(audit[1]).toMatchObject({
      targetType: 'server',
      targetId: serverId,
      targetLabel: 'A',
      userId: null,
      details: { kind: 'crash', attempt: 1, detail: 'out_of_memory' },
    });
  });
});
