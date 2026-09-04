/**
 * Lot 5 — créer un serveur : catalogue des versions (caché longtemps, il ne bouge qu'aux sorties
 * de Minecraft), pré-contrôle sur la machine, création, et reprise d'une installation ratée.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreateInstallInput,
  InstallCatalogDto,
  InstallLoader,
  InstallPrecheckDto,
  ServerDto,
} from '@mmo/protocol/client';

import { api } from './client.js';

export const installCatalogQuery = (loader: InstallLoader) =>
  queryOptions({
    queryKey: ['install', 'catalog', loader] as const,
    queryFn: ({ signal }) =>
      api.get<InstallCatalogDto>(`/api/install/catalog?loader=${loader}`, signal),
    staleTime: 60 * 60_000,
  });

export const useInstallCatalog = (loader: InstallLoader, enabled: boolean) =>
  useQuery({ ...installCatalogQuery(loader), enabled });

export type InstallBody = Omit<CreateInstallInput, 'acceptEula'>;

export function useInstallPrecheck(machineId: string) {
  return useMutation({
    mutationFn: (body: InstallBody) =>
      api.post<{ precheck: InstallPrecheckDto }>(
        `/api/machines/${machineId}/install/precheck`,
        body,
      ),
  });
}

export function useCreateInstall(machineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInstallInput) =>
      api.post<{ server: ServerDto }>(`/api/machines/${machineId}/install`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

/** Rejoue le plan d'une installation ratée, dans le dossier tel qu'il est. */
export function useRetryInstall(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ taskId: string }>(`/api/servers/${serverId}/install/retry`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
