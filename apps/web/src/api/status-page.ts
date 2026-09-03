/**
 * Page de statut publique (lot 8) : le réglage d'un serveur (opérateur) et l'état lu par la page
 * publique elle-même — cette dernière requête est la seule du front à ne demander aucune session.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PublicStatus, StatusPageDto, StatusPageInput } from '@mmo/protocol/client';

import { api } from './client.js';

const statusPageKey = (serverId: string) => ['servers', serverId, 'status-page'] as const;

export const statusPageQuery = (serverId: string) =>
  queryOptions({
    queryKey: statusPageKey(serverId),
    queryFn: ({ signal }) =>
      api.get<{ statusPage: StatusPageDto | null }>(`/api/servers/${serverId}/status-page`, signal),
  });

export const useStatusPage = (serverId: string) => useQuery(statusPageQuery(serverId));

export function useSetStatusPage(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StatusPageInput) =>
      api.put<{ statusPage: StatusPageDto }>(`/api/servers/${serverId}/status-page`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: statusPageKey(serverId) });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

export function useRotateStatusPage(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ statusPage: StatusPageDto }>(`/api/servers/${serverId}/status-page/rotate`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: statusPageKey(serverId) });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

/**
 * État publié pour un jeton. Rafraîchi seul : le panel sert un cache court, une page ouverte sur
 * un téléphone posé sur la table ne coûte donc rien de plus qu'un onglet actif.
 */
export const publicStatusQuery = (token: string) =>
  queryOptions({
    queryKey: ['public-status', token] as const,
    queryFn: ({ signal }) => api.get<{ status: PublicStatus }>(`/api/status/${token}`, signal),
    refetchInterval: 20_000,
    retry: false,
  });
