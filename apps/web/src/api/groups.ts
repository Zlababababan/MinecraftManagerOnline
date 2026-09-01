/**
 * Groupes de démarrage (lot 7) : liste/CRUD des groupes, action ordonnée (202 — la progression
 * se lit sur les états serveurs diffusés en temps réel), et affectation d'un serveur à un groupe
 * (le PATCH serveur existant porte `groupId`/`groupPosition`).
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { GroupAction, ServerDto, ServerGroupDto } from '@mmo/protocol/client';

import { api } from './client.js';
import { keys } from './queries.js';

export const groupKeys = {
  all: ['groups'] as const,
};

export interface GroupsResult {
  groups: ServerGroupDto[];
}

export const groupsQuery = queryOptions({
  queryKey: groupKeys.all,
  queryFn: ({ signal }) => api.get<GroupsResult>('/api/groups', signal),
  staleTime: 30_000,
});

export const useGroups = () => useQuery(groupsQuery);

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<{ group: ServerGroupDto }>('/api/groups', { name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: groupKeys.all });
    },
  });
}

export function useRenameGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) =>
      api.patch<{ group: ServerGroupDto }>(`/api/groups/${groupId}`, { name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: groupKeys.all });
    },
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => api.delete(`/api/groups/${groupId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: groupKeys.all });
      void qc.invalidateQueries({ queryKey: keys.servers });
    },
  });
}

export function useGroupAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, action }: { groupId: string; action: GroupAction }) =>
      api.post<{ accepted: boolean }>(`/api/groups/${groupId}/action`, { action }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.servers });
    },
  });
}

/** Affectation / rang d'un serveur dans un groupe (PATCH serveur, pas une route dédiée). */
export function useAssignGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      serverId,
      ...body
    }: {
      serverId: string;
      groupId?: string | null;
      groupPosition?: number;
    }) => api.patch<{ server: ServerDto }>(`/api/servers/${serverId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.servers });
    },
  });
}
