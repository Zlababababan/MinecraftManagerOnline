/**
 * Phase 9 — requêtes et mutations : migrations de serveurs (pré-checks, lancement, historique),
 * Java géré par machine (inventaire, installation multi-fournisseur / relais, suppression), releases
 * d'agent (publication d'un bundle signé, suppression) et mise à jour poussée à un agent.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AgentReleaseDto,
  DuplicatePrecheckDto,
  DuplicateServerInput,
  InstallJavaInput,
  JavaRuntimeDto,
  MigrationDto,
  MigrationPrecheckDto,
  StartMigrationInput,
  TaskDto,
} from '@mmo/protocol/client';

import { api } from './client.js';
import { phase8Keys } from './phase8.js';
import { keys } from './queries.js';

export const phase9Keys = {
  migrations: (serverId: string) => ['servers', serverId, 'migrations'] as const,
  java: (machineId: string) => ['machines', machineId, 'java'] as const,
  releases: ['agent-releases'] as const,
};

export interface MigrationsResult {
  migrations: MigrationDto[];
}
export interface ReleasesResult {
  releases: AgentReleaseDto[];
  latest: string | null;
}

export const migrationsQuery = (serverId: string) =>
  queryOptions({
    queryKey: phase9Keys.migrations(serverId),
    queryFn: ({ signal }) =>
      api.get<MigrationsResult>(`/api/servers/${serverId}/migrations`, signal),
    staleTime: 15_000,
  });

export const javaQuery = (machineId: string) =>
  queryOptions({
    queryKey: phase9Keys.java(machineId),
    queryFn: ({ signal }) =>
      api.get<{ runtimes: JavaRuntimeDto[] }>(`/api/machines/${machineId}/java`, signal),
    staleTime: 30_000,
  });

export const releasesQuery = queryOptions({
  queryKey: phase9Keys.releases,
  queryFn: ({ signal }) => api.get<ReleasesResult>('/api/agent-releases', signal),
  staleTime: 60_000,
});

export const useMigrations = (serverId: string) => useQuery(migrationsQuery(serverId));
export const useJavaRuntimes = (machineId: string, enabled = true) =>
  useQuery({ ...javaQuery(machineId), enabled });
export const useReleases = (enabled = true) => useQuery({ ...releasesQuery, enabled });

// --- Migrations -----------------------------------------------------------------------------------

export function useMigrationPrecheck(serverId: string) {
  return useMutation({
    mutationFn: (input: Pick<StartMigrationInput, 'toMachineId' | 'toDirectoryId' | 'toPath'>) =>
      api.post<{ precheck: MigrationPrecheckDto }>(
        `/api/servers/${serverId}/migrations/precheck`,
        input,
      ),
  });
}

export function useStartMigration(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StartMigrationInput) =>
      api.post<{ migration: MigrationDto }>(`/api/servers/${serverId}/migrations`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: phase9Keys.migrations(serverId) });
      void queryClient.invalidateQueries({ queryKey: keys.server(serverId) });
      void queryClient.invalidateQueries({ queryKey: keys.servers });
    },
  });
}

// --- Duplication (même chaîne que la migration, vers un nouveau serveur) ---------------------------

export function useDuplicatePrecheck(serverId: string) {
  return useMutation({
    mutationFn: (
      input: Pick<
        DuplicateServerInput,
        'toMachineId' | 'toDirectoryId' | 'toPath' | 'name' | 'gamePort'
      >,
    ) =>
      api.post<{ precheck: DuplicatePrecheckDto }>(
        `/api/servers/${serverId}/duplicate/precheck`,
        input,
      ),
  });
}

export function useStartDuplicate(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DuplicateServerInput) =>
      api.post<{ migration: MigrationDto }>(`/api/servers/${serverId}/duplicate`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: phase9Keys.migrations(serverId) });
      void queryClient.invalidateQueries({ queryKey: keys.server(serverId) });
      void queryClient.invalidateQueries({ queryKey: keys.servers });
    },
  });
}

// --- Java -----------------------------------------------------------------------------------------

export function useInstallJava(machineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InstallJavaInput) =>
      api.post<{ task: TaskDto; sources: { vendor: string; emulated: boolean; relay: boolean }[] }>(
        `/api/machines/${machineId}/java/install`,
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: phase8Keys.tasks });
    },
  });
}

export function useRemoveJava(machineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runtimeId: string) => api.delete(`/api/machines/${machineId}/java/${runtimeId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: phase9Keys.java(machineId) });
    },
  });
}

// --- Releases et mise à jour ----------------------------------------------------------------------

export interface PublishReleaseInput {
  version: string;
  signature: string;
  notes?: string | undefined;
  runtimeVersion?: string | undefined;
  file: File;
}

export function usePublishRelease() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PublishReleaseInput) => {
      const params = new URLSearchParams({ version: input.version, signature: input.signature });
      if (input.notes !== undefined && input.notes !== '') params.set('notes', input.notes);
      if (input.runtimeVersion !== undefined && input.runtimeVersion !== '') {
        params.set('runtimeVersion', input.runtimeVersion);
      }
      return api.putBinary<{ release: AgentReleaseDto }>(
        `/api/admin/agent-releases?${params.toString()}`,
        input.file,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: phase9Keys.releases });
      void queryClient.invalidateQueries({ queryKey: keys.machines });
    },
  });
}

export function useDeleteRelease() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: string) =>
      api.delete(`/api/admin/agent-releases/${encodeURIComponent(version)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: phase9Keys.releases });
      void queryClient.invalidateQueries({ queryKey: keys.machines });
    },
  });
}

export function useUpdateAgent(machineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version?: string) =>
      api.post<{ version: string; alreadyCurrent: boolean }>(
        `/api/machines/${machineId}/update`,
        version === undefined ? {} : { version },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.machines });
    },
  });
}
