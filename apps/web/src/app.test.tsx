/**
 * Tests d'intégration du front (jsdom) : routeur + gardes + pages clés contre une API simulée.
 * first-run → wizard ; sans session → login ; login → dashboard (machine, carte serveur, start).
 */
import { createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessStatusDto, MachineDto, ServerDto, UserDto } from '@mmo/protocol/client';

import { App, createQueryClient } from './app.js';
import { i18n } from './i18n/index.js';
import { useRealtimeStore } from './store/realtime.js';

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
const machine: MachineDto = {
  id: 'm1',
  name: 'Tour',
  os: 'windows',
  arch: 'x64',
  hostname: 'tour',
  agentVersion: '0.3.0',
  protocolVersion: 1,
  status: 'online',
  connected: true,
  lastSeenAt: 1,
  cpuModel: 'cpu',
  cpuCores: 8,
  ramTotalMb: 32768,
  createdAt: 0,
  heartbeat: {
    ts: 1,
    cpuPct: 10,
    ramUsedMb: 8192,
    ramTotalMb: 32768,
    activeServers: 0,
    activeTasks: 0,
  },
  watchedDirectories: [],
};
const server: ServerDto = {
  id: 's1',
  machineId: 'm1',
  directoryId: null,
  path: 'E:\\srv\\Vanilla',
  name: 'Vanilla',
  loader: 'vanilla',
  mcVersion: '1.20.1',
  loaderVersion: null,
  detected: true,
  javaMajorRequired: 17,
  javaArgs: [],
  minRamMb: 1024,
  maxRamMb: 4096,
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

const access: AccessStatusDto = {
  mode: 'tailscale',
  publicUrl: 'https://tour.tailnet.ts.net',
  listen: { host: '127.0.0.1', port: 3100 },
  https: { listening: false, port: null },
  tailscaleServeCommand: null,
  direct: null,
  lastTest: { at: 1, ok: true, via: 'tailscale' },
  requestVia: 'direct',
};

interface FakeApi {
  needsSetup: boolean;
  session: boolean;
  calls: string[];
  machines: MachineDto[];
  servers: ServerDto[];
  access: AccessStatusDto | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(state: FakeApi): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const pathname = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
      state.calls.push(`${method} ${pathname}`);
      await Promise.resolve();
      if (pathname === '/api/setup/status') return json(200, { needsSetup: state.needsSetup });
      if (pathname === '/api/auth/login') {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          username: string;
          password: string;
        };
        if (body.password !== 'correct horse battery') {
          return json(401, { code: 'E_AUTH', message: 'invalid credentials' });
        }
        state.session = true;
        return json(200, { user: admin });
      }
      if (!state.session) {
        return json(401, {
          code: 'E_AUTH',
          message: 'authentication required',
          details: { setupRequired: state.needsSetup },
        });
      }
      switch (`${method} ${pathname}`) {
        case 'GET /api/auth/me':
          return json(200, { user: admin });
        case 'GET /api/machines':
          return json(200, { machines: state.machines });
        case 'GET /api/servers':
          return json(200, { servers: state.servers });
        case 'GET /api/access':
          return state.access === null
            ? json(404, { code: 'E_NOT_FOUND', message: 'no access status' })
            : json(200, { access: state.access });
        case 'GET /api/servers/s1':
          return json(200, { server });
        case 'GET /api/servers/s1/players':
          return json(200, { online: 0, max: null, players: [] });
        case 'GET /api/servers/s1/command-history':
          return json(200, { history: [] });
        case 'GET /api/servers/conflicts':
          return json(200, { conflicts: [] });
        case 'GET /api/events':
          return json(200, { events: [] });
        case 'POST /api/servers/s1/start':
          return json(200, {
            pid: 42,
            server: { ...server, runState: 'starting', desiredState: 'running' },
          });
        case 'PATCH /api/auth/me':
          return json(200, { user: admin });
        default:
          return json(404, { code: 'E_NOT_FOUND', message: `no route ${pathname}` });
      }
    }),
  );
}

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: unknown;
  onmessage: unknown;
  onclose: unknown;
  onerror: unknown;
  send(): void {
    // noop
  }
  close(): void {
    // noop
  }
}

function renderApp(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = createQueryClient();
  render(<App queryClient={queryClient} history={history} pwa={false} />);
  return { history };
}

describe('App', () => {
  let state: FakeApi;
  beforeEach(async () => {
    state = {
      needsSetup: false,
      session: false,
      calls: [],
      machines: [machine],
      servers: [server],
      access: null,
    };
    installFetch(state);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useRealtimeStore.getState().reset();
  });

  it('first-run : toute page protégée redirige vers le wizard', async () => {
    state.needsSetup = true;
    const { history } = renderApp('/machines');
    expect(await screen.findByTestId('setup')).toBeInTheDocument();
    expect(history.location.pathname).toBe('/setup');
    expect(screen.getByText('Bienvenue')).toBeInTheDocument();
  });

  it('sans session : redirection vers /login avec retour, puis login → dashboard → start', async () => {
    const user = userEvent.setup();
    const { history } = renderApp('/servers/s1?tab=players');
    expect(await screen.findByTestId('login')).toBeInTheDocument();
    expect(history.location.pathname).toBe('/login');
    expect(history.location.search).toContain('redirect=');

    await user.type(screen.getByTestId('login-username'), 'admin');
    await user.type(screen.getByTestId('login-password'), 'wrong');
    await user.click(screen.getByTestId('login-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Échec de l’authentification.');

    await user.clear(screen.getByTestId('login-password'));
    await user.type(screen.getByTestId('login-password'), 'correct horse battery');
    await user.click(screen.getByTestId('login-submit'));
    // Retour vers la page demandée (page serveur), puis dashboard via la navigation.
    await waitFor(() => {
      expect(history.location.pathname).toBe('/servers/s1');
    });
    expect(await screen.findByTestId('server-page')).toBeInTheDocument();
    expect(history.location.search).toContain('tab=players');
    expect(screen.getByTestId('server-name')).toHaveTextContent('Vanilla');
    expect(screen.getByTestId('run-state')).toHaveAttribute('data-state', 'stopped');

    await user.click(screen.getByTestId('nav-dashboard'));
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('stat-machines')).toHaveTextContent('1');
    expect(screen.getByTestId('machine-link')).toHaveTextContent('Tour');
    // Fraîcheur du heartbeat affichée (ts=1 → ancien, donc « il y a … »).
    expect(screen.getByTestId('machine-updated')).toHaveTextContent(/^Mis à jour il y a /);
    const card = screen.getByTestId('server-card');
    expect(card).toHaveTextContent('Vanilla');

    await user.click(screen.getByTestId('action-start'));
    await waitFor(() => {
      expect(state.calls).toContain('POST /api/servers/s1/start');
    });
    expect(await screen.findByText('Démarrage')).toBeInTheDocument();
  });

  it('premiers pas : panel vierge → quatre étapes non faites et bouton d’ajout', async () => {
    state.session = true;
    state.machines = [];
    state.servers = [];
    renderApp('/');
    expect(await screen.findByTestId('onboarding')).toBeInTheDocument();
    for (const step of ['machine', 'connected', 'directory', 'server']) {
      expect(screen.getByTestId(`onboarding-step-${step}`)).toHaveAttribute('data-done', 'false');
    }
    expect(screen.getByTestId('onboarding-add-machine')).toBeInTheDocument();
    // Pas de machine → pas de bouton « ouvrir la machine », et pas d'accès chargé → pas de ligne.
    expect(screen.queryByTestId('onboarding-open-connected')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-access')).not.toBeInTheDocument();
  });

  it('premiers pas : étapes partielles, bouton vers la machine, ligne d’accès distant', async () => {
    state.session = true;
    state.machines = [{ ...machine, watchedDirectories: [] }];
    state.servers = [];
    state.access = access;
    renderApp('/');
    expect(await screen.findByTestId('onboarding')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-step-machine')).toHaveAttribute('data-done', 'true');
    expect(screen.getByTestId('onboarding-step-connected')).toHaveAttribute('data-done', 'true');
    expect(screen.getByTestId('onboarding-step-directory')).toHaveAttribute('data-done', 'false');
    expect(screen.getByTestId('onboarding-step-server')).toHaveAttribute('data-done', 'false');
    expect(screen.getByTestId('onboarding-open-directory')).toHaveAttribute('href', '/machines/m1');
    const line = await screen.findByTestId('onboarding-access');
    expect(line).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('onboarding-access-settings')).toHaveAttribute('href', '/settings');
  });

  it('premiers pas : tout vert → la carte disparaît', async () => {
    state.session = true;
    state.machines = [
      {
        ...machine,
        watchedDirectories: [{ id: 'd1', path: 'E:\\srv', enabled: true, lastScanAt: 1 }],
      },
    ];
    renderApp('/');
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
    expect(await screen.findByTestId('server-card')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument();
  });

  it('accessibilité : lien d’évitement, h1 de page, région live qui annonce un événement', async () => {
    state.session = true;
    renderApp('/');
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('skip-link')).toHaveAttribute('href', '#main');
    expect(screen.getByRole('heading', { level: 1, name: 'Tableau de bord' })).toBeInTheDocument();
    // La région existe et annonce déjà la transition de connexion du montage.
    const announcer = screen.getByTestId('live-announcer');
    act(() => {
      useRealtimeStore.getState().pushEvent({
        id: 1,
        ts: 1,
        type: 'agent.offline',
        severity: 'warning',
        machineId: 'm1',
        serverId: null,
        userId: null,
        payload: {},
      });
    });
    await waitFor(() => {
      expect(announcer).toHaveTextContent('Tour — Agent hors ligne');
    });
  });

  it('bascule de langue : l’interface passe en anglais', async () => {
    state.session = true;
    const user = userEvent.setup();
    renderApp('/');
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument();
    await user.click(screen.getByTestId('lang-menu'));
    await user.click(await screen.findByTestId('lang-en'));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });
});
