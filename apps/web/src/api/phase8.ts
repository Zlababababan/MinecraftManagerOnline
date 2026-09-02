/**
 * Phase 8 — requêtes et mutations : tasks (suivi, annulation), sauvegardes (créer, restaurer,
 * supprimer, télécharger, politiques), planificateur du panel, upload de fichiers (XHR pour la
 * progression), spark en un clic, sauvegardes du panel.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  BackupDto,
  BackupPolicyDto,
  BackupPolicyInput,
  PanelBackupDto,
  PanelBackupStatus,
  ScheduledTaskDto,
  ScheduledTaskInput,
  SparkStatus,
  TaskDto,
} from '@mmo/protocol/client';
import { apiErrorSchema } from '@mmo/protocol/client';

import { ApiRequestError, NetworkError, api } from './client.js';
import { keys } from './queries.js';

export const phase8Keys = {
  tasks: ['tasks'] as const,
  activeTasks: ['tasks', 'active'] as const,
  serverTasks: (id: string) => ['tasks', 'server', id] as const,
  backups: (id: string) => ['servers', id, 'backups'] as const,
  schedules: (id: string) => ['servers', id, 'schedules'] as const,
  allSchedules: ['schedules'] as const,
  spark: (id: string) => ['servers', id, 'spark'] as const,
  panelBackups: ['admin', 'backups'] as const,
};

export interface BackupsResult {
  backups: BackupDto[];
  policies: BackupPolicyDto[];
}

export const activeTasksQuery = queryOptions({
  queryKey: phase8Keys.activeTasks,
  queryFn: ({ signal }) => api.get<{ tasks: TaskDto[] }>('/api/tasks?active=true', signal),
  staleTime: 15_000,
});

export const serverTasksQuery = (id: string) =>
  queryOptions({
    queryKey: phase8Keys.serverTasks(id),
    queryFn: ({ signal }) =>
      api.get<{ tasks: TaskDto[] }>(
        `/api/tasks?serverId=${encodeURIComponent(id)}&limit=50`,
        signal,
      ),
    staleTime: 15_000,
  });

export const backupsQuery = (id: string) =>
  queryOptions({
    queryKey: phase8Keys.backups(id),
    queryFn: ({ signal }) => api.get<BackupsResult>(`/api/servers/${id}/backups`, signal),
    staleTime: 15_000,
  });

export const schedulesQuery = (id: string) =>
  queryOptions({
    queryKey: phase8Keys.schedules(id),
    queryFn: ({ signal }) =>
      api.get<{ schedules: ScheduledTaskDto[] }>(`/api/servers/${id}/schedules`, signal),
    staleTime: 15_000,
  });

export const sparkQuery = (id: string) =>
  queryOptions({
    queryKey: phase8Keys.spark(id),
    queryFn: ({ signal }) => api.get<SparkStatus>(`/api/servers/${id}/spark`, signal),
    staleTime: 60_000,
  });

export const panelBackupsQuery = queryOptions({
  queryKey: phase8Keys.panelBackups,
  queryFn: ({ signal }) =>
    api.get<{ backups: PanelBackupDto[]; directory: string; status: PanelBackupStatus }>(
      '/api/admin/backups',
      signal,
    ),
  staleTime: 30_000,
});

export const useActiveTasks = () => useQuery(activeTasksQuery);
export const useServerTasks = (id: string) => useQuery(serverTasksQuery(id));
export const useBackups = (id: string) => useQuery(backupsQuery(id));
export const useSchedules = (id: string) => useQuery(schedulesQuery(id));
export const useSpark = (id: string, enabled = true) => useQuery({ ...sparkQuery(id), enabled });
export const usePanelBackups = (enabled = true) => useQuery({ ...panelBackupsQuery, enabled });

/** URLs de téléchargement (liens directs : le navigateur gère la progression et la reprise). */
export const backupDownloadUrl = (serverId: string, backupId: string): string =>
  `/api/servers/${serverId}/backups/${backupId}/download`;
export const fileDownloadUrl = (serverId: string, path: string): string =>
  `/api/servers/${serverId}/files/download?path=${encodeURIComponent(path)}`;

// --- Mutations ------------------------------------------------------------------------------------

export function useCreateBackup(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { comment?: string }) =>
      api.post<{ task: TaskDto; backup: BackupDto }>(`/api/servers/${serverId}/backups`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: phase8Keys.backups(serverId) });
      void qc.invalidateQueries({ queryKey: phase8Keys.tasks });
    },
  });
}

export function useRestoreBackup(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      backupId,
      ...body
    }: {
      backupId: string;
      safetyBackup: boolean;
      restartAfter: boolean;
    }) => api.post<{ task: TaskDto }>(`/api/servers/${serverId}/backups/${backupId}/restore`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: phase8Keys.backups(serverId) });
      void qc.invalidateQueries({ queryKey: phase8Keys.tasks });
    },
  });
}

export function useDeleteBackup(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) =>
      api.delete<{ deleted: boolean; backup: BackupDto }>(
        `/api/servers/${serverId}/backups/${backupId}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: phase8Keys.backups(serverId) }),
  });
}

export function useCancelTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      api.post<{ cancelled: boolean; task: TaskDto }>(`/api/tasks/${taskId}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: phase8Keys.tasks }),
  });
}

export function useBackupPolicyMutations(serverId: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: phase8Keys.backups(serverId) });
  const create = useMutation({
    mutationFn: (body: BackupPolicyInput) =>
      api.post<{ policy: BackupPolicyDto }>(`/api/servers/${serverId}/backup-policies`, body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ policyId, ...body }: Partial<BackupPolicyInput> & { policyId: string }) =>
      api.put<{ policy: BackupPolicyDto }>(
        `/api/servers/${serverId}/backup-policies/${policyId}`,
        body,
      ),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (policyId: string) =>
      api.delete(`/api/servers/${serverId}/backup-policies/${policyId}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

export function useScheduleMutations(serverId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: phase8Keys.schedules(serverId) });
    void qc.invalidateQueries({ queryKey: phase8Keys.allSchedules });
  };
  const create = useMutation({
    mutationFn: (body: ScheduledTaskInput) =>
      api.post<{ schedule: ScheduledTaskDto }>(`/api/servers/${serverId}/schedules`, body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ scheduleId, ...body }: Partial<ScheduledTaskInput> & { scheduleId: string }) =>
      api.put<{ schedule: ScheduledTaskDto }>(
        `/api/servers/${serverId}/schedules/${scheduleId}`,
        body,
      ),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (scheduleId: string) =>
      api.delete(`/api/servers/${serverId}/schedules/${scheduleId}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

export function useInstallSpark(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ task: TaskDto }>(`/api/servers/${serverId}/spark/install`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: phase8Keys.spark(serverId) });
      void qc.invalidateQueries({ queryKey: phase8Keys.tasks });
    },
  });
}

export function usePanelBackupNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ backup: PanelBackupDto }>('/api/admin/backups'),
    onSuccess: () => qc.invalidateQueries({ queryKey: phase8Keys.panelBackups }),
  });
}

/**
 * Upload d'un fichier vers le dossier du serveur (corps binaire brut, progression via XHR —
 * `fetch` ne l'expose pas). Résout `{ sha256, size }` ; rejette `ApiRequestError`/`NetworkError`.
 */
export function uploadFile(
  serverId: string,
  path: string,
  file: Blob,
  options: {
    overwrite?: boolean;
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ path, size: String(file.size) });
    if (options.overwrite) qs.set('overwrite', 'true');
    xhr.open('PUT', `/api/servers/${serverId}/files/upload?${qs.toString()}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded, e.total);
    };
    xhr.onerror = () => {
      reject(new NetworkError(new Error('upload failed')));
    };
    xhr.onabort = () => {
      reject(new NetworkError(new Error('upload aborted')));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as { sha256: string; size: number });
        return;
      }
      const parsed = apiErrorSchema.safeParse(xhr.response);
      reject(
        new ApiRequestError(
          xhr.status,
          parsed.success
            ? parsed.data
            : { code: 'E_INTERNAL', message: `HTTP ${String(xhr.status)}` },
        ),
      );
    };
    options.signal?.addEventListener('abort', () => {
      xhr.abort();
    });
    xhr.send(file);
  });
}

export function invalidateAfterUpload(
  qc: ReturnType<typeof useQueryClient>,
  serverId: string,
): void {
  void qc.invalidateQueries({ queryKey: keys.filesAll(serverId) });
}
