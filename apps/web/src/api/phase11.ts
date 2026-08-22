/** Phase 11 — distribution des archives d'installation servies par le panel (`/api/dist`). */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { DistStatusDto } from '@mmo/protocol/client';

import { api } from './client.js';

export const phase11Keys = {
  dist: ['dist'] as const,
};

export const distQuery = queryOptions({
  queryKey: phase11Keys.dist,
  queryFn: ({ signal }) => api.get<DistStatusDto>('/api/dist', signal),
  staleTime: 60_000,
});

export function useDistribution() {
  return useQuery(distQuery);
}

export function useClearDistribution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/api/admin/dist'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: phase11Keys.dist });
    },
  });
}
