/**
 * API d'administration (rôle admin) : comptes utilisateurs, portées accordées (lot 8) et journal
 * d'audit.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AuditDto,
  CreateUserInput,
  UpdateUserInput,
  UserDto,
  UserGrantsDto,
  UserGrantsInput,
} from '@mmo/protocol/client';

import { api } from './client.js';

const adminKeys = {
  users: ['admin', 'users'] as const,
  grants: (id: string) => ['admin', 'users', id, 'grants'] as const,
  audit: (limit: number) => ['admin', 'audit', limit] as const,
};

export const userGrantsQuery = (id: string) =>
  queryOptions({
    queryKey: adminKeys.grants(id),
    queryFn: ({ signal }) => api.get<{ grants: UserGrantsDto }>(`/api/users/${id}/grants`, signal),
  });

export const useUserGrants = (id: string) => useQuery(userGrantsQuery(id));

export function useSetUserGrants(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UserGrantsInput) =>
      api.put<{ grants: UserGrantsDto }>(`/api/users/${id}/grants`, input),
    onSuccess: (data) => {
      queryClient.setQueryData(adminKeys.grants(id), data);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

export const usersQuery = queryOptions({
  queryKey: adminKeys.users,
  queryFn: ({ signal }) => api.get<{ users: UserDto[] }>('/api/users', signal),
});

export const auditQuery = (limit = 200) =>
  queryOptions({
    queryKey: adminKeys.audit(limit),
    queryFn: ({ signal }) =>
      api.get<{ audit: AuditDto[] }>(`/api/audit?limit=${String(limit)}`, signal),
    staleTime: 10_000,
  });

export const useUsers = () => useQuery(usersQuery);
export const useAudit = (limit?: number) => useQuery(auditQuery(limit));

function useInvalidateUsers() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: adminKeys.users });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
  };
}

export function useCreateUser() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (input: CreateUserInput) => api.post<{ user: UserDto }>('/api/users', input),
    onSuccess: invalidate,
  });
}

export function useUpdateUser(id: string) {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (input: UpdateUserInput) => api.patch<{ user: UserDto }>(`/api/users/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteUser() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`),
    onSuccess: invalidate,
  });
}
