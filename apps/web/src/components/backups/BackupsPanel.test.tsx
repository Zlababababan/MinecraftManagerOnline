/**
 * Onglet Sauvegardes contre une API simulée : liste (genre, taille, état, à chaud), création (modal
 * → POST), restauration (modal avec backup de sécurité et relance → POST), politiques (fréquence
 * décrite en français + rotation), progression d'une task active projetée par `task.update`.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackupDto, BackupPolicyDto, ServerDto, TaskDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { applyTaskUpdate } from '../../store/realtime.js';
import { BackupsPanel } from './BackupsPanel.js';

const server: ServerDto = {
  id: 's1',
  machineId: 'm1',
  directoryId: null,
  path: '/srv/a',
  name: 'A',
  loader: 'forge',
  mcVersion: '1.20.1',
  loaderVersion: null,
  detected: true,
  javaMajorRequired: 17,
  javaArgs: [],
  minRamMb: 1024,
  maxRamMb: 2048,
  gamePort: 25565,
  rconEnabled: true,
  rconPort: 25575,
  eulaAccepted: true,
  exposeMode: 'tailnet',
  provisioning: 'ready',
  runState: 'running',
  desiredState: 'running',
  attachMode: 'attached',
  lastExitReason: null,
  autoRestart: true,
  crashLoopMax: 3,
  watchdogFreezeS: 120,
  pid: 1,
  startedAt: 0,
  stoppedAt: null,
  createdAt: 0,
  updatedAt: 0,
  reachable: true,
  groupId: null,
  groupPosition: 0,
};

const admin: UserDto = {
  id: 'u1',
  username: 'admin',
  role: 'admin',
  locale: 'fr',
  theme: 'dark',
  isActive: true,
  createdAt: 0,
  lastLoginAt: null,
};

const backup: BackupDto = {
  id: 'bk1',
  serverId: 's1',
  policyId: null,
  kind: 'manual',
  status: 'success',
  machineId: 'm1',
  archivePath: 'E:/backups/s1/bk1.tar.zst',
  sizeBytes: 734_003_200,
  sha256: 'a'.repeat(64),
  startedAt: 1_787_330_455_000,
  finishedAt: 1_787_330_500_000,
  error: null,
  createdBy: 'u1',
  codec: 'zstd',
  hot: true,
  files: 1842,
  bytesRaw: 1_288_490_188,
  comment: 'avant modpack',
  taskId: 't0',
  verifiedAt: null,
  verifyStatus: null,
};

const policy: BackupPolicyDto = {
  id: 'pol1',
  serverId: 's1',
  cron: '0 4 * * *',
  destination: null,
  keepLast: 7,
  keepDays: null,
  onlyIfRunning: false,
  enabled: true,
  createdAt: 0,
  nextRunAt: 1_787_400_000_000,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  overdueSince: null,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function installFetch(calls: Call[], backups: BackupDto[] = [backup]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      await Promise.resolve();
      if (path === '/api/auth/me') return json(200, { user: admin });
      if (path === '/api/servers/s1/backups' && method === 'GET') {
        return json(200, { backups, policies: [policy] });
      }
      if (path === '/api/servers/s1/backups' && method === 'POST') {
        return json(200, {
          task: { id: 't1', kind: 'backup.create', status: 'running' },
          backup: { ...backup, id: 'bk2', status: 'running' },
        });
      }
      if (path === '/api/servers/s1/backups/bk1/restore') {
        return json(200, { task: { id: 't2', kind: 'backup.restore', status: 'running' } });
      }
      if (path === '/api/servers/s1/backups/bk1/browse') {
        return json(200, {
          entries: [{ path: 'world', kind: 'dir', size: 10, files: 1 }],
          totalFiles: 1,
          totalBytes: 10,
          truncated: false,
        });
      }
      if (path.startsWith('/api/tasks')) return json(200, { tasks: [] });
      if (path === '/api/servers/s1/backup-policies' && method === 'POST') {
        return json(200, { policy: { ...policy, id: 'pol2' } });
      }
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderPanel(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <MantineProvider>
      <Notifications />
      <ModalsProvider>
        <QueryClientProvider client={qc}>
          <BackupsPanel server={server} />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
  return qc;
}

describe('BackupsPanel', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
    installFetch(calls);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('liste les sauvegardes (genre, taille, à chaud, commentaire) et les politiques', async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('backup-bk1')).toBeInTheDocument();
    });
    const row = screen.getByTestId('backup-bk1');
    expect(row).toHaveTextContent('Manuelle');
    expect(row).toHaveTextContent('700 MB');
    expect(row).toHaveTextContent('à chaud');
    expect(row).toHaveTextContent('avant modpack');
    expect(row).toHaveTextContent('1842 fichiers');
    // Planificateur v2 : la fréquence est décrite en français, plus d'expression cron visible.
    expect(screen.getByTestId('policy-pol1')).toHaveTextContent('Tous les jours à 04:00');
    expect(screen.getByTestId('policy-pol1')).not.toHaveTextContent('0 4 * * *');
    expect(screen.getByTestId('policy-pol1')).toHaveTextContent('garde les 7 dernières');
  });

  it('lot 4 : vérification — « pas encore vérifiée », date de relecture, ou badge « Corrompue »', async () => {
    vi.unstubAllGlobals();
    installFetch(calls, [
      backup,
      { ...backup, id: 'bk2', verifiedAt: 1_787_400_000_000, verifyStatus: 'ok' },
      { ...backup, id: 'bk3', verifiedAt: 1_787_400_000_000, verifyStatus: 'corrupted' },
    ]);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('backup-bk3')).toBeInTheDocument();
    });
    expect(screen.getByTestId('backup-verified-bk1')).toHaveTextContent('Pas encore vérifiée');
    expect(screen.getByTestId('backup-verified-bk2')).toHaveTextContent('Vérifiée');
    expect(screen.getByTestId('backup-verified-bk2')).not.toHaveTextContent('Pas encore');
    expect(screen.queryByTestId('backup-corrupted-bk2')).not.toBeInTheDocument();
    expect(screen.getByTestId('backup-corrupted-bk3')).toHaveTextContent('Corrompue');
    expect(screen.queryByTestId('backup-verified-bk3')).not.toBeInTheDocument();
  });

  it('crée une sauvegarde (modal → POST avec commentaire) et affiche la task active', async () => {
    const user = userEvent.setup();
    const qc = renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('backup-create')).toBeEnabled();
    });
    await user.click(screen.getByTestId('backup-create'));
    expect(await screen.findByText(/sauvegarde sera faite à chaud/)).toBeInTheDocument();
    await user.type(screen.getByTestId('backup-comment'), 'test');
    await user.click(screen.getByTestId('backup-create-confirm'));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/servers/s1/backups')).toBe(
        true,
      );
    });
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ comment: 'test' });

    // Progression poussée par le WebSocket : projetée dans le cache des tasks du serveur.
    const task: TaskDto = {
      id: 't1',
      kind: 'backup.create',
      machineId: 'm1',
      serverId: 's1',
      status: 'running',
      progress: 42,
      phase: 'archiving',
      detail: 'world/region',
      refId: 'bk2',
      result: null,
      error: null,
      createdBy: 'u1',
      createdAt: 0,
      finishedAt: null,
    };
    await waitFor(() => {
      expect(qc.getQueryData(['tasks', 'server', 's1'])).toBeDefined();
    });
    applyTaskUpdate(qc, task);
    await waitFor(() => {
      expect(screen.getByTestId('task-t1')).toHaveTextContent('Archivage');
    });
    expect(screen.getByTestId('task-t1')).toHaveTextContent('42 %');
    expect(screen.getByTestId('backup-create')).toBeDisabled();
    applyTaskUpdate(qc, { ...task, status: 'done', progress: 100, phase: null, detail: null });
    await waitFor(() => {
      expect(screen.queryByTestId('task-t1')).not.toBeInTheDocument();
    });
  });

  it('restaure en un clic : backup de sécurité et relance cochés par défaut', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('backup-actions-bk1')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('backup-actions-bk1'));
    await user.click(await screen.findByTestId('backup-restore-bk1'));
    expect(await screen.findByText(/sera arrêté pendant la restauration/)).toBeInTheDocument();
    await user.click(screen.getByTestId('restore-confirm'));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/servers/s1/backups/bk1/restore')).toBe(true);
    });
    expect(calls.find((c) => c.path.endsWith('/restore'))?.body).toEqual({
      safetyBackup: true,
      restartAfter: true,
    });
  });

  it('lot 4 : « Restaurer des fichiers… » ouvre la modale de restauration partielle et lit l’archive', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('backup-actions-bk1')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('backup-actions-bk1'));
    await user.click(await screen.findByTestId('backup-restore-paths-bk1'));
    expect(await screen.findByTestId('partial-restore')).toBeInTheDocument();
    expect(await screen.findByTestId('restore-path-world')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/servers/s1/backups/bk1/browse')).toBe(true);
  });

  it('ajoute une politique avec le préréglage quotidien', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('policy-new')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('policy-new'));
    // Sélecteur d'heure natif (un seul horaire par politique de sauvegarde).
    fireEvent.change(screen.getByTestId('policy-cron-time-0'), { target: { value: '03:30' } });
    expect(screen.getByTestId('policy-cron-preview')).toHaveTextContent('Prochaine exécution');
    await user.click(screen.getByTestId('policy-save'));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/servers/s1/backup-policies')).toBe(true);
    });
    expect(calls.find((c) => c.path === '/api/servers/s1/backup-policies')?.body).toEqual({
      cron: '30 3 * * *',
      keepLast: 7,
      keepDays: null,
      onlyIfRunning: false,
    });
  });
});
