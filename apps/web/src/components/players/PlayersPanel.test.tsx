/**
 * Onglet Joueurs contre une API simulée : liste blanche vide → ajout d'un joueur (résolution UUID
 * puis `player.action`) → liste rafraîchie ; retrait ; pseudo inconnu signalé sans action.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { PlayersPanel } from './PlayersPanel.js';

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
const server: ServerDto = {
  id: 's1',
  machineId: 'm1',
  directoryId: null,
  path: '/srv/a',
  name: 'A',
  loader: 'vanilla',
  mcVersion: '1.20.1',
  loaderVersion: null,
  detected: true,
  javaMajorRequired: 17,
  javaArgs: [],
  minRamMb: 1024,
  maxRamMb: 2048,
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
};

interface FakeState {
  whitelist: { uuid: string; name: string }[];
  calls: { method: string; path: string; body?: unknown }[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(state: FakeState): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      state.calls.push({ method, path, body });
      await Promise.resolve();
      switch (`${method} ${path}`) {
        case 'GET /api/auth/me':
          return json(200, { user: admin });
        case 'GET /api/servers/s1/config/whitelist.json':
          return json(200, {
            file: 'whitelist.json',
            data: state.whitelist,
            sha256: 'a'.repeat(64),
            source: 'file',
          });
        case 'GET /api/servers/s1/config/server.properties':
          return json(200, {
            file: 'server.properties',
            data: { 'online-mode': 'false', 'white-list': 'false' },
            source: 'file',
          });
        case 'POST /api/servers/s1/players/resolve': {
          const names = (body as { names: string[] }).names;
          return json(200, {
            onlineMode: false,
            players: names.map((name) =>
              name === 'Ghost'
                ? { name, uuid: null, source: 'unknown' }
                : {
                    name,
                    uuid: `00000000-0000-3000-8000-${name.padStart(12, '0')}`,
                    source: 'offline',
                  },
            ),
          });
        }
        case 'POST /api/servers/s1/players/action': {
          const action = body as { action: string; target: string };
          if (action.action === 'whitelistAdd') {
            state.whitelist = [
              ...state.whitelist,
              {
                uuid: `00000000-0000-3000-8000-${action.target.padStart(12, '0')}`,
                name: action.target,
              },
            ];
          } else if (action.action === 'whitelistRemove') {
            state.whitelist = state.whitelist.filter((e) => e.name !== action.target);
          }
          return json(200, { applied: 'file' });
        }
        default:
          return json(404, { code: 'E_NOT_FOUND', message: `no route ${path}` });
      }
    }),
  );
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <ModalsProvider>
          <PlayersPanel server={server} />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('PlayersPanel — liste blanche sans jamais voir un fichier', () => {
  let state: FakeState;
  beforeEach(async () => {
    state = { whitelist: [], calls: [] };
    installFetch(state);
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ajoute puis retire un joueur ; pseudo inconnu signalé', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('players-view-whitelist'));
    expect(await screen.findByTestId('whitelist-empty')).toBeInTheDocument();
    expect(screen.getByTestId('whitelist-status')).toHaveTextContent('Liste blanche désactivée');

    await user.type(screen.getByTestId('whitelist-add-name'), 'Bob');
    await user.click(screen.getByTestId('whitelist-add-submit'));
    expect(await screen.findByTestId('whitelist-Bob')).toBeInTheDocument();
    expect(screen.getByTestId('whitelist-add-resolved')).toHaveTextContent('UUID mode hors ligne');
    expect(state.calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        'POST /api/servers/s1/players/resolve',
        'POST /api/servers/s1/players/action',
      ]),
    );
    expect(state.calls.find((c) => c.path.endsWith('/players/action'))?.body).toEqual({
      action: 'whitelistAdd',
      target: 'Bob',
    });

    // Pseudo inconnu : message, aucune action envoyée.
    const before = state.calls.length;
    await user.type(screen.getByTestId('whitelist-add-name'), 'Ghost');
    await user.click(screen.getByTestId('whitelist-add-submit'));
    expect(await screen.findByTestId('whitelist-add-unresolved')).toBeInTheDocument();
    expect(state.calls.slice(before).map((c) => c.path)).toEqual([
      '/api/servers/s1/players/resolve',
    ]);

    // Retrait avec confirmation.
    await user.click(within(screen.getByTestId('whitelist-Bob')).getByTestId('remove-Bob'));
    await user.click(await screen.findByTestId('confirm-remove'));
    await waitFor(() => {
      expect(screen.queryByTestId('whitelist-Bob')).not.toBeInTheDocument();
    });
    expect(state.whitelist).toEqual([]);
  });
});
