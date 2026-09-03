/** Sessions cookie (lot 8) : voir ses appareils connectés, en déconnecter un, ou tous les autres. */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SessionDto } from '@mmo/protocol/client';

import { api } from './client.js';

const sessionsKey = ['sessions'] as const;

export const sessionsQuery = queryOptions({
  queryKey: sessionsKey,
  queryFn: ({ signal }) => api.get<{ sessions: SessionDto[] }>('/api/auth/sessions', signal),
});

export const useSessions = () => useQuery(sessionsQuery);

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<unknown>(`/api/auth/sessions/${String(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ revoked: number }>('/api/auth/sessions'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
  });
}

/** Admin : déconnecter un compte de tous ses appareils. */
export function useSignOutUserEverywhere() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete<unknown>(`/api/users/${userId}/sessions`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}
