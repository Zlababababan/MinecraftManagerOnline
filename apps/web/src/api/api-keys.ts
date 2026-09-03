/** Clés d'API (lot 8) : les siennes (page Compte) ou toutes (Réglages, admin). */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ApiKeyCreateInput, ApiKeyDto } from '@mmo/protocol/client';

import { api } from './client.js';

const apiKeysKey = (all: boolean) => ['api-keys', all ? 'all' : 'mine'] as const;

export const apiKeysQuery = (all: boolean) =>
  queryOptions({
    queryKey: apiKeysKey(all),
    queryFn: ({ signal }) =>
      api.get<{ keys: ApiKeyDto[] }>(`/api/api-keys${all ? '?all=true' : ''}`, signal),
  });

export const useApiKeys = (all: boolean) => useQuery(apiKeysQuery(all));

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApiKeyCreateInput) =>
      api.post<{ key: ApiKeyDto; token: string }>('/api/api-keys', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/api/api-keys/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}
