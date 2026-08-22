/**
 * État temps réel (Zustand) : statut de la connexion `/ws/client`, événements récents, et
 * projection des messages du panel dans le cache TanStack Query (`server.state`,
 * `machine.heartbeat`, invalidations sur événements structurants).
 */
import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

import type { EventDto, ServerMessage } from '@mmo/protocol/client';

import { keys, machinesQuery, serverQuery, serversQuery } from '../api/queries.js';
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
      const targets = INVALIDATING_EVENTS[event.type];
      for (const key of targets ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      if (event.serverId !== null) {
        void queryClient.invalidateQueries({ queryKey: ['events'] });
        if (event.type === 'player.joined' || event.type === 'player.left') {
          void queryClient.invalidateQueries({ queryKey: keys.players(event.serverId) });
        }
      } else {
        void queryClient.invalidateQueries({ queryKey: ['events'] });
      }
      return;
    }
    case 'console.snapshot':
    case 'console.lines':
    case 'error':
      // Consommés par les abonnés console (`useConsole`).
      return;
  }
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
