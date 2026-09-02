/**
 * Lot 4 — webhooks sortants (admin) : liste, création (le secret d'un webhook JSON n'est renvoyé
 * qu'ici, une fois), modification, suppression, test immédiat, rotation du secret.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  WebhookCreateInput,
  WebhookDto,
  WebhookPatchInput,
  WebhookTestResult,
} from '@mmo/protocol/client';

import { api } from './client.js';

export const webhookKeys = { list: ['webhooks'] as const };

export const webhooksQuery = queryOptions({
  queryKey: webhookKeys.list,
  queryFn: () => api.get<{ webhooks: WebhookDto[] }>('/api/webhooks'),
  staleTime: 30_000,
});

export const useWebhooks = (enabled = true) => useQuery({ ...webhooksQuery, enabled });

function useInvalidateWebhooks(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: webhookKeys.list });
  };
}

export function useCreateWebhook() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: (input: WebhookCreateInput) =>
      api.post<{ webhook: WebhookDto; secret: string | null }>('/api/webhooks', input),
    onSuccess: invalidate,
  });
}

export function useUpdateWebhook() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: WebhookPatchInput }) =>
      api.patch<{ webhook: WebhookDto }>(`/api/webhooks/${encodeURIComponent(id)}`, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteWebhook() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ removed: boolean }>(`/api/webhooks/${encodeURIComponent(id)}`),
    onSuccess: invalidate,
  });
}

export function useTestWebhook() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ result: WebhookTestResult }>(`/api/webhooks/${encodeURIComponent(id)}/test`),
    onSettled: invalidate,
  });
}

export function useRotateWebhookSecret() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ secret: string }>(`/api/webhooks/${encodeURIComponent(id)}/secret`),
    onSuccess: invalidate,
  });
}
