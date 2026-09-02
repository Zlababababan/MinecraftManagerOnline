/**
 * État temps réel (Zustand) : statut de la connexion `/ws/client`, événements récents, et
 * projection des messages du panel dans le cache TanStack Query (`server.state`,
 * `machine.heartbeat`, invalidations sur événements structurants).
 */
import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

import { notificationTypeOf } from '@mmo/protocol/client';
import type {
  BackupDto,
  EventDto,
  MachineMetricsResult,
  MigrationDto,
  ServerMetricsResult,
  ServerMessage,
  TaskDto,
} from '@mmo/protocol/client';

import { phase8Keys, type BackupsResult } from '../api/phase8.js';
import { phase9Keys, type MigrationsResult } from '../api/phase9.js';
import { phase10Keys } from '../api/phase10.js';
import {
  METRICS_RANGE_MS,
  keys,
  machinesQuery,
  serverQuery,
  serversQuery,
  type MetricsRange,
} from '../api/queries.js';
import type { RealtimeClient, RealtimeStatus } from '../ws/client.js';

const MAX_RECENT_EVENTS = 100;

interface RealtimeState {
  status: RealtimeStatus;
  serverTime: number | undefined;
  recentEvents: EventDto[];
  setStatus(status: RealtimeStatus): void;
  setServerTime(ts: number): void;
  pushEvent(event: EventDto): void;
  reset(): void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  status: 'closed',
  serverTime: undefined,
  recentEvents: [],
  setStatus: (status) => {
    set({ status });
  },
  setServerTime: (serverTime) => {
    set({ serverTime });
  },
  pushEvent: (event) => {
    set((state) => {
      if (state.recentEvents.some((e) => e.id === event.id)) return state;
      return { recentEvents: [event, ...state.recentEvents].slice(0, MAX_RECENT_EVENTS) };
    });
  },
  reset: () => {
    set({ status: 'closed', serverTime: undefined, recentEvents: [] });
  },
}));

/** Événements qui changent la liste des machines ou des serveurs : on recharge depuis l'API. */
const INVALIDATING_EVENTS: Record<string, readonly (readonly string[])[]> = {
  'agent.online': [keys.machines, keys.servers],
  'agent.offline': [keys.machines, keys.servers],
  'machine.paired': [keys.machines],
  'server.adopted': [keys.servers, keys.conflicts],
  'server.removed': [keys.servers],
  'server.deleted': [keys.servers],
  'server.migrated': [keys.servers, keys.conflicts],
  'server.conflict': [keys.conflicts],
  'server.markerMismatch': [keys.servers],
  'server.eulaAccepted': [keys.servers],
  'player.joined': [],
  'player.left': [],
  // Phase 8
  'task.completed': [phase8Keys.tasks],
  'task.failed': [phase8Keys.tasks],
  'schedule.run': [phase8Keys.allSchedules],
  // Phase 9 : une migration déplace un serveur ; une mise à jour change la version d'un agent.
  'migration.done': [keys.servers, keys.machines],
  'migration.failed': [keys.servers],
  'agent.updatePushed': [keys.machines],
  'agent.updateApplied': [keys.machines],
  'agent.updateRolledBack': [keys.machines],
  // Phase 10 : certificat / adresse publiée ⇒ statut d'accès.
  'access.certificateIssued': [phase10Keys.access],
  'access.addressPublished': [phase10Keys.access],
};

/** Événements liés à un serveur qui invalident des données de ce serveur (phase 6). */
const SERVER_SCOPED_INVALIDATIONS: Record<
  string,
  readonly ((serverId: string) => readonly string[])[]
> = {
  'player.joined': [keys.players, keys.playerHistory],
  'player.left': [keys.players, keys.playerHistory],
  'player.action': [keys.players, keys.configAll],
  'server.configChanged': [keys.configAll, keys.filesAll],
  'server.fileChanged': [keys.filesAll, keys.configAll],
  'server.stateChanged': [keys.playerHistory],
  // Phase 8 : une task terminée peut avoir changé les fichiers (restauration, fs.fetch) ou les backups.
  'task.completed': [phase8Keys.backups, phase8Keys.serverTasks, keys.filesAll, phase8Keys.spark],
  'task.failed': [phase8Keys.backups, phase8Keys.serverTasks],
  'backup.rotated': [phase8Keys.backups],
  'schedule.run': [phase8Keys.schedules],
  'migration.done': [phase9Keys.migrations, phase8Keys.backups],
  'migration.failed': [phase9Keys.migrations, phase8Keys.backups],
};

export function applyServerMessage(queryClient: QueryClient, message: ServerMessage): void {
  const store = useRealtimeStore.getState();
  switch (message.type) {
    case 'hello':
      store.setServerTime(message.serverTime);
      return;
    case 'pong':
      store.setServerTime(message.ts);
      return;
    case 'server.state': {
      const server = message.server;
      queryClient.setQueryData(serverQuery(server.id).queryKey, { server });
      queryClient.setQueryData(serversQuery.queryKey, (old) => {
        if (old === undefined) return old;
        const exists = old.servers.some((s) => s.id === server.id);
        return {
          servers: exists
            ? old.servers.map((s) => (s.id === server.id ? server : s))
            : [...old.servers, server],
        };
      });
      return;
    }
    case 'machine.heartbeat': {
      const { machineId, heartbeat } = message;
      queryClient.setQueryData(machinesQuery.queryKey, (old) =>
        old === undefined
          ? old
          : {
              machines: old.machines.map((m) =>
                m.id === machineId
                  ? { ...m, heartbeat, connected: true, status: 'online' as const }
                  : m,
              ),
            },
      );
      queryClient.setQueryData(keys.machine(machineId), (old: { machine: unknown } | undefined) =>
        old === undefined
          ? old
          : {
              machine: { ...(old.machine as object), heartbeat, connected: true, status: 'online' },
            },
      );
      return;
    }
    case 'event': {
      const event = message.event;
      store.pushEvent(event);
      // Phase 10 : un événement notifiable rafraîchit le centre (non-lus).
      if (notificationTypeOf(event) !== undefined) {
        void queryClient.invalidateQueries({ queryKey: phase10Keys.notifications });
      }
      const targets = INVALIDATING_EVENTS[event.type];
      for (const key of targets ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      if (event.serverId !== null) {
        void queryClient.invalidateQueries({ queryKey: ['events'] });
        for (const key of SERVER_SCOPED_INVALIDATIONS[event.type] ?? []) {
          void queryClient.invalidateQueries({ queryKey: key(event.serverId) });
        }
      } else {
        void queryClient.invalidateQueries({ queryKey: ['events'] });
      }
      return;
    }
    case 'metrics.sample':
      applyMetricsSample(queryClient, message.machineId, message.sample);
      return;
    case 'task.update':
      applyTaskUpdate(queryClient, message.task);
      return;
    case 'backup.update':
      applyBackupUpdate(queryClient, message.backup);
      return;
    case 'migration.update':
      applyMigrationUpdate(queryClient, message.migration);
      return;
    case 'console.snapshot':
    case 'console.lines':
    case 'error':
      // Consommés par les abonnés console (`useConsole`).
      return;
  }
}

/**
 * Échantillon temps réel (15 s) : met à jour « maintenant » dans toutes les plages en cache et
 * ajoute le point aux séries **brutes** (la plage glissante est tronquée) ; les plages agrégées
 * sont rafraîchies par leur `refetchInterval`.
 */
function applyMetricsSample(
  queryClient: QueryClient,
  machineId: string,
  sample: Extract<ServerMessage, { type: 'metrics.sample' }>['sample'],
): void {
  const cpuSource = sample.cpuSource ?? null;
  queryClient.setQueriesData<MachineMetricsResult>(
    { queryKey: keys.machineMetricsAll(machineId) },
    (old) => {
      if (old === undefined || (old.latest !== null && old.latest.ts >= sample.ts)) return old;
      const point = {
        ts: sample.ts,
        cpu: sample.machine.cpuPct ?? null,
        ram: sample.machine.ramUsedMb ?? null,
        diskUsedGb: sample.machine.diskUsedGb ?? null,
        diskTotalGb: sample.machine.diskTotalGb ?? null,
      };
      return { ...old, latest: point, cpuSource, points: appendRaw(old, point, sample.ts) };
    },
  );
  for (const s of sample.servers) {
    queryClient.setQueriesData<ServerMetricsResult>(
      { queryKey: keys.serverMetricsAll(s.serverId) },
      (old) => {
        if (old === undefined || (old.latest !== null && old.latest.ts >= sample.ts)) return old;
        const point = {
          ts: sample.ts,
          cpu: s.cpuPct ?? null,
          ram: s.rssMb ?? null,
          tps: s.tps ?? null,
          mspt: s.mspt ?? null,
          players: s.players ?? null,
        };
        return {
          ...old,
          latest: point,
          tpsSource: s.tpsSource ?? null,
          cpuSource,
          points: appendRaw(old, point, sample.ts),
        };
      },
    );
  }
}

function appendRaw<P extends { ts: number }>(
  old: { resolution: string; points: P[]; from: number; to: number },
  point: P,
  now: number,
): P[] {
  if (old.resolution !== 'raw') return old.points;
  // La plage glissante est celle de la clé ('1h'…) ; on garde la largeur d'origine.
  const span = old.to - old.from;
  const range = (Object.keys(METRICS_RANGE_MS) as MetricsRange[]).find(
    (r) => Math.abs(METRICS_RANGE_MS[r] - span) < 60_000,
  );
  const width = range === undefined ? span : METRICS_RANGE_MS[range];
  return [...old.points.filter((p) => p.ts >= now - width), point];
}

/** Branche le client temps réel sur le store et le cache ; retourne la fonction de débranchement. */
export function bindRealtime(client: RealtimeClient, queryClient: QueryClient): () => void {
  const offStatus = client.onStatus((status) => {
    useRealtimeStore.getState().setStatus(status);
    // À chaque reconnexion, l'état a pu bouger pendant la coupure.
    if (status === 'open') {
      void queryClient.invalidateQueries({ queryKey: keys.machines });
      void queryClient.invalidateQueries({ queryKey: keys.servers });
    }
  });
  const offMessage = client.on((message) => {
    applyServerMessage(queryClient, message);
  });
  useRealtimeStore.getState().setStatus(client.status);
  return () => {
    offStatus();
    offMessage();
  };
}

/** Task mise à jour (progression ou issue) : listes actives et par serveur mises à jour en place. */
export function applyTaskUpdate(queryClient: QueryClient, task: TaskDto): void {
  const active =
    task.status === 'pending' || task.status === 'running' || task.status === 'stalled';
  const merge = (old: { tasks: TaskDto[] } | undefined, keepFinished: boolean) => {
    if (old === undefined) return old;
    const exists = old.tasks.some((t) => t.id === task.id);
    if (!active && !keepFinished) return { tasks: old.tasks.filter((t) => t.id !== task.id) };
    return {
      tasks: exists ? old.tasks.map((t) => (t.id === task.id ? task : t)) : [task, ...old.tasks],
    };
  };
  queryClient.setQueryData(phase8Keys.activeTasks, (old: { tasks: TaskDto[] } | undefined) =>
    merge(old, false),
  );
  if (task.serverId !== null) {
    queryClient.setQueryData(
      phase8Keys.serverTasks(task.serverId),
      (old: { tasks: TaskDto[] } | undefined) => merge(old, true),
    );
    // Lot 4 : l'état d'une copie hors-site vit dans la liste des sauvegardes — relue à chaque
    // mouvement de la task (départ, issue), il n'y a pas de message dédié.
    if (task.kind === 'backup.receive') {
      void queryClient.invalidateQueries({ queryKey: phase8Keys.backups(task.serverId) });
    }
  }
}

export function applyBackupUpdate(queryClient: QueryClient, backup: BackupDto): void {
  queryClient.setQueryData(
    phase8Keys.backups(backup.serverId),
    (old: BackupsResult | undefined) => {
      if (old === undefined) return old;
      const exists = old.backups.some((b) => b.id === backup.id);
      const backups = exists
        ? old.backups.map((b) => (b.id === backup.id ? backup : b))
        : [backup, ...old.backups];
      // Lot 4 : une fiche supprimée reste visible tant qu'une copie hors-site saine existe.
      const copied = new Set(
        (old.replicas ?? []).filter((c) => c.status === 'success').map((c) => c.backupId),
      );
      return {
        ...old,
        backups: backups.filter((b) => b.status !== 'deleted' || copied.has(b.id)),
      };
    },
  );
}

/** Migration mise à jour (statut/progression) : liste du serveur mise à jour en place. */
export function applyMigrationUpdate(queryClient: QueryClient, migration: MigrationDto): void {
  queryClient.setQueryData(
    phase9Keys.migrations(migration.serverId),
    (old: MigrationsResult | undefined) => {
      if (old === undefined) return old;
      const exists = old.migrations.some((m) => m.id === migration.id);
      return {
        migrations: exists
          ? old.migrations.map((m) => (m.id === migration.id ? migration : m))
          : [migration, ...old.migrations],
      };
    },
  );
  if (migration.status === 'done' || migration.status === 'failed') {
    void queryClient.invalidateQueries({ queryKey: keys.server(migration.serverId) });
    void queryClient.invalidateQueries({ queryKey: keys.servers });
  }
}
