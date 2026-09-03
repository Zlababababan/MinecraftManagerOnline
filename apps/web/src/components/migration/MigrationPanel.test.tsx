/**
 * Carte et modale de migration contre une API simulée : historique, ouverture de la modale (admin),
 * choix de la cible, pré-checks affichés (Java manquant ⇒ bouton désactivé tant que « installer Java »
 * n'est pas coché), lancement (POST avec `installJava`), progression projetée par `migration.update`.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MachineDto, MigrationDto, ServerDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { applyMigrationUpdate } from '../../store/realtime.js';
import { MigrationsCard } from './MigrationPanel.js';

const server: ServerDto = {
  id: 's1',
  machineId: 'm1',
  directoryId: null,
  path: 'E:/Minecraft/Survie',
  name: 'Survie',
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
  scoped: false,
};

const machine = (id: string, name: string): MachineDto => ({
  id,
  name,
  os: 'linux',
  arch: 'arm64',
  hostname: name,
  agentVersion: '0.9.0',
  protocolVersion: 1,
  status: 'online',
  connected: true,
  lastSeenAt: 0,
  cpuModel: null,
  cpuCores: 4,
  ramTotalMb: 8192,
  createdAt: 0,
  watchedDirectories: [{ id: `${id}-dir`, path: `/srv/${name}`, enabled: true, lastScanAt: null }],
});

const done: MigrationDto = {
  id: 'mig0',
  serverId: 's1',
  fromMachineId: 'm0',
  toMachineId: 'm1',
  toDirectoryId: null,
  sourcePath: '/old/Survie.migrated-20260801-1200',
  toPath: 'E:/Minecraft/Survie',
  backupId: 'bk0',
  status: 'done',
  progressPct: 100,
  mode: 'direct',
  exportTaskId: 't1',
  importTaskId: 't2',
  restartAfter: true,
  startedAt: 1_787_330_455_000,
  finishedAt: 1_787_330_600_000,
  error: null,
  createdBy: 'u1',
  kind: 'migrate',
  targetServerId: null,
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
      calls.push({
        method,
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      await Promise.resolve();
      if (path === '/api/auth/me') return json(200, { user: admin });
      if (path === '/api/machines') {
        return json(200, { machines: [machine('m1', 'Tour'), machine('m2', 'Pi')] });
      }
      if (path === '/api/servers/s1/migrations' && method === 'GET') {
        return json(200, {
          migrations: [
            done,
            { ...done, id: 'dup0', kind: 'duplicate', targetServerId: 's2', toMachineId: 'm1' },
          ],
        });
      }
      if (path === '/api/servers/s1/duplicate/precheck') {
        return json(200, {
          precheck: {
            ok: true,
            toPath: '/srv/Tour/Survie (copie)',
            gamePort: 25_566,
            path: { ok: true },
            port: { ok: true },
            java: { ok: true },
            disk: { ok: true, freeBytes: 50_000_000_000, requiredBytes: 1_000_000 },
          },
        });
      }
      if (path === '/api/servers/s1/duplicate' && method === 'POST') {
        return json(202, {
          migration: {
            ...done,
            id: 'dup1',
            toMachineId: 'm1',
            status: 'pending',
            progressPct: 0,
            kind: 'duplicate',
            targetServerId: 's2',
          },
        });
      }
      if (path === '/api/servers/s1/migrations/precheck') {
        return json(200, {
          precheck: {
            ok: false,
            toPath: '/srv/Pi/Survie',
            path: { ok: true },
            port: { ok: true },
            java: { ok: false, code: 'java_missing', installable: true },
            disk: { ok: true, freeBytes: 50_000_000_000, requiredBytes: 1_000_000 },
          },
        });
      }
      if (path === '/api/servers/s1/migrations' && method === 'POST') {
        return json(202, {
          migration: { ...done, id: 'mig1', toMachineId: 'm2', status: 'pending', progressPct: 0 },
        });
      }
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderCard(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <MantineProvider>
      <Notifications />
      <ModalsProvider>
        <QueryClientProvider client={qc}>
          <MigrationsCard server={server} />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
  return qc;
}

describe('MigrationsCard', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
    installFetch(calls);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('historique, pré-checks (Java manquant ⇒ installer Java requis), lancement, progression', async () => {
    const user = userEvent.setup();
    const qc = renderCard();
    const row = await screen.findByTestId('migration-mig0');
    expect(row).toHaveAttribute('data-status', 'done');
    expect(row.textContent).toContain('direct');

    await user.click(await screen.findByTestId('migration-open'));
    const select = await screen.findByTestId('migration-target');
    await user.click(select);
    await user.click(await screen.findByText('Pi'));
    await user.click(screen.getByTestId('migration-precheck'));
    await screen.findByTestId('precheck-list');
    expect(calls.some((c) => c.path === '/api/servers/s1/migrations/precheck')).toBe(true);
    expect(calls.find((c) => c.path === '/api/servers/s1/migrations/precheck')?.body).toEqual({
      toMachineId: 'm2',
    });
    expect(screen.getByTestId('check-Runtime Java')).toHaveAttribute('data-ok', 'false');
    expect(screen.getByText(/installable/)).toBeInTheDocument();
    const start = screen.getByTestId('migration-start');
    expect(start).toBeDisabled();

    // Cocher « installer le Java manquant » débloque le lancement.
    await user.click(screen.getByLabelText('Installer le Java manquant sur la cible'));
    expect(start).toBeEnabled();
    await user.click(start);
    await waitFor(() => {
      expect(
        calls.find((c) => c.path === '/api/servers/s1/migrations' && c.method === 'POST'),
      ).toBeDefined();
    });
    expect(
      calls.find((c) => c.path === '/api/servers/s1/migrations' && c.method === 'POST')?.body,
    ).toEqual({ toMachineId: 'm2', restartAfter: true, installJava: true });

    // Progression projetée par le WebSocket dans le cache.
    applyMigrationUpdate(qc, {
      ...done,
      id: 'mig1',
      fromMachineId: 'm1',
      toMachineId: 'm2',
      status: 'transferring',
      progressPct: 42,
      mode: 'relay',
    });
    const active = await screen.findByTestId('migration-active');
    expect(active).toHaveAttribute('data-status', 'transferring');
    expect(active.textContent).toContain('Tour → Pi');
    expect(active.textContent).toContain('relayé');
    // Migration en cours : le bouton « Migrer » est désactivé.
    expect(screen.getByTestId('migration-open')).toBeDisabled();
  });

  it('duplication : nom pré-rempli, machine actuelle par défaut, port retenu, POST avec le nom', async () => {
    const user = userEvent.setup();
    renderCard();
    // L'historique distingue une copie d'une migration.
    expect((await screen.findByTestId('migration-dup0')).textContent).toContain('Copie');

    await user.click(await screen.findByTestId('duplicate-open'));
    const name = await screen.findByTestId('duplicate-name');
    expect(name).toHaveValue('Survie (copie)');
    await user.click(screen.getByTestId('duplicate-precheck'));
    await screen.findByTestId('precheck-list');
    // La machine actuelle est la cible par défaut (dupliquer sur place = cas nominal).
    expect(calls.find((c) => c.path === '/api/servers/s1/duplicate/precheck')?.body).toEqual({
      toMachineId: 'm1',
      name: 'Survie (copie)',
    });
    expect(screen.getByTestId('duplicate-port-chosen').textContent).toContain('25566');

    const start = screen.getByTestId('duplicate-start');
    expect(start).toBeEnabled();
    await user.click(start);
    await waitFor(() => {
      expect(
        calls.find((c) => c.path === '/api/servers/s1/duplicate' && c.method === 'POST'),
      ).toBeDefined();
    });
    expect(
      calls.find((c) => c.path === '/api/servers/s1/duplicate' && c.method === 'POST')?.body,
    ).toEqual({ toMachineId: 'm1', name: 'Survie (copie)', installJava: false });
  });
});
