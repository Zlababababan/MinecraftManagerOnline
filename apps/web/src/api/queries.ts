/** Requêtes et mutations TanStack Query — clés centralisées, DTO de `@mmo/protocol/client`. */
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { z } from 'zod';

import type { ConfigData, ConfigFile, ConfigSetData, ConsoleLine } from '@mmo/protocol';
import type {
  ConfigSetResult,
  EventDto,
  FsEntryDto,
  FsReadResult,
  LogsSearchRequest,
  MachineDto,
  MachineMetricsResult,
  PairingCodeDto,
  PlayerActionRequest,
  PlayerSessionDto,
  ResolvedPlayerDto,
  ServerConflictDto,
  ServerDto,
  ServerMetricsResult,
  UserDto,
  addDirectorySchema,
  commandHistoryItemSchema,
  createMachineSchema,
  createServerSchema,
  fsMoveBodySchema,
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
  // Phase 6
  config: (id: string, file: ConfigFile) => ['servers', id, 'config', file] as const,
  configAll: (id: string) => ['servers', id, 'config'] as const,
  playerHistory: (id: string) => ['servers', id, 'player-history'] as const,
  files: (id: string, path: string) => ['servers', id, 'files', path] as const,
  filesAll: (id: string) => ['servers', id, 'files'] as const,
  fileRead: (id: string, path: string) => ['servers', id, 'file', path] as const,
  logFiles: (id: string) => ['servers', id, 'logs'] as const,
  // Phase 7
  serverMetrics: (id: string, range: MetricsRange) => ['servers', id, 'metrics', range] as const,
  serverMetricsAll: (id: string) => ['servers', id, 'metrics'] as const,
  machineMetrics: (id: string, range: MetricsRange) => ['machines', id, 'metrics', range] as const,
  machineMetricsAll: (id: string) => ['machines', id, 'metrics'] as const,
};

/** Plages des graphiques ; la résolution (brut / 1 min / 1 h) est choisie par le panel. */
export const METRICS_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type MetricsRange = (typeof METRICS_RANGES)[number];
export const METRICS_RANGE_MS: Record<MetricsRange, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};

export interface ConfigGetResult<F extends ConfigFile> {
  file: F;
  data: ConfigData<F>;
  sha256?: string;
  source: 'file' | 'live';
}

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

export const configQuery = <F extends ConfigFile>(id: string, file: F) =>
  queryOptions({
    queryKey: keys.config(id, file),
    queryFn: ({ signal }) =>
      api.get<ConfigGetResult<F>>(`/api/servers/${id}/config/${file}`, signal),
    staleTime: 10_000,
  });

export const playerHistoryQuery = (id: string, limit = 100) =>
  queryOptions({
    queryKey: keys.playerHistory(id),
    queryFn: ({ signal }) =>
      api.get<{ sessions: PlayerSessionDto[] }>(
        `/api/servers/${id}/players/history?limit=${String(limit)}`,
        signal,
      ),
    staleTime: 10_000,
  });

export const filesQuery = (id: string, path: string) =>
  queryOptions({
    queryKey: keys.files(id, path),
    queryFn: ({ signal }) =>
      api.get<{ path: string; entries: FsEntryDto[] }>(
        `/api/servers/${id}/files?path=${encodeURIComponent(path)}`,
        signal,
      ),
    staleTime: 10_000,
  });

export const fileReadQuery = (id: string, path: string) =>
  queryOptions({
    queryKey: keys.fileRead(id, path),
    queryFn: ({ signal }) =>
      api.get<FsReadResult>(
        `/api/servers/${id}/files/read?path=${encodeURIComponent(path)}`,
        signal,
      ),
    staleTime: 0,
    gcTime: 0,
  });

export const logFilesQuery = (id: string) =>
  queryOptions({
    queryKey: keys.logFiles(id),
    queryFn: ({ signal }) =>
      api.get<{ files: { name: string; sizeBytes: number; modifiedAt: number }[] }>(
        `/api/servers/${id}/logs`,
        signal,
      ),
    staleTime: 30_000,
  });

export const serverMetricsQuery = (id: string, range: MetricsRange) =>
  queryOptions({
    queryKey: keys.serverMetrics(id, range),
    queryFn: ({ signal }) =>
      api.get<ServerMetricsResult>(
        `/api/servers/${id}/metrics?from=${String(Date.now() - METRICS_RANGE_MS[range])}`,
        signal,
      ),
    staleTime: 30_000,
    // Les plages agrégées ne sont pas alimentées en direct : on les rafraîchit périodiquement.
    refetchInterval: range === '1h' ? false : 60_000,
  });

export const machineMetricsQuery = (id: string, range: MetricsRange) =>
  queryOptions({
    queryKey: keys.machineMetrics(id, range),
    queryFn: ({ signal }) =>
      api.get<MachineMetricsResult>(
        `/api/machines/${id}/metrics?from=${String(Date.now() - METRICS_RANGE_MS[range])}`,
        signal,
      ),
    staleTime: 30_000,
    refetchInterval: range === '1h' ? false : 60_000,
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
export const useConfigFile = <F extends ConfigFile>(
  id: string,
  file: F,
  enabled = true,
): UseQueryResult<ConfigGetResult<F>> => useQuery({ ...configQuery(id, file), enabled });
export const usePlayerHistory = (id: string) => useQuery(playerHistoryQuery(id));
export const useFiles = (id: string, path: string) => useQuery(filesQuery(id, path));
export const useFileRead = (id: string, path: string | undefined) =>
  useQuery({ ...fileReadQuery(id, path ?? ''), enabled: path !== undefined });
export const useLogFiles = (id: string) => useQuery(logFilesQuery(id));
export const useServerMetrics = (id: string, range: MetricsRange) =>
  useQuery(serverMetricsQuery(id, range));
export const useMachineMetrics = (id: string, range: MetricsRange) =>
  useQuery(machineMetricsQuery(id, range));

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

// --- Phase 6 : configuration, joueurs, fichiers, journaux -----------------------------------------

type FsMove = z.infer<typeof fsMoveBodySchema>;

export function useSetConfig<F extends ConfigFile>(serverId: string, file: F) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { data: ConfigSetData<F>; expectedSha256?: string | undefined }) =>
      api.put<ConfigSetResult>(`/api/servers/${serverId}/config/${file}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.config(serverId, file) }),
  });
}

export function useResolvePlayers(serverId: string) {
  return useMutation({
    mutationFn: (names: string[]) =>
      api.post<{ players: ResolvedPlayerDto[]; onlineMode: boolean }>(
        `/api/servers/${serverId}/players/resolve`,
        { names },
      ),
  });
}

export interface PlayerActionResult {
  applied: 'file' | 'commands';
  response?: string;
  warnings?: string[];
}

export function usePlayerAction(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PlayerActionRequest) =>
      api.post<PlayerActionResult>(`/api/servers/${serverId}/players/action`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.configAll(serverId) });
      void qc.invalidateQueries({ queryKey: keys.players(serverId) });
    },
  });
}

export function useFileMutations(serverId: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.filesAll(serverId) });
  };
  const mkdir = useMutation({
    mutationFn: (path: string) => api.post(`/api/servers/${serverId}/files/mkdir`, { path }),
    onSuccess: refresh,
  });
  const rename = useMutation({
    mutationFn: (body: FsMove) => api.post(`/api/servers/${serverId}/files/rename`, body),
    onSuccess: refresh,
  });
  const copy = useMutation({
    mutationFn: (body: FsMove) => api.post(`/api/servers/${serverId}/files/copy`, body),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (path: string) =>
      api.post<{ trashedAs: string }>(`/api/servers/${serverId}/files/delete`, { path }),
    onSuccess: refresh,
  });
  const write = useMutation({
    mutationFn: (body: { path: string; content: string; expectedSha256?: string | undefined }) =>
      api.put<{ sha256: string }>(`/api/servers/${serverId}/files/write`, body),
    onSuccess: (_data, body) => {
      refresh();
      void qc.invalidateQueries({ queryKey: keys.fileRead(serverId, body.path) });
      void qc.invalidateQueries({ queryKey: keys.configAll(serverId) });
    },
  });
  return { mkdir, rename, copy, remove, write };
}

export interface LogMatch {
  file: string;
  line: number;
  text: string;
}

export function useLogSearch(serverId: string) {
  return useMutation({
    mutationFn: (body: LogsSearchRequest) =>
      api.post<{ matches: LogMatch[]; truncated: boolean }>(
        `/api/servers/${serverId}/logs/search`,
        body,
      ),
  });
}
