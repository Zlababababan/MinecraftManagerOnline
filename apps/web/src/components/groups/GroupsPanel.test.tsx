/**
 * Modale des groupes de démarrage contre une API simulée : ordre d'affichage par rang, création,
 * action ordonnée (POST /action), réordonnancement par flèches (renumérotation 0..n-1 en PATCH
 * serveurs), et avertissement quand un proxy Velocity n'est pas en dernière position.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDto, ServerGroupDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { GroupsModal } from './GroupsPanel.js';

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

function server(
  id: string,
  name: string,
  position: number,
  loader: ServerDto['loader'],
): ServerDto {
  return {
    id,
    machineId: 'm1',
    directoryId: null,
    path: `E:/mc/${name}`,
    name,
    loader,
    mcVersion: loader === 'velocity' ? null : '1.20.1',
    loaderVersion: null,
    detected: true,
    javaMajorRequired: 17,
    javaArgs: [],
    minRamMb: 1024,
    maxRamMb: 2048,
    gamePort: 25565,
    rconEnabled: loader !== 'velocity',
    rconPort: null,
    eulaAccepted: true,
    exposeMode: 'tailnet',
    provisioning: 'ready',
    runState: 'stopped',
    desiredState: 'stopped',
    attachMode: 'attached',
    lastExitReason: null,
    autoRestart: false,
    crashLoopMax: 3,
    watchdogFreezeS: 120,
    pid: null,
    startedAt: null,
    stoppedAt: null,
    createdAt: 0,
    updatedAt: 0,
    reachable: true,
    groupId: 'g1',
    groupPosition: position,
  };
}

const group: ServerGroupDto = { id: 'g1', name: 'Réseau', createdAt: 0, updatedAt: 0 };

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

// Le proxy est volontairement en TÊTE (rang 0) : l'avertissement Velocity doit apparaître.
const fixtures = [
  server('s-proxy', 'Proxy', 0, 'velocity'),
  server('s-a', 'Survie', 1, 'vanilla'),
  server('s-b', 'Créatif', 2, 'vanilla'),
];

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
      if (path === '/api/groups' && method === 'GET') return json(200, { groups: [group] });
      if (path === '/api/groups' && method === 'POST') {
        return json(201, { group: { ...group, id: 'g2', name: 'Nouveau' } });
      }
      if (path === '/api/servers' && method === 'GET') return json(200, { servers: fixtures });
      if (path === '/api/groups/g1/action') return json(202, { accepted: true });
      if (path.startsWith('/api/servers/') && method === 'PATCH') {
        const id = path.split('/')[3] ?? '';
        return json(200, { server: fixtures.find((s) => s.id === id) ?? fixtures[0] });
      }
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <Notifications />
      <ModalsProvider>
        <QueryClientProvider client={qc}>
          <GroupsModal opened onClose={() => undefined} />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
  return qc;
}

describe('GroupsModal', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
    installFetch(calls);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('membres dans l’ordre des rangs, avertissement proxy pas en dernier, action ordonnée', async () => {
    const user = userEvent.setup();
    renderModal();
    const card = await screen.findByTestId('group-g1');
    // Ordre d'affichage = ordre de démarrage (rang croissant).
    const members = within(card)
      .getAllByTestId(/^group-member-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(members).toEqual(['group-member-s-proxy', 'group-member-s-a', 'group-member-s-b']);
    // Le proxy n'est pas en dernière position : l'avertissement le dit.
    expect(within(card).getByText(/proxy Velocity/)).toBeInTheDocument();

    await user.click(screen.getByTestId('group-start-g1'));
    await waitFor(() => {
      expect(calls.find((c) => c.path === '/api/groups/g1/action')).toBeDefined();
    });
    expect(calls.find((c) => c.path === '/api/groups/g1/action')?.body).toEqual({
      action: 'start',
    });
  });

  it('monter un serveur renumérote 0..n-1 par PATCH serveurs successifs', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('group-g1');
    await user.click(screen.getByTestId('group-up-s-a'));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'PATCH').length).toBeGreaterThanOrEqual(2);
    });
    const patches = calls
      .filter((c) => c.method === 'PATCH')
      .map((c) => [c.path.split('/')[3], c.body]);
    // Nouvel ordre voulu : Survie (0), Proxy (1), Créatif inchangé (2).
    expect(patches).toEqual([
      ['s-a', { groupPosition: 0 }],
      ['s-proxy', { groupPosition: 1 }],
    ]);
  });

  it('création d’un groupe (admin)', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('group-g1');
    await user.type(screen.getByTestId('groups-new-name'), 'Nouveau');
    await user.click(screen.getByTestId('groups-create'));
    await waitFor(() => {
      expect(calls.find((c) => c.path === '/api/groups' && c.method === 'POST')?.body).toEqual({
        name: 'Nouveau',
      });
    });
  });
});
