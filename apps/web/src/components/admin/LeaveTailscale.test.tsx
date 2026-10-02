/**
 * « Je n'utilise plus Tailscale » en un geste, et la commande d'installation « par ici »
 * (retours de Yassin, 02/10). Visible quand il faut, absent sinon ; rien ne change sans accord.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessStatusDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { InstallHereNotice } from '../InstallHereNotice.js';
import { LeaveTailscale } from './LeaveTailscale.js';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function mount(node: React.ReactNode): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      calls.push({
        method: init?.method ?? 'GET',
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      await Promise.resolve();
      return new Response(
        JSON.stringify(path === '/api/servers/expose-mode' ? { updated: 62 } : { settings: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <Notifications />
      <ModalsProvider>
        <QueryClientProvider client={qc}>{node}</QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
  return calls;
}
const status = (over: Partial<AccessStatusDto>): AccessStatusDto =>
  ({ mode: 'tailscale', requestVia: 'direct', ...over }) as AccessStatusDto;

describe('sortir de Tailscale, commande « par ici »', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('absent quand le panel est consulté par Tailscale, ou n’est pas réglé sur Tailscale', () => {
    mount(
      <>
        <LeaveTailscale status={status({ requestVia: 'tailscale' })} />
        <LeaveTailscale status={status({ mode: 'manual' })} />
      </>,
    );
    expect(screen.queryByTestId('leave-tailscale')).toBeNull();
  });

  it('annoncé, détaillé avant d’agir, puis les trois réglages partent ensemble', async () => {
    const user = userEvent.setup();
    const calls = mount(<LeaveTailscale status={status({})} />);
    await user.click(screen.getByTestId('leave-tailscale-button'));
    // Rien n'a encore changé : le plan est d'abord montré.
    expect(await screen.findByTestId('leave-tailscale-plan')).toHaveTextContent(
      window.location.origin,
    );
    expect(calls).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Appliquer les trois réglages' }));
    await waitFor(() => {
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'PATCH /api/settings',
        'POST /api/servers/expose-mode',
      ]);
    });
    expect(calls[0]?.body).toEqual({
      'access.mode': 'manual',
      'panel.publicUrl': window.location.origin,
      'servers.defaultExposeMode': 'direct',
    });
    expect(calls[1]?.body).toEqual({ mode: 'direct' });
    expect(await screen.findByText(/62 serveur\(s\) passés en adresse directe/)).toBeVisible();
  });

  it('annuler ne change rien', async () => {
    const user = userEvent.setup();
    const calls = mount(<LeaveTailscale status={status({})} />);
    await user.click(screen.getByTestId('leave-tailscale-button'));
    await user.click(await screen.findByRole('button', { name: 'Annuler' }));
    expect(calls).toHaveLength(0);
  });

  it('commande « par ici » : affichée avec l’adresse, l’avertissement local seulement en local, rien sans elle', () => {
    mount(
      <>
        <InstallHereNotice here={undefined} />
        <div data-testid="lan">
          <InstallHereNotice
            here={{ url: 'http://192.168.1.10:3000', windows: 'W-LAN', unix: 'U-LAN' }}
          />
        </div>
        <div data-testid="local">
          <InstallHereNotice
            here={{ url: 'http://127.0.0.1:3000', windows: 'W-LOCAL', unix: 'U-LOCAL' }}
          />
        </div>
      </>,
    );
    expect(screen.getAllByTestId('install-here')).toHaveLength(2);
    expect(screen.getByTestId('lan')).toHaveTextContent('W-LAN');
    expect(screen.getByTestId('lan')).toHaveTextContent('http://192.168.1.10:3000');
    expect(screen.getByTestId('lan')).not.toHaveTextContent('ne marche que sur la machine');
    expect(screen.getByTestId('local')).toHaveTextContent('ne marche que sur la machine');
  });
});
