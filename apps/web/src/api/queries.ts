/** Requêtes et mutations TanStack Query — clés centralisées, DTO de `@mmo/protocol/client`. */
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';

import type { ConsoleLine } from '@mmo/protocol';
import type {
  EventDto,
  MachineDto,
  PairingCodeDto,
  ServerConflictDto,
  ServerDto,
  UserDto,
  addDirectorySchema,
  commandHistoryItemSchema,
  createMachineSchema,
  createServerSchema,
  loginRequestSchema,
  playerOnlineDtoSchema,
  resolveConflictSchema,
  setupRequestSchema,
  stopServerSchema,
  updateMeSchema,
  updateServerSchema,
} from '@mmo/protocol/client';

import { api } from './client.js';

export interface EventsFilter {
  serverId?: string;
  machineId?: string;
  limit?: number;
}

export const keys = {
  me: ['me'] as const,
  setupStatus: ['setup', 'status'] as const,
  machines: ['machines'] as const,
  machine: (id: string) => ['machines', id] as const,
  servers: ['servers'] as const,
  server: (id: string) => ['servers', id] as const,
  conflicts: ['conflicts'] as const,
  players: (id: string) => ['servers', id, 'players'] as const,
  commandHistory: (id: string) => ['servers', id, 'command-history'] as const,
  events: (filter: EventsFilter) => ['events', filter] as const,
};

export type PlayerDto = z.infer<typeof playerOnlineDtoSchema>;
export type CommandHistoryItem = z.infer<typeof commandHistoryItemSchema>;

// --- Options de requêtes (réutilisées par les gardes de routes) --------------------------------

export const meQuery = queryOptions({
  queryKey: keys.me,
  queryFn: ({ signal }) => api.get<{ user: UserDto }>('/api/auth/me', signal),
  retry: false,
  staleTime: 60_000,
});

export const setupStatusQuery = queryOptions({
  queryKey: keys.setupStatus,
  queryFn: ({ signal }) => api.get<{ needsSetup: boolean }>('/api/setup/status', signal),
  retry: false,
  staleTime: 0,
});

export const machinesQuery = queryOptions({
  queryKey: keys.machines,
  queryFn: ({ signal }) => api.get<{ machines: MachineDto[] }>('/api/machines', signal),
  staleTime: 15_000,
});

export const serversQuery = queryOptions({
  queryKey: keys.servers,
  queryFn: ({ signal }) => api.get<{ servers: ServerDto[] }>('/api/servers', signal),
  staleTime: 15_000,
});

export const serverQuery = (id: string) =>
  queryOptions({
    queryKey: keys.server(id),
    queryFn: ({ signal }) => api.get<{ server: ServerDto }>(`/api/servers/${id}`, signal),
    staleTime: 15_000,
  });

export const machineQuery = (id: string) =>
  queryOptions({
    queryKey: keys.machine(id),
    queryFn: ({ signal }) => api.get<{ machine: MachineDto }>(`/api/machines/${id}`, signal),
    staleTime: 15_000,
  });

export const conflictsQuery = queryOptions({
  queryKey: keys.conflicts,
  queryFn: ({ signal }) =>
    api.get<{ conflicts: ServerConflictDto[] }>('/api/servers/conflicts', signal),
  staleTime: 15_000,
});

export const eventsQuery = (filter: EventsFilter) =>
  queryOptions({
    queryKey: keys.events(filter),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (filter.serverId !== undefined) params.set('serverId', filter.serverId);
      if (filter.machineId !== undefined) params.set('machineId', filter.machineId);
      params.set('limit', String(filter.limit ?? 50));
      return api.get<{ events: EventDto[] }>(`/api/events?${params.toString()}`, signal);
    },
    staleTime: 15_000,
  });

export const playersQuery = (id: string) =>
  queryOptions({
    queryKey: keys.players(id),
    queryFn: ({ signal }) =>
      api.get<{ online: number; max: number | null; players: PlayerDto[] }>(
        `/api/servers/${id}/players`,
        signal,
      ),
    staleTime: 5_000,
  });

export const commandHistoryQuery = (id: string) =>
  queryOptions({
    queryKey: keys.commandHistory(id),
    queryFn: ({ signal }) =>
      api.get<{ history: CommandHistoryItem[] }>(`/api/servers/${id}/command-history`, signal),
    staleTime: 60_000,
  });

// --- Hooks -------------------------------------------------------------------------------------

export const useMe = () => useQuery(meQuery);
export const useMachines = () => useQuery(machinesQuery);
export const useServers = () => useQuery(serversQuery);
export const useServer = (id: string) => useQuery(serverQuery(id));
export const useMachine = (id: string) => useQuery(machineQuery(id));
export const useConflicts = () => useQuery(conflictsQuery);
export const useEvents = (filter: EventsFilter) => useQuery(eventsQuery(filter));
export const usePlayers = (id: string, enabled = true) =>
  useQuery({ ...playersQuery(id), enabled, refetchInterval: enabled ? 15_000 : false });

// --- Mutations ---------------------------------------------------------------------------------

type Setup = z.infer<typeof setupRequestSchema>;
type Login = z.infer<typeof loginRequestSchema>;
type UpdateMe = z.infer<typeof updateMeSchema>;
type CreateMachine = z.infer<typeof createMachineSchema>;
type AddDirectory = z.infer<typeof addDirectorySchema>;
type CreateServer = z.infer<typeof createServerSchema>;
type UpdateServer = z.infer<typeof updateServerSchema>;
type StopServer = z.infer<typeof stopServerSchema>;
type ResolveConflict = z.infer<typeof resolveConflictSchema>;

export interface ScanResult {
  scannedPaths: string[];
  servers: ServerDto[];
  conflicts: ServerConflictDto[];
}

export function invalidateAll(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.machines }),
    queryClient.invalidateQueries({ queryKey: keys.servers }),
    queryClient.invalidateQueries({ queryKey: keys.conflicts }),
  ]).then(() => undefined);
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Setup) => api.post<{ user: UserDto }>('/api/setup', body),
    onSuccess: (data) => {
      qc.setQueryData(keys.me, data);
      qc.setQueryData(keys.setupStatus, { needsSetup: false });
    },
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Login) => api.post<{ user: UserDto }>('/api/auth/login', body),
    onSuccess: (data) => {
      qc.setQueryData(keys.me, data);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/auth/logout'),
    onSettled: () => {
      qc.clear();
    },
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMe) => api.patch<{ user: UserDto }>('/api/auth/me', body),
    onSuccess: (data) => {
      qc.setQueryData(keys.me, data);
    },
  });
}

export function useCreateMachine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMachine) =>
      api.post<{ machine: MachineDto; pairing: PairingCodeDto }>('/api/machines', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.machines }),
  });
}

export function useNewPairingCode(machineId: string) {
  return useMutation({
    mutationFn: () =>
      api.post<{ pairing: PairingCodeDto }>(`/api/machines/${machineId}/pairing-codes`),
  });
}

export function useUpdateMachine(machineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; disabled?: boolean }) =>
      api.patch<{ machine: MachineDto }>(`/api/machines/${machineId}`, body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteMachine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (machineId: string) => api.delete(`/api/machines/${machineId}`),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useRotateSecret(machineId: string) {
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; graceUntil: number }>(`/api/machines/${machineId}/rotate-secret`),
  });
}

export function useAddDirectory(machineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddDirectory) =>
      api.post<{ directory: MachineDto['watchedDirectories'][number] }>(
        `/api/machines/${machineId}/directories`,
        body,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.machines }),
  });
}

export function useRemoveDirectory(machineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dirId: string) => api.delete(`/api/machines/${machineId}/directories/${dirId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.machines }),
  });
}

export function useScan(machineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths?: string[]) =>
      api.post<ScanResult>(`/api/machines/${machineId}/scan`, paths === undefined ? {} : { paths }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useCreateServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateServer) => api.post<{ server: ServerDto }>('/api/servers', body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateServer(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateServer) =>
      api.patch<{ server: ServerDto }>(`/api/servers/${serverId}`, body),
    onSuccess: (data) => {
      qc.setQueryData(keys.server(serverId), data);
      void qc.invalidateQueries({ queryKey: keys.servers, exact: true });
    },
  });
}

export function useDeleteServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) => api.delete(`/api/servers/${serverId}`),
    onSuccess: () => invalidateAll(qc),
  });
}

export type ServerAction = 'start' | 'stop' | 'restart' | 'kill';

export function useServerAction(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }: { action: ServerAction; body?: StopServer }) =>
      api.post<{ server: ServerDto }>(`/api/servers/${serverId}/${action}`, body ?? {}),
    onSuccess: (data) => {
      qc.setQueryData(keys.server(serverId), { server: data.server });
      qc.setQueryData(serversQuery.queryKey, (old) =>
        old === undefined
          ? old
          : { servers: old.servers.map((s) => (s.id === data.server.id ? data.server : s)) },
      );
    },
  });
}

export function useAcceptEula(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ server: ServerDto }>(`/api/servers/${serverId}/eula-accept`),
    onSuccess: (data) => {
      qc.setQueryData(keys.server(serverId), data);
      void qc.invalidateQueries({ queryKey: keys.servers, exact: true });
    },
  });
}

export function useSendCommand(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (command: string) =>
      api.post<{ via: 'stdin' | 'rcon' }>(`/api/servers/${serverId}/command`, { command }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.commandHistory(serverId) }),
  });
}

export function useResolveConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ResolveConflict) =>
      api.post<{ server: ServerDto | null }>('/api/servers/conflicts/resolve', body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function consoleSnapshot(serverId: string, sinceSeq?: number) {
  const qs = sinceSeq === undefined ? '' : `?sinceSeq=${String(sinceSeq)}`;
  return api.get<{ lines: ConsoleLine[]; truncated: boolean; latestSeq: number }>(
    `/api/servers/${serverId}/console${qs}`,
  );
}
