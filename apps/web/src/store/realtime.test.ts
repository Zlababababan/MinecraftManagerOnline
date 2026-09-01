import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';

import type { MachineDto, ServerDto } from '@mmo/protocol/client';

import { keys } from '../api/queries.js';
import { applyServerMessage, useRealtimeStore } from './realtime.js';

const server = (over: Partial<ServerDto> = {}): ServerDto => ({
  id: 's1',
  machineId: 'm1',
  directoryId: null,
  path: '/srv/a',
  name: 'A',
  loader: 'vanilla',
  mcVersion: '1.20.1',
  loaderVersion: null,
  detected: true,
  javaMajorRequired: 17,
  javaArgs: [],
  minRamMb: 1024,
  maxRamMb: 4096,
  gamePort: 25565,
  rconEnabled: false,
  rconPort: null,
  eulaAccepted: true,
  exposeMode: 'tailnet',
  provisioning: 'ready',
  runState: 'stopped',
  desiredState: 'stopped',
  attachMode: 'attached',
  lastExitReason: null,
  autoRestart: true,
  crashLoopMax: 3,
  watchdogFreezeS: 120,
  pid: null,
  startedAt: null,
  stoppedAt: null,
  createdAt: 1,
  updatedAt: 1,
  reachable: true,
  groupId: null,
  groupPosition: 0,
  ...over,
});

const machine = (over: Partial<MachineDto> = {}): MachineDto => ({
  id: 'm1',
  name: 'Tour',
  os: 'linux',
  arch: 'x64',
  hostname: 'h',
  agentVersion: '0.3.0',
  protocolVersion: 1,
  status: 'offline',
  connected: false,
  lastSeenAt: null,
  cpuModel: null,
  cpuCores: 4,
  ramTotalMb: 8192,
  createdAt: 1,
  watchedDirectories: [],
  ...over,
});

describe('applyServerMessage', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
    useRealtimeStore.getState().reset();
  });

  it('server.state met à jour la liste et le détail', () => {
    qc.setQueryData(keys.servers, { servers: [server()] });
    applyServerMessage(qc, { type: 'server.state', server: server({ runState: 'running' }) });
    expect(qc.getQueryData<{ servers: ServerDto[] }>(keys.servers)?.servers[0]?.runState).toBe(
      'running',
    );
    expect(qc.getQueryData<{ server: ServerDto }>(keys.server('s1'))?.server.runState).toBe(
      'running',
    );
    // Serveur inconnu : ajouté à la liste.
    applyServerMessage(qc, { type: 'server.state', server: server({ id: 's2' }) });
    expect(qc.getQueryData<{ servers: ServerDto[] }>(keys.servers)?.servers).toHaveLength(2);
  });

  it('machine.heartbeat enrichit la machine et la marque connectée', () => {
    qc.setQueryData(keys.machines, { machines: [machine()] });
    applyServerMessage(qc, {
      type: 'machine.heartbeat',
      machineId: 'm1',
      heartbeat: { ts: 5, cpuPct: 12, activeServers: 1, activeTasks: 0 },
    });
    const m = qc.getQueryData<{ machines: MachineDto[] }>(keys.machines)?.machines[0];
    expect(m).toMatchObject({ connected: true, status: 'online', heartbeat: { cpuPct: 12 } });
  });

  it('event alimente les événements récents (dédupliqués) et invalide les listes', () => {
    qc.setQueryData(keys.machines, { machines: [machine()] });
    const event = {
      id: 7,
      ts: 1,
      type: 'agent.online',
      severity: 'info' as const,
      machineId: 'm1',
      serverId: null,
      userId: null,
      payload: {},
    };
    applyServerMessage(qc, { type: 'event', event });
    applyServerMessage(qc, { type: 'event', event });
    expect(useRealtimeStore.getState().recentEvents).toHaveLength(1);
    expect(qc.getQueryState(keys.machines)?.isInvalidated).toBe(true);
  });

  it('metrics.sample ajoute le point aux plages brutes, met à jour « maintenant » partout', () => {
    const now = 1_000_000_000;
    qc.setQueryData(keys.serverMetrics('s1', '1h'), {
      resolution: 'raw',
      from: now - 3_600_000,
      to: now,
      points: [
        { ts: now - 3_600_000, cpu: 1, ram: 1, tps: null, players: 0 },
        { ts: now - 15_000, cpu: 5, ram: 100, tps: 20, players: 1 },
      ],
      latest: { ts: now - 15_000, cpu: 5, ram: 100, tps: 20, players: 1 },
      tpsSource: 'forge',
      cpuSource: 'cycles',
    });
    qc.setQueryData(keys.serverMetrics('s1', '24h'), {
      resolution: '1m',
      from: now - 86_400_000,
      to: now,
      points: [{ ts: now - 60_000, cpu: 3, ram: 90, tps: 20, players: 1, samples: 4 }],
      latest: { ts: now - 15_000, cpu: 5, ram: 100, tps: 20, players: 1 },
      tpsSource: 'forge',
      cpuSource: 'cycles',
    });
    qc.setQueryData(keys.machineMetrics('m1', '1h'), {
      resolution: 'raw',
      from: now - 3_600_000,
      to: now,
      points: [],
      latest: null,
      cpuSource: null,
    });
    applyServerMessage(qc, {
      type: 'metrics.sample',
      machineId: 'm1',
      sample: {
        ts: now + 15_000,
        machine: { cpuPct: 33, ramUsedMb: 8000 },
        servers: [
          { serverId: 's1', cpuPct: 7, rssMb: 110, tps: 19, tpsSource: 'forge', players: 2 },
        ],
        cpuSource: 'ticks',
      },
    });
    const raw = qc.getQueryData<{
      points: { ts: number }[];
      latest: { cpu: number };
      cpuSource: string;
    }>(keys.serverMetrics('s1', '1h'));
    // Point ajouté, plus ancien tombé hors de la fenêtre glissante d'une heure
    expect(raw?.points.map((p) => p.ts)).toEqual([now - 15_000, now + 15_000]);
    expect(raw?.latest).toMatchObject({ cpu: 7, ram: 110, tps: 19, players: 2 });
    expect(raw?.cpuSource).toBe('ticks');
    const agg = qc.getQueryData<{ points: unknown[]; latest: { cpu: number } }>(
      keys.serverMetrics('s1', '24h'),
    );
    expect(agg?.points).toHaveLength(1); // les plages agrégées ne reçoivent pas de point
    expect(agg?.latest).toMatchObject({ cpu: 7 });
    const machine = qc.getQueryData<{ points: { cpu: number | null }[]; latest: { ram: number } }>(
      keys.machineMetrics('m1', '1h'),
    );
    expect(machine?.points).toEqual([
      { ts: now + 15_000, cpu: 33, ram: 8000, diskUsedGb: null, diskTotalGb: null },
    ]);
    expect(machine?.latest).toMatchObject({ ram: 8000 });
    // Échantillon rejoué plus ancien : ignoré pour « maintenant »
    applyServerMessage(qc, {
      type: 'metrics.sample',
      machineId: 'm1',
      sample: { ts: now, machine: {}, servers: [{ serverId: 's1', players: 9 }] },
    });
    expect(
      qc.getQueryData<{ latest: { players: number } }>(keys.serverMetrics('s1', '1h'))?.latest
        .players,
    ).toBe(2);
  });

  it('hello / pong mémorisent l’heure serveur', () => {
    applyServerMessage(qc, {
      type: 'hello',
      serverTime: 42,
      user: {
        id: 'u',
        username: 'admin',
        role: 'admin',
        locale: 'fr',
        theme: 'dark',
        isActive: true,
        createdAt: 0,
        lastLoginAt: null,
      },
    });
    expect(useRealtimeStore.getState().serverTime).toBe(42);
  });
});
