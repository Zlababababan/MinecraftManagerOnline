/**
 * Phase 10 — requêtes et mutations : push (clé VAPID, abonnements, test), préférences et centre de
 * notifications, couche d'accès (statut, test de joignabilité, certificat, DynDNS, pare-feu),
 * réglages admin, adresse à donner aux amis et joignabilité d'un serveur.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AccessStatusDto,
  AccessTestResult,
  CertificateDto,
  FirewallRulesDto,
  NotificationChannelPrefsDto,
  NotificationPrefsDto,
  NotificationPrefsPut,
  NotificationsResult,
  PushStatusDto,
  PushSubscribeInput,
  PushSubscriptionDto,
  ReachabilityResult,
  ServerAddressDto,
  EDITABLE_SETTINGS,
} from '@mmo/protocol/client';

import { api } from './client.js';
import { keys } from './queries.js';

export type SettingKey = (typeof EDITABLE_SETTINGS)[number];
export type SettingsPatch = Partial<Record<SettingKey, string>>;

export const phase10Keys = {
  push: ['push'] as const,
  prefs: ['notifications', 'prefs'] as const,
  notifications: ['notifications', 'list'] as const,
  access: ['access'] as const,
  firewall: ['access', 'firewall'] as const,
  settings: ['settings'] as const,
  address: (serverId: string) => ['servers', serverId, 'address'] as const,
};

export const pushQuery = queryOptions({
  queryKey: phase10Keys.push,
  queryFn: ({ signal }) => api.get<PushStatusDto>('/api/push', signal),
  staleTime: 30_000,
});
export const prefsQuery = queryOptions({
  queryKey: phase10Keys.prefs,
  queryFn: ({ signal }) =>
    api.get<{ prefs: NotificationPrefsDto; channels?: NotificationChannelPrefsDto }>(
      '/api/notifications/prefs',
      signal,
    ),
  staleTime: 60_000,
});
export const notificationsQuery = queryOptions({
  queryKey: phase10Keys.notifications,
  queryFn: ({ signal }) => api.get<NotificationsResult>('/api/notifications?limit=50', signal),
  staleTime: 15_000,
});
export const accessQuery = queryOptions({
  queryKey: phase10Keys.access,
  queryFn: ({ signal }) => api.get<{ access: AccessStatusDto }>('/api/access', signal),
  staleTime: 30_000,
});
export const firewallQuery = queryOptions({
  queryKey: phase10Keys.firewall,
  queryFn: ({ signal }) => api.get<{ rules: FirewallRulesDto }>('/api/access/firewall', signal),
  staleTime: 30_000,
});
export const settingsQuery = queryOptions({
  queryKey: phase10Keys.settings,
  queryFn: ({ signal }) => api.get<{ settings: Record<string, string> }>('/api/settings', signal),
  staleTime: 30_000,
});
export const serverAddressQuery = (serverId: string) =>
  queryOptions({
    queryKey: phase10Keys.address(serverId),
    queryFn: ({ signal }) =>
      api.get<{ address: ServerAddressDto }>(`/api/servers/${serverId}/address`, signal),
    staleTime: 30_000,
  });

export const usePushStatus = (enabled = true) => useQuery({ ...pushQuery, enabled });
export const useNotificationPrefs = () => useQuery(prefsQuery);
export const useNotifications = () => useQuery(notificationsQuery);
export const useAccessStatus = (enabled = true) => useQuery({ ...accessQuery, enabled });
export const useFirewallRules = (enabled = true) => useQuery({ ...firewallQuery, enabled });
export const useSettings = (enabled = true) => useQuery({ ...settingsQuery, enabled });
export const useServerAddress = (serverId: string) => useQuery(serverAddressQuery(serverId));

// --- Push ------------------------------------------------------------------------------------------

export function usePushSubscribe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PushSubscribeInput) =>
      api.post<{ subscription: PushSubscriptionDto }>('/api/push/subscribe', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: phase10Keys.push });
    },
  });
}

export function usePushUnsubscribe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (endpoint: string) =>
      api.post<{ removed: boolean }>('/api/push/unsubscribe', { endpoint }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: phase10Keys.push });
    },
  });
}

export function usePushTest() {
  return useMutation({
    mutationFn: () => api.post<{ sent: number; failed: number }>('/api/push/test', {}),
  });
}

// --- Préférences et centre -------------------------------------------------------------------------

export function useSetNotificationPrefs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationPrefsPut) =>
      api.put<{ channels: NotificationChannelPrefsDto }>('/api/notifications/prefs', body),
    // La réponse ne porte que `channels` : le cache est rafraîchi plutôt que remplacé, sinon
    // `prefs` (réglage commun hérité) disparaîtrait de la requête en cours.
    onSuccess: (data) => {
      queryClient.setQueryData(
        phase10Keys.prefs,
        (old: { prefs: NotificationPrefsDto } | undefined) =>
          old === undefined ? undefined : { ...old, channels: data.channels },
      );
      void queryClient.invalidateQueries({ queryKey: phase10Keys.notifications });
    },
  });
}

export function useMarkNotificationsSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<{ seenId: number }>('/api/notifications/seen', { id }),
    onSuccess: (data) => {
      queryClient.setQueryData<NotificationsResult>(phase10Keys.notifications, (old) =>
        old === undefined
          ? old
          : {
              ...old,
              seenId: data.seenId,
              unread: old.notifications.filter((n) => n.id > data.seenId).length,
            },
      );
    },
  });
}

// --- Accès et réglages -----------------------------------------------------------------------------

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) =>
      api.patch<{ settings: Record<string, string> }>('/api/settings', patch),
    onSuccess: (data) => {
      queryClient.setQueryData(phase10Keys.settings, data);
      void queryClient.invalidateQueries({ queryKey: phase10Keys.access });
      void queryClient.invalidateQueries({ queryKey: phase10Keys.firewall });
      void queryClient.invalidateQueries({ queryKey: keys.machines });
    },
  });
}

export function useAccessTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (url?: string) =>
      api.post<{ result: AccessTestResult }>('/api/access/test', url === undefined ? {} : { url }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: phase10Keys.access });
    },
  });
}

export function useIssueCertificate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ certificate: CertificateDto }>('/api/access/certificate', {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: phase10Keys.access });
    },
  });
}

export function useUpdateDynDns() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ address: string | null }>('/api/access/dyndns', {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: phase10Keys.access });
    },
  });
}

export function useServerReachability(serverId: string) {
  return useMutation({
    mutationFn: (address?: string) =>
      api.post<{ result: ReachabilityResult }>(
        `/api/servers/${serverId}/reachability`,
        address === undefined ? {} : { address },
      ),
  });
}
