/**
 * Lot 4 — copie hors-site dans l'onglet Sauvegardes : état des copies par archive (saine, en
 * cours), original disparu mais rapatriable (menu « Rapatrier » → POST), carte de réglage (machine
 * de copie, copies conservées) → PUT.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackupDto, BackupReplicaDto, ServerDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
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
  runState: 'stopped',
  desiredState: 'stopped',
  attachMode: 'attached',
  lastExitReason: null,
  autoRestart: true,
  crashLoopMax: 3,
  watchdogFreezeS: 120,
  pid: null,
  startedAt: null,
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

const alive: BackupDto = {
  id: 'bk1',
  serverId: 's1',
  policyId: null,
  kind: 'manual',
  status: 'success',
  machineId: 'm1',
  archivePath: 'E:/backups/s1/bk1.tar.gz',
  sizeBytes: 734_003_200,
  sha256: 'a'.repeat(64),
  startedAt: 1_787_330_455_000,
  finishedAt: 1_787_330_500_000,
  error: null,
  createdBy: 'u1',
  codec: 'gzip',
  hot: false,
  files: 1842,
  bytesRaw: 1_288_490_188,
  comment: null,
  taskId: 't0',
  verifiedAt: null,
  verifyStatus: null,
};
const gone: BackupDto = { ...alive, id: 'bk9', status: 'deleted', startedAt: 1_787_200_000_000 };

const copyOfGone: BackupReplicaDto = {
  id: 'rep1',
  backupId: 'bk9',
  serverId: 's1',
  machineId: 'm2',
  status: 'success',
  archivePath: '/pi/backups/s1/bk9.tar.gz',
  sizeBytes: 734_003_200,
  sha256: 'a'.repeat(64),
  taskId: 't8',
  startedAt: 1_787_200_100_000,
  finishedAt: 1_787_200_200_000,
  error: null,
};
const copyInFlight: BackupReplicaDto = {
  ...copyOfGone,
  id: 'rep2',
  backupId: 'bk1',
  status: 'running',
  archivePath: null,
  sizeBytes: null,
  sha256: null,
  finishedAt: null,
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

function installFetch(calls: Call[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      await Promise.resolve();
      if (path === '/api/auth/me') return json(200, { user: admin });
      if (path === '/api/machines') {
        return json(200, {
          machines: [
            { id: 'm1', name: 'Tour', status: 'online' },
            { id: 'm2', name: 'Pi', status: 'online' },
          ],
        });
      }
      if (path === '/api/servers/s1/backups' && method === 'GET') {
        return json(200, {
          backups: [alive, gone],
          policies: [],
          replication: {
            serverId: 's1',
            machineId: 'm2',
            keepLast: 3,
            enabled: true,
            updatedAt: 1,
          },
          replicas: [copyOfGone, copyInFlight],
        });
      }
      if (path === '/api/servers/s1/replication' && method === 'PUT') {
        return json(200, { replication: { serverId: 's1', updatedAt: 2, ...(body as object) } });
      }
      if (path === '/api/servers/s1/backups/bk9/replicas/rep1/pull') {
        return json(202, { task: { id: 't9', kind: 'backup.receive', status: 'running' } });
      }
      if (path.startsWith('/api/tasks')) return json(200, { tasks: [] });
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

describe('BackupsPanel — copie hors-site', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
    installFetch(calls);
    render(
      <MantineProvider>
        <Notifications />
        <ModalsProvider>
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <BackupsPanel server={server} />
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>,
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('montre l’état des copies, propose de rapatrier un original disparu, enregistre le réglage', async () => {
    const user = userEvent.setup();
    expect(await screen.findByTestId('backup-replica-rep2')).toHaveTextContent(
      'Copie vers Pi en cours',
    );
    expect(screen.getByTestId('backup-replica-rep1')).toHaveTextContent('Copie sur Pi');
    expect(screen.getByTestId('backup-original-gone-bk9')).toBeInTheDocument();
    // L'original disparu n'a ni téléchargement ni restauration : seulement le rapatriement.
    await user.click(screen.getByTestId('backup-actions-bk9'));
    expect(screen.queryByTestId('backup-restore-bk9')).toBeNull();
    await user.click(await screen.findByTestId('backup-pull-rep1'));
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.path === '/api/servers/s1/backups/bk9/replicas/rep1/pull',
        ),
      ).toBe(true);
    });
    // Réglage : machine de copie présélectionnée, copies conservées modifiées → PUT.
    expect(screen.getByTestId('replication-machine')).toHaveValue('Pi');
    fireEvent.change(screen.getByTestId('replication-keep'), { target: { value: '5' } });
    await user.click(screen.getByTestId('replication-save'));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/servers/s1/replication');
      expect(put?.body).toEqual({ machineId: 'm2', keepLast: 5, enabled: true });
    });
  });
});
