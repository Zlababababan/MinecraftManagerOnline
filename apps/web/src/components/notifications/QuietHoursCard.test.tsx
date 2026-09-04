/**
 * Lot 8 — heures calmes (page Compte) et silence par serveur (vue d'ensemble). Deux réglages
 * personnels : ce que l'écran promet doit être exactement ce que le panel reçoit.
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MutedServerDto, QuietHours, ServerDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { QuietHoursCard, fromHhMm, toHhMm } from './QuietHoursCard.js';
import { ServerMuteCard } from './ServerMuteCard.js';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface State {
  quietHours: QuietHours | null;
  mutedServers: MutedServerDto[];
  muted: boolean;
}

function installFetch(calls: Call[], state: State): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      const raw = init?.body;
      const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined;
      calls.push({ method, path, body });
      await Promise.resolve();
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/api/notifications/quiet-hours') {
        state.quietHours = (body as { quietHours: QuietHours | null }).quietHours;
        return json({ quietHours: state.quietHours });
      }
      if (path.endsWith('/notifications') && method === 'PUT') {
        state.muted = (body as { muted: boolean }).muted;
        if (!state.muted) state.mutedServers = [];
        return json({ muted: state.muted });
      }
      if (path.endsWith('/notifications')) return json({ muted: state.muted });
      if (path === '/api/notifications/prefs') {
        return json({
          prefs: {},
          channels: undefined,
          quietHours: state.quietHours,
          timeZone: 'Europe/Paris',
          mutedServers: state.mutedServers,
        });
      }
      return json({});
    }),
  );
}

function renderWith(node: React.ReactNode, state: Partial<State> = {}): Call[] {
  const calls: Call[] = [];
  installFetch(calls, { quietHours: null, mutedServers: [], muted: false, ...state });
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        {node}
      </QueryClientProvider>
    </MantineProvider>,
  );
  return calls;
}

describe('heures calmes', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('convertit les heures dans les deux sens, et refuse ce qui n’est pas une heure', () => {
    expect(toHhMm(22 * 60)).toBe('22:00');
    expect(toHhMm(7 * 60 + 5)).toBe('07:05');
    expect(toHhMm(0)).toBe('00:00');
    expect(fromHhMm('22:30')).toBe(22 * 60 + 30);
    expect(fromHhMm('00:00')).toBe(0);
    expect(fromHhMm('')).toBeUndefined();
    expect(fromHhMm('24:00')).toBeUndefined();
    expect(fromHhMm('7:00')).toBeUndefined();
  });

  it('éteint par défaut ; activer propose 22 h → 7 h et le dit dans le fuseau du panel', async () => {
    const calls = renderWith(<QuietHoursCard />);
    const toggle = await screen.findByTestId('quiet-enabled');
    expect(toggle).not.toBeChecked();
    expect(screen.queryByTestId('quiet-from')).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        quietHours: { from: 1320, to: 420 },
      });
    });
    expect(await screen.findByTestId('quiet-from')).toHaveValue('22:00');
    expect(screen.getByTestId('quiet-to')).toHaveValue('07:00');
    // Le fuseau est nommé : sans lui, on règle « 22 h » en croyant que c'est l'heure du téléphone.
    expect(screen.getByTestId('quiet-zone')).toHaveTextContent('Europe/Paris');
  });

  it('changer une heure ne l’envoie qu’une fois la saisie finie', async () => {
    const calls = renderWith(<QuietHoursCard />, { quietHours: { from: 22 * 60, to: 7 * 60 } });
    const from = await screen.findByTestId('quiet-from');

    fireEvent.change(from, { target: { value: '23:30' } });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    fireEvent.blur(from, { target: { value: '23:30' } });
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        quietHours: { from: 23 * 60 + 30, to: 7 * 60 },
      });
    });
    // Une seule écriture, pas une par frappe : sinon chaque chiffre tapé traverserait le réseau
    // et « 2 » (2 h du matin) serait enregistré en route vers « 23 ».
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('les serveurs en silence se retrouvent et se réactivent depuis le compte', async () => {
    const calls = renderWith(<QuietHoursCard />, {
      mutedServers: [{ serverId: 'srv1', name: 'Alpha', mutedAt: 1_788_000_000_000 }],
    });
    expect(await screen.findByTestId('muted-Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('unmute-Alpha'));
    await waitFor(() => {
      expect(
        calls.some((c) => c.path === '/api/servers/srv1/notifications' && c.body !== undefined),
      ).toBe(true);
    });
    expect(calls.find((c) => c.path === '/api/servers/srv1/notifications')?.body).toEqual({
      muted: false,
    });
  });
});

describe('silence par serveur', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('l’interrupteur de la vue d’ensemble met ce serveur en silence', async () => {
    const server = { id: 'srv1', machineId: 'm1' } as ServerDto;
    const calls = renderWith(<ServerMuteCard server={server} />);
    const toggle = await screen.findByTestId('server-mute-switch');
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByTestId('server-mute-switch')).toBeChecked();
    });
    expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/api/servers/srv1/notifications');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ muted: true });
  });
});
