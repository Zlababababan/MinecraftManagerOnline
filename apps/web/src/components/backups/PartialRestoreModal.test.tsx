/**
 * Lot 4 — modale de restauration partielle contre une API simulée : arbre construit depuis le
 * parcours (dossiers d'abord), sélection par préfixe (un dossier coché grise ses enfants, un enfant
 * coché rend le parent indéterminé), côte à côte par défaut (POST sans sécurité ni relance), en
 * place (avertissement d'arrêt, sécurité + relance cochées), agent N-1 (501 → message dédié), et
 * les fonctions pures de sélection et de filtre.
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackupBrowseResponse, BackupDto, ServerDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import {
  PartialRestoreModal,
  buildTree,
  selectionStateOf,
  summarizeSelection,
  toggleSelection,
} from './PartialRestoreModal.js';

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
  files: 5,
  bytesRaw: 115,
  comment: null,
  taskId: 't0',
  verifiedAt: null,
  verifyStatus: null,
};

const LISTING: BackupBrowseResponse = {
  entries: [
    { path: 'mods', kind: 'dir', size: 5, files: 1 },
    { path: 'world', kind: 'dir', size: 107, files: 2, modifiedAt: 1_787_330_455_000 },
    { path: 'world/region', kind: 'dir', size: 100, files: 1, truncated: true },
    { path: 'mods/a.jar', kind: 'file', size: 5 },
    { path: 'server.properties', kind: 'file', size: 3 },
    { path: 'world/level.dat', kind: 'file', size: 7 },
    { path: 'world/region/r.0.0.mca', kind: 'file', size: 100 },
  ],
  totalFiles: 5,
  totalBytes: 115,
  truncated: true,
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

function installFetch(calls: Call[], browseStatus = 200): void {
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
      if (path === '/api/servers/s1/backups/bk1/browse') {
        return browseStatus === 200
          ? json(200, LISTING)
          : json(browseStatus, { code: 'E_UNSUPPORTED_TYPE', message: 'unsupported type' });
      }
      if (path === '/api/servers/s1/backups/bk1/restore-paths') {
        return json(200, { task: { id: 't3', kind: 'backup.restorePaths', status: 'running' } });
      }
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderModal(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={qc}>
        <PartialRestoreModal server={server} backup={backup} onClose={onClose} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return onClose;
}

describe('PartialRestoreModal', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
    installFetch(calls);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fonctions pures : arbre (dossiers d’abord), filtre avec ancêtres, états de sélection, résumé', () => {
    const tree = buildTree(LISTING.entries);
    expect(tree.map((n) => n.value)).toEqual(['mods', 'world', 'server.properties']);
    expect(tree[1]?.children?.map((n) => n.value)).toEqual(['world/region', 'world/level.dat']);
    expect(tree[2]?.children).toBeUndefined();
    const filtered = buildTree(LISTING.entries, 'LEVEL');
    expect(filtered.map((n) => n.value)).toEqual(['world']);
    expect(filtered[0]?.children?.map((n) => n.value)).toEqual(['world/level.dat']);

    const one = toggleSelection('world/level.dat', new Set());
    expect(selectionStateOf('world', one)).toBe('partial');
    expect(selectionStateOf('world/level.dat', one)).toBe('checked');
    const parent = toggleSelection('world', one);
    expect([...parent]).toEqual(['world']);
    expect(selectionStateOf('world/level.dat', parent)).toBe('inherited');
    expect(selectionStateOf('world/region/r.0.0.mca', parent)).toBe('inherited');
    expect(selectionStateOf('mods', parent)).toBe('none');
    // Un enfant hérité ne se décoche pas seul ; décocher le parent libère tout.
    expect([...toggleSelection('world/level.dat', parent)]).toEqual(['world']);
    expect(toggleSelection('world', parent).size).toBe(0);
    expect(summarizeSelection(new Set(['world', 'mods/a.jar']), LISTING.entries)).toEqual({
      paths: 2,
      files: 3,
      bytes: 112,
    });
  });

  it('côte à côte par défaut : un dossier coché grise ses enfants, POST sans sécurité ni relance', async () => {
    const user = userEvent.setup();
    const onClose = renderModal();
    expect(await screen.findByTestId('restore-path-world')).toBeInTheDocument();
    expect(screen.getByTestId('partial-restore-truncated')).toBeInTheDocument();
    expect(screen.getByTestId('partial-restore-confirm')).toBeDisabled();
    await user.click(screen.getByTestId('restore-path-world'));
    expect(screen.getByTestId('partial-restore-summary').textContent).toMatch(/^1 sélectionné/);
    // Déplier « world » : ses enfants sont cochés et grisés (hérités).
    await user.click(screen.getByText('world'));
    const region = await screen.findByTestId('restore-path-world/region');
    expect(region).toBeChecked();
    expect(region).toBeDisabled();
    await user.click(screen.getByTestId('partial-restore-confirm'));
    await waitFor(() => {
      expect(calls.some((c) => c.path.endsWith('/restore-paths'))).toBe(true);
    });
    expect(calls.find((c) => c.path.endsWith('/restore-paths'))?.body).toEqual({
      paths: ['world'],
      mode: 'side_by_side',
      safetyBackup: false,
      restartAfter: false,
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('en place : avertissement d’arrêt, sécurité et relance cochées par défaut', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByTestId('restore-path-server.properties'));
    await user.click(screen.getByTestId('partial-restore-inplace'));
    expect(await screen.findByText(/sera arrêté pendant la restauration/)).toBeInTheDocument();
    expect(screen.getByTestId('partial-restore-safety')).toBeChecked();
    expect(screen.getByTestId('partial-restore-restart')).toBeChecked();
    await user.click(screen.getByTestId('partial-restore-confirm'));
    await waitFor(() => {
      expect(calls.some((c) => c.path.endsWith('/restore-paths'))).toBe(true);
    });
    expect(calls.find((c) => c.path.endsWith('/restore-paths'))?.body).toEqual({
      paths: ['server.properties'],
      mode: 'in_place',
      safetyBackup: true,
      restartAfter: true,
    });
  });

  it('agent N-1 : le 501 devient « mettez à jour l’agent », rien à restaurer', async () => {
    vi.unstubAllGlobals();
    installFetch(calls, 501);
    renderModal();
    expect(await screen.findByTestId('partial-restore-unsupported')).toHaveTextContent(
      /mettez à jour l’agent/,
    );
    expect(screen.getByTestId('partial-restore-confirm')).toBeDisabled();
    expect(screen.queryByTestId('partial-restore-tree')).not.toBeInTheDocument();
  });
});
