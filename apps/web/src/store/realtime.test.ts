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
