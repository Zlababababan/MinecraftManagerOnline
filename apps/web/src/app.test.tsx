/**
 * Tests d'intégration du front (jsdom) : routeur + gardes + pages clés contre une API simulée.
 * first-run → wizard ; sans session → login ; login → dashboard (machine, carte serveur, start).
 */
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  scoped: false,
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

/** Plus loin dans l’alphabet que « Vanilla », mais en panne : les deux tris s’opposent. */
const crashed: ServerDto = { ...server, id: 's2', name: 'Zombie', runState: 'crashed' };

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
  address: string | null;
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
        case 'GET /api/groups':
          return json(200, { groups: [] });
        case 'GET /api/machines/m1':
          return json(200, { machine });
        case 'GET /api/events':
          return json(200, { events: [] });
        case 'POST /api/servers/s1/start':
          return json(200, {
            pid: 42,
            server: { ...server, runState: 'starting', desiredState: 'running' },
          });
        case 'PUT /api/servers/s1/favorite': {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            favorite: boolean;
          };
          state.servers = state.servers.map((x) =>
            x.id === 's1' ? { ...x, favorite: body.favorite } : x,
          );
          return json(200, { server: state.servers.find((x) => x.id === 's1') });
        }
        case 'GET /api/servers/s1/address':
          return json(200, {
            address: {
              exposeMode: 'direct',
              address: state.address,
              host: state.address === null ? null : '2001:db8::1',
              port: 25565,
              source: state.address === null ? 'none' : 'detected',
              alternatives: [],
            },
          });
        case 'POST /api/machines': {
          const created: MachineDto = {
            ...machine,
            id: 'm2',
            name: 'Nouvelle',
            status: 'pending',
            connected: false,
            watchedDirectories: [],
          };
          state.machines = [...state.machines, created];
          return json(200, {
            machine: created,
            pairing: { machineId: 'm2', code: 'ABCD1234', expiresAt: 1 },
          });
        }
        case 'POST /api/machines/m2/directories': {
          const directory = { id: 'd2', path: 'E:\\srv', enabled: true, lastScanAt: null };
          state.machines = state.machines.map((m) =>
            m.id === 'm2' ? { ...m, watchedDirectories: [directory] } : m,
          );
          return json(200, { directory });
        }
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
  return { history, queryClient };
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
      address: '[2001:db8::1]:25565',
    };
    installFetch(state);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useRealtimeStore.getState().reset();
    localStorage.clear();
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
    // Sans répertoire surveillé sur la machine, il n'y a nulle part où créer : pas de bouton.
    expect(screen.queryByTestId('dashboard-create-server')).not.toBeInTheDocument();
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
  it('vue de flotte : le choix cartes/tableau est mémorisé d’une visite à l’autre', async () => {
    const user = userEvent.setup();
    state.session = true;
    state.servers = [server, crashed];
    // Une ancienne mémoire « tableau », écrite sans avoir été choisie, ne compte plus.
    localStorage.setItem('mmo-list-servers', JSON.stringify({ mode: 'table' }));
    renderApp('/servers');
    // Les cartes d’abord : les actions sous la main, comme partout ailleurs.
    expect(await screen.findByTestId('servers-cards')).toBeInTheDocument();
    expect(screen.queryByTestId('servers-table')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Tableau'));
    expect(await screen.findByTestId('servers-table')).toBeInTheDocument();
    expect(screen.queryByTestId('servers-cards')).not.toBeInTheDocument();

    // On quitte tout et on revient : le panel doit se souvenir de l’affichage choisi.
    cleanup();
    renderApp('/servers');
    expect(await screen.findByTestId('servers-table')).toBeInTheDocument();
  });

  it('vue de flotte : le tri mémorisé s’applique, l’URL garde le dernier mot', async () => {
    state.session = true;
    localStorage.setItem(
      'mmo-list-server-list',
      JSON.stringify({ mode: 'table', sort: 'state', desc: false }),
    );
    state.servers = [server, crashed];
    renderApp('/servers');
    await screen.findByTestId('servers-table');
    // Tri par état : ce qui demande de l’attention d’abord.
    expect(
      screen.getAllByTestId(/^servers-row-/).map((r) => r.getAttribute('data-testid')),
    ).toEqual(['servers-row-s2', 'servers-row-s1']);

    // Un lien partagé ou un favori porte son propre tri : il prime sur la mémoire de l’appareil.
    cleanup();
    renderApp('/servers?sort=name');
    await screen.findByTestId('servers-table');
    expect(
      screen.getAllByTestId(/^servers-row-/).map((r) => r.getAttribute('data-testid')),
    ).toEqual(['servers-row-s1', 'servers-row-s2']);
  });
  it('tableau de bord : ce qui se passe maintenant, créer un serveur, et la liste complète à un clic', async () => {
    const user = userEvent.setup();
    state.session = true;
    state.machines = [
      {
        ...machine,
        watchedDirectories: [{ id: 'd1', path: 'E:\\srv', enabled: true, lastScanAt: 1 }],
      },
    ];
    state.servers = [
      { ...server, id: 's-run', name: 'En jeu', runState: 'running' },
      crashed,
      { ...server, id: 's3', name: 'Aventure', stoppedAt: 50 },
      { ...server, id: 's4', name: 'Bac à sable', stoppedAt: 90 },
      { ...server, id: 's5', name: 'Créatif', provisioning: 'install_failed' },
      ...Array.from({ length: 8 }, (_, i) => ({
        ...server,
        id: `old-${String(i)}`,
        name: `Ancien ${String(i)}`,
        stoppedAt: 10 + i,
      })),
    ];
    renderApp('/');
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
    const names = (testId: string) =>
      within(screen.getByTestId(testId))
        .getAllByTestId('server-card')
        .map((card) => card.getAttribute('data-server-id'));
    await waitFor(() => {
      expect(names('dashboard-active')).toEqual(['s-run']);
    });
    // Planté ou installation ratée : à regarder, et nulle part ailleurs.
    expect(names('dashboard-attention')).toEqual(expect.arrayContaining([crashed.id, 's5']));
    expect(names('dashboard-attention')).toHaveLength(2);
    // Les derniers utilisés d'abord, six au plus — plus jamais la liste entière.
    expect(names('dashboard-recent')).toHaveLength(6);
    expect(names('dashboard-recent').slice(0, 2)).toEqual(['s4', 's3']);
    expect(screen.getAllByTestId('server-card')).toHaveLength(9);
    expect(screen.queryByTestId('dashboard-servers-search')).not.toBeInTheDocument();
    // La machine reste là, résumée.
    expect(screen.getAllByTestId('machine-group')).toHaveLength(1);

    // Créer un serveur d'ici, sans passer par la page de la machine.
    await user.click(screen.getByTestId('dashboard-create-server'));
    expect(await screen.findByTestId('install-loader')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // La liste complète est à un clic.
    const all = screen.getByTestId('dashboard-all-servers');
    expect(all).toHaveTextContent('Tous les serveurs (13)');
    await user.click(all);
    expect(await screen.findByTestId('servers-page')).toBeInTheDocument();
  });
  it('une seule machine : pas d’entrée « Machines » au menu, sa page est dans Réglages', async () => {
    const user = userEvent.setup();
    state.session = true;
    const { history } = renderApp('/settings');
    expect(await screen.findByTestId('settings-page')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('nav-machines')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('nav-servers')).toBeInTheDocument();
    // Cinq sections, rangées par besoin ; la première ouverte est « Joueurs et réseau ».
    expect(screen.getByTestId('settings-section-network')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('machine-page')).not.toBeInTheDocument();

    const tab = await screen.findByTestId('settings-section-machine');
    expect(tab).toHaveTextContent('Machine (Tour)');
    await user.click(tab);
    expect(await screen.findByTestId('machine-page')).toHaveAttribute('data-machine-id', 'm1');
    expect(history.location.search).toContain('section=machine');
  });

  it('plusieurs machines : l’entrée « Machines » revient, et Réglages n’a plus de section Machine', async () => {
    state.session = true;
    state.machines = [machine, { ...machine, id: 'm9', name: 'Grenier' }];
    // Un vieux lien vers la section Machine retombe sur la première section, pas sur du vide.
    renderApp('/settings?section=machine');
    expect(await screen.findByTestId('settings-page')).toBeInTheDocument();
    expect(await screen.findByTestId('nav-machines')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('settings-section-machine')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-section-network')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('machine-page')).not.toBeInTheDocument();
  });

  it('page serveur : cinq onglets visibles, les autres sous « Plus »', async () => {
    const user = userEvent.setup();
    state.session = true;
    const { history } = renderApp('/servers/s1');
    expect(await screen.findByTestId('server-page')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((el) => el.getAttribute('data-testid'))).toEqual([
      'tab-overview',
      'tab-console',
      'tab-players',
      'tab-config',
      'tab-backups',
    ]);
    // Fermé, le menu ne montre rien ; son bouton dit « Plus ».
    expect(screen.queryByTestId('tab-events')).not.toBeInTheDocument();
    const more = screen.getByTestId('tab-more');
    expect(more).toHaveTextContent('Plus');
    expect(more).toHaveAttribute('data-active', 'false');

    await user.click(more);
    for (const name of ['metrics', 'files', 'schedule', 'logs', 'events', 'settings']) {
      expect(await screen.findByTestId(`tab-${name}`)).toBeInTheDocument();
    }
    await user.click(screen.getByTestId('tab-events'));
    await waitFor(() => {
      expect(history.location.search).toContain('tab=events');
    });
    // L'onglet ouvert par le menu se lit sur le bouton : on sait toujours où l'on est.
    await waitFor(() => {
      expect(screen.getByTestId('tab-more')).toHaveTextContent('Événements');
    });
    expect(screen.getByTestId('tab-more')).toHaveAttribute('data-active', 'true');
  });

  it('carte serveur : étoile, console et adresse à donner aux amis', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    state.session = true;
    state.servers = [{ ...server, id: 's0', name: 'Aaa' }, server];
    renderApp('/servers');
    const cardIds = () =>
      screen.getAllByTestId('server-card').map((c) => c.getAttribute('data-server-id'));
    await waitFor(() => {
      expect(cardIds()).toEqual(['s0', 's1']);
    });
    // userEvent installe son propre presse-papiers : on l’espionne après coup.
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    const card = within(screen.getAllByTestId('server-card')[1]!);

    // Épingler : le serveur passe en tête de la liste.
    const star = card.getByTestId('favorite-s1');
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await user.click(star);
    await waitFor(() => {
      expect(cardIds()).toEqual(['s1', 's0']);
    });
    expect(state.calls).toContain('PUT /api/servers/s1/favorite');
    expect(screen.getByTestId('favorite-s1')).toHaveAttribute('aria-pressed', 'true');

    // La console est à un clic, l’adresse aussi — demandée au panel seulement au clic.
    const pinned = within(screen.getAllByTestId('server-card')[0]!);
    expect(pinned.getByTestId('card-console')).toHaveAttribute('href', '/servers/s1?tab=console');
    expect(state.calls).not.toContain('GET /api/servers/s1/address');
    await user.click(pinned.getByTestId('card-copy-address'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('[2001:db8::1]:25565');
    });
    expect(await screen.findByText('Adresse copiée : [2001:db8::1]:25565')).toBeInTheDocument();
  });

  it('carte serveur : sans adresse connue, on le dit au lieu de copier du vide', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    state.session = true;
    state.address = null;
    renderApp('/servers');
    const button = await screen.findByTestId('card-copy-address');
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    await user.click(button);
    expect(await screen.findByText(/Aucune adresse connue pour ce serveur/)).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('page machine : pas de liste de serveurs, un lien vers la liste filtrée sur la machine', async () => {
    const user = userEvent.setup();
    state.session = true;
    const other: MachineDto = { ...machine, id: 'm9', name: 'Grenier' };
    state.machines = [machine, other];
    state.servers = [server, crashed, { ...server, id: 's9', name: 'Ailleurs', machineId: 'm9' }];
    renderApp('/machines/m1');
    expect(await screen.findByTestId('machine-page')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('machine-servers-count')).toHaveTextContent('2 serveurs');
    });
    // Une fonction = un seul endroit : ni cartes, ni tableau, ni recherche ici.
    expect(screen.queryByTestId('server-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('servers-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('machine-servers-search')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('machine-servers-link'));
    expect(await screen.findByTestId('servers-page')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getAllByTestId('server-card').map((c) => c.getAttribute('data-server-id')),
      ).toEqual(['s1', 's2']);
    });
    expect(screen.getByTestId('servers-count')).toHaveTextContent('2 sur 3');
  });

  it('page Serveurs : créer un serveur d’ici quand une machine est prête, sinon pas de bouton', async () => {
    const user = userEvent.setup();
    state.session = true;
    // Aucun répertoire surveillé : nulle part où créer.
    renderApp('/servers');
    expect(await screen.findByTestId('servers-cards')).toBeInTheDocument();
    expect(screen.queryByTestId('servers-create-server')).not.toBeInTheDocument();
    expect(screen.getByTestId('servers-add-machine')).toHaveAttribute('href', '/machines?add=true');

    cleanup();
    state.machines = [
      {
        ...machine,
        watchedDirectories: [{ id: 'd1', path: 'E:\\srv', enabled: true, lastScanAt: 1 }],
      },
    ];
    renderApp('/servers');
    await user.click(await screen.findByTestId('servers-create-server'));
    expect(await screen.findByTestId('install-loader')).toBeInTheDocument();
  });

  it('ajouter une machine : la fenêtre enchaîne sur le dossier puis sur « Créer un serveur »', async () => {
    const user = userEvent.setup();
    state.session = true;
    const { queryClient } = renderApp('/machines?add=true');
    await user.type(await screen.findByTestId('machine-name'), 'Nouvelle');
    await user.click(screen.getByTestId('machine-create'));
    expect(await screen.findByTestId('pairing-code')).toHaveTextContent('ABCD1234');
    // L’agent n’est pas encore là : on attend, sans rien proposer d’autre.
    const next = screen.getByTestId('after-pairing');
    expect(next).toHaveAttribute('data-step', 'waiting');
    expect(screen.queryByTestId('after-pairing-directory')).not.toBeInTheDocument();
    expect(screen.queryByTestId('after-pairing-create-server')).not.toBeInTheDocument();

    // L’agent se connecte (en vrai : événement temps réel « agent.online »).
    state.machines = state.machines.map((m) =>
      m.id === 'm2' ? { ...m, status: 'online', connected: true } : m,
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['machines'] });
    });
    await waitFor(() => {
      expect(next).toHaveAttribute('data-step', 'directory');
    });
    expect(screen.queryByTestId('after-pairing-create-server')).not.toBeInTheDocument();

    await user.type(screen.getByTestId('after-pairing-directory'), 'E:\\srv');
    await user.click(screen.getByTestId('after-pairing-directory-add'));
    await waitFor(() => {
      expect(next).toHaveAttribute('data-step', 'ready');
    });
    expect(state.calls).toContain('POST /api/machines/m2/directories');
    expect(screen.queryByTestId('after-pairing-directory')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('after-pairing-create-server'));
    expect(await screen.findByTestId('install-loader')).toBeInTheDocument();
  });
});
