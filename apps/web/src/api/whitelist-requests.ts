/**
 * Demandes de whitelist en libre-service (lot 8) : la liste côté opérateur, et l'envoi depuis la
 * page publique — le seul appel du front, avec l'état public, à ne demander aucune session.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  WhitelistRequestDto,
  WhitelistRequestInput,
  WhitelistRequestResult,
} from '@mmo/protocol/client';

import { api } from './client.js';

const key = (serverId: string) => ['servers', serverId, 'whitelist-requests'] as const;

export const whitelistRequestsQuery = (serverId: string) =>
  queryOptions({
    queryKey: key(serverId),
    queryFn: ({ signal }) =>
      api.get<{ requests: WhitelistRequestDto[] }>(
        `/api/servers/${serverId}/whitelist-requests`,
        signal,
      ),
  });

export const useWhitelistRequests = (serverId: string) =>
  useQuery(whitelistRequestsQuery(serverId));

/** Accepter ajoute réellement à la liste blanche : la liste blanche est donc à relire aussi. */
export function useDecideWhitelistRequest(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) =>
      api.post<{ request: WhitelistRequestDto }>(
        `/api/servers/${serverId}/whitelist-requests/${id}/${accept ? 'accept' : 'reject'}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key(serverId) });
      void queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'config'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

export function useDeleteWhitelistRequest(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/servers/${serverId}/whitelist-requests/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key(serverId) });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

/** Depuis la page publique : sans session, sans cache, sans réessai. */
export function submitWhitelistRequest(
  token: string,
  input: WhitelistRequestInput,
): Promise<WhitelistRequestResult> {
  return api.post<WhitelistRequestResult>(`/api/status/${token}/whitelist`, input);
}
