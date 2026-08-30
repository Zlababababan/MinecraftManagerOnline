/**
 * Phase 10 — centre de notifications (non-lus, « tout marquer comme lu », rafraîchi par un événement
 * temps réel), préférences (PUT partiel), carte push (onboarding iOS, navigateur sans support, push de
 * test) et carte « Accès joueurs » (adresse calculée, changement d'exposition, test de joignabilité).
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import type { EventDto, NotificationsResult, ServerDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { applyServerMessage } from '../../store/realtime.js';
import { PlayerAccessCard } from '../access/PlayerAccessCard.js';
import { NotificationCenter } from './NotificationCenter.js';
import { NotificationPrefsCard, PushCard } from './NotificationSettings.js';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => undefined,
}));

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
};

const crash: EventDto = {
  id: 10,
  ts: 1_787_330_455_000,
  type: 'server.stateChanged',
  severity: 'error',
  machineId: 'm1',
  serverId: 's1',
  userId: null,
  payload: { state: 'crashed', previous: 'running' },
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

function installFetch(
  calls: Call[],
  state: {
    seenId: number;
    prefs: Record<string, boolean>;
    channels: Record<string, Record<string, boolean>>;
    exposeMode: 'tailnet' | 'direct';
  },
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      await Promise.resolve();
      if (path === '/api/auth/me') return json(200, { user: admin });
      if (path === '/api/servers') return json(200, { servers: [server] });
      if (path === '/api/machines') return json(200, { machines: [] });
      if (path.startsWith('/api/notifications?')) {
        const list: NotificationsResult = {
          notifications: [crash],
          unread: crash.id > state.seenId ? 1 : 0,
          seenId: state.seenId,
        };
        return json(200, list);
      }
      if (path === '/api/notifications/seen') {
        state.seenId = (body as { id: number }).id;
        return json(200, { seenId: state.seenId });
      }
      if (path === '/api/notifications/prefs' && method === 'GET')
        return json(200, { prefs: state.prefs, channels: state.channels });
      if (path === '/api/notifications/prefs' && method === 'PUT') {
        const put = body as { channel?: string; values: Record<string, boolean> };
        for (const channel of put.channel === undefined ? ['inapp', 'push'] : [put.channel]) {
          Object.assign((state.channels[channel] ??= {}), put.values);
        }
        return json(200, { channels: state.channels });
      }
      if (path === '/api/push')
        return json(200, { vapidPublicKey: 'B'.repeat(87), subscriptions: [] });
      if (path === '/api/servers/s1/address') {
        return json(200, {
          address:
            state.exposeMode === 'tailnet'
              ? {
                  exposeMode: 'tailnet',
                  address: '100.101.102.103:25565',
                  host: '100.101.102.103',
                  port: 25565,
                  source: 'detected',
                  alternatives: ['[fd7a:115c:a1e0::1]:25565'],
                }
              : {
                  exposeMode: 'direct',
                  address: 'panel.example.org:25565',
                  host: 'panel.example.org',
                  port: 25565,
                  source: 'domain',
                  alternatives: [],
                },
        });
      }
      if (path === '/api/servers/s1' && method === 'PATCH') {
        state.exposeMode = (body as { exposeMode: 'tailnet' | 'direct' }).exposeMode;
        return json(200, { server: { ...server, exposeMode: state.exposeMode } });
      }
      if (path === '/api/servers/s1/reachability') {
        return json(200, {
          result: {
            address: '100.101.102.103:25565',
            ok: true,
            ms: 12,
            error: null,
            status: { version: '1.20.1', protocol: 763, online: 2, max: 20, motd: 'Hi' },
          },
        });
      }
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderWith(
  node: ReactNode,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MantineProvider>,
  );
  return qc;
}

describe('phase 10 — notifications et accès joueurs', () => {
  let calls: Call[];
  let state: {
    seenId: number;
    prefs: Record<string, boolean>;
    channels: Record<string, Record<string, boolean>>;
    exposeMode: 'tailnet' | 'direct';
  };
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
    state = {
      seenId: 0,
      prefs: { 'server.crashed': true, 'player.activity': false },
      channels: {
        inapp: { 'server.crashed': true, 'player.activity': false },
        push: { 'server.crashed': true, 'player.activity': false },
      },
      exposeMode: 'tailnet',
    };
    installFetch(calls, state);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('centre : non-lus, ouverture, libellé traduit, « tout marquer comme lu », rafraîchi par le temps réel', async () => {
    const user = userEvent.setup();
    const qc = renderWith(<NotificationCenter />);
    const indicator = await screen.findByTestId('notifications-indicator');
    await waitFor(() => {
      expect(indicator).toHaveAttribute('data-unread', '1');
    });
    await user.click(screen.getByTestId('notifications-open'));
    const row = await screen.findByTestId('notification-10');
    expect(row).toHaveAttribute('data-unread', 'true');
    expect(row.textContent).toContain('Survie');
    expect(screen.getByTestId('notifications-unread').textContent).toContain('1');
    await user.click(screen.getByTestId('notifications-mark-seen'));
    await waitFor(() => {
      expect(calls.find((c) => c.path === '/api/notifications/seen')?.body).toEqual({ id: 10 });
    });
    await waitFor(() => {
      expect(screen.getByTestId('notifications-indicator')).toHaveAttribute('data-unread', '0');
    });
    // Un nouvel événement notifiable invalide la liste (re-GET).
    const before = calls.filter((c) => c.path.startsWith('/api/notifications?')).length;
    applyServerMessage(qc, { type: 'event', event: { ...crash, id: 11 } });
    await waitFor(() => {
      expect(calls.filter((c) => c.path.startsWith('/api/notifications?')).length).toBeGreaterThan(
        before,
      );
    });
  });

  it('cliquer une notification la marque vue : la pastille disparaît', async () => {
    const user = userEvent.setup();
    renderWith(<NotificationCenter />);
    const indicator = await screen.findByTestId('notifications-indicator');
    await waitFor(() => {
      expect(indicator).toHaveAttribute('data-unread', '1');
    });
    await user.click(screen.getByTestId('notifications-open'));
    await user.click(await screen.findByTestId('notification-10'));
    await waitFor(() => {
      expect(calls.find((c) => c.path === '/api/notifications/seen')?.body).toEqual({ id: 10 });
    });
    await waitFor(() => {
      expect(screen.getByTestId('notifications-indicator')).toHaveAttribute('data-unread', '0');
    });
  });

  it('préférences : interrupteurs depuis l’API, PUT partiel', async () => {
    const user = userEvent.setup();
    renderWith(<NotificationPrefsCard />);
    const crashed = await screen.findByTestId('pref-push-server.crashed');
    await waitFor(() => {
      expect(crashed).toBeChecked();
    });
    // Un interrupteur par canal : la cloche et le téléphone se règlent séparément.
    expect(screen.getByTestId('pref-inapp-player.activity')).not.toBeChecked();
    expect(screen.getByTestId('pref-push-player.activity')).not.toBeChecked();
    await user.click(screen.getByTestId('pref-inapp-player.activity'));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        channel: 'inapp',
        values: { 'player.activity': true },
      });
    });
    // ...et seule la colonne cliquée bouge.
    await waitFor(() => {
      expect(screen.getByTestId('pref-inapp-player.activity')).toBeChecked();
    });
    expect(screen.getByTestId('pref-push-player.activity')).not.toBeChecked();
  });

  it('push : onboarding iOS quand la PWA n’est pas installée, navigateur sans support', async () => {
    renderWith(
      <PushCard
        support={{
          supported: false,
          reason: 'ios-not-installed',
          ios: true,
          standalone: false,
          permission: 'default',
        }}
      />,
    );
    expect(await screen.findByTestId('push-ios-onboarding')).toBeInTheDocument();
    expect(screen.getAllByText(/écran d’accueil/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('push-enable')).toBeDisabled();
    await screen.findByTestId('push-no-devices');
  });

  it('push : bouton actif quand le support est là et la clé VAPID disponible', async () => {
    renderWith(
      <PushCard
        support={{ supported: true, ios: false, standalone: false, permission: 'default' }}
      />,
    );
    const enable = await screen.findByTestId('push-enable');
    await waitFor(() => {
      expect(enable).toBeEnabled();
    });
    expect(screen.queryByTestId('push-ios-onboarding')).toBeNull();
  });

  it('accès joueurs : adresse calculée, bascule tailnet → direct, test de joignabilité', async () => {
    const user = userEvent.setup();
    renderWith(<PlayerAccessCard server={server} />);
    const address = await screen.findByTestId('player-address');
    expect(address.textContent).toBe('100.101.102.103:25565');
    expect(screen.getByText(/Autres adresses/).textContent).toContain('[fd7a:115c:a1e0::1]:25565');
    await user.click(screen.getByText('Direct (IPv6 / domaine)'));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ exposeMode: 'direct' });
    });
    await user.click(screen.getByTestId('player-address-test'));
    const result = await screen.findByTestId('player-address-result');
    expect(result).toHaveAttribute('data-ok', 'true');
    expect(result.textContent).toContain('1.20.1');
    expect(result.textContent).toContain('2/20');
  });
});
