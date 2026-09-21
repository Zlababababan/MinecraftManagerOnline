/**
 * Explorateur de fichiers : filtrer un dossier long (un `mods/` réel en compte des centaines),
 * et surtout NE PAS emporter le filtre dans le dossier suivant — un filtre invisible ferait
 * passer un dossier plein pour un dossier vide.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FsEntryDto, ServerDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { FileExplorer } from './FileExplorer.js';

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

const server: ServerDto = {
  id: 's1',
  machineId: 'm1',
  directoryId: null,
  path: '/srv/a',
  name: 'A',
  loader: 'forge',
  mcVersion: '1.20.1',
  loaderVersion: '47.2.0',
  detected: true,
  javaMajorRequired: 17,
  javaArgs: [],
  minRamMb: 1024,
  maxRamMb: 2048,
  cpuPriority: 'normal',
  gamePort: 25565,
  rconEnabled: false,
  rconPort: null,
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

const file = (name: string): FsEntryDto => ({ name, kind: 'file', size: 4096, modifiedAt: 1 });
const dir = (name: string): FsEntryDto => ({ name, kind: 'dir' });

const ROOT: FsEntryDto[] = [
  dir('config'),
  file('jei-1.20.1.jar'),
  file('journeymap.jar'),
  file('create.jar'),
  file('sodium.jar'),
  file('iris.jar'),
];
const CONFIG: FsEntryDto[] = [
  file('jei-client.toml'),
  file('create-common.toml'),
  file('forge-server.toml'),
  file('sodium-options.json'),
  file('iris.properties'),
];

let root: FsEntryDto[] = ROOT;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      await Promise.resolve();
      if (path === '/api/auth/me') return json(200, { user: admin });
      if (path.startsWith('/api/servers/s1/files?path=')) {
        const wanted = decodeURIComponent(path.split('path=')[1] ?? '');
        return json(200, { path: wanted, entries: wanted === '' ? root : CONFIG });
      }
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderExplorer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <ModalsProvider>
          <FileExplorer server={server} />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('FileExplorer — filtrer un dossier', () => {
  beforeEach(async () => {
    root = ROOT;
    installFetch();
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filtre le dossier courant et repart à zéro dans le dossier suivant', async () => {
    const user = userEvent.setup();
    renderExplorer();
    expect(await screen.findByTestId('file-jei-1.20.1.jar')).toBeInTheDocument();

    await user.type(screen.getByTestId('files-search'), 'jei');
    await waitFor(() => {
      expect(screen.queryByTestId('file-create.jar')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('file-jei-1.20.1.jar')).toBeInTheDocument();
    expect(screen.queryByTestId('file-config')).not.toBeInTheDocument();

    // Un dossier vidé par le filtre le dit, au lieu de se faire passer pour vide.
    await user.clear(screen.getByTestId('files-search'));
    await user.type(screen.getByTestId('files-search'), 'zzz');
    expect(await screen.findByTestId('files-empty')).toHaveTextContent(
      'Aucun résultat pour cette recherche.',
    );

    // On entre dans un dossier avec un filtre actif : il ne doit pas le suivre. « c » laisse
    // passer le dossier lui-même, et masquerait `forge-server.toml` s'il survivait.
    await user.clear(screen.getByTestId('files-search'));
    await user.type(screen.getByTestId('files-search'), 'c');
    // La ligne porte deux boutons : le nom et le menu. On vise le nom.
    await user.click(
      within(await screen.findByTestId('file-config')).getByRole('button', { name: 'config' }),
    );
    expect(await screen.findByTestId('file-forge-server.toml')).toBeInTheDocument();
    expect(screen.getByTestId('files-search')).toHaveValue('');
  });

  it('pas de barre de filtre dans un dossier court', async () => {
    root = [file('server.properties'), file('eula.txt'), dir('world')];
    renderExplorer();
    expect(await screen.findByTestId('file-eula.txt')).toBeInTheDocument();
    // Trois entrées : on voit déjà tout, une barre serait du bruit.
    expect(screen.queryByTestId('files-search')).not.toBeInTheDocument();
  });
});
