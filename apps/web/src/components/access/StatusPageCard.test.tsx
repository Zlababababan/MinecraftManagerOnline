/**
 * Lot 8 — carte « Page de statut publique » : pas de lien tant que la page n'est pas active
 * (un lien mort collé dans un salon Discord est pire que rien), activation, opt-in nominatif,
 * changement de lien confirmé, et lecture seule pour un compte qui n'est pas opérateur.
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDto, StatusPageDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { StatusPageCard } from './StatusPageCard.js';

const server = { id: 'srv1', machineId: 'm1' } as ServerDto;

const user = (role: UserDto['role']): UserDto => ({
  id: 'u1',
  username: 'admin',
  role,
  locale: 'fr',
  theme: 'dark',
  isActive: true,
  createdAt: 1_788_000_000_000,
  lastLoginAt: null,
  scoped: false,
});

const page = (over: Partial<StatusPageDto> = {}): StatusPageDto => ({
  serverId: 'srv1',
  enabled: true,
  showPlayers: false,
  allowWhitelist: false,
  token: 'aaaaaaaaaaaaaaaaaaaaaa',
  path: '/s/aaaaaaaaaaaaaaaaaaaaaa',
  url: null,
  createdAt: 1_788_321_600_000,
  updatedAt: 1_788_321_600_000,
  ...over,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(calls: Call[], initial: StatusPageDto | null, role: UserDto['role']): void {
  let current = initial;
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
      if (path === '/api/auth/me') return json({ user: user(role) });
      if (path === '/api/servers/srv1/status-page' && method === 'GET')
        return json({ statusPage: current });
      if (path === '/api/servers/srv1/status-page' && method === 'PUT') {
        current = { ...(current ?? page()), ...(body as Partial<StatusPageDto>) };
        return json({ statusPage: current });
      }
      if (path === '/api/servers/srv1/status-page/rotate') {
        current = {
          ...(current ?? page()),
          token: 'bbbbbbbbbbbbbbbbbbbbbb',
          path: '/s/bbbbbbbbbbbbbbbbbbbbbb',
        };
        return json({ statusPage: current });
      }
      return json({ code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderCard(): void {
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StatusPageCard server={server} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('StatusPageCard', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sans page publiée : aucun lien, l’activation en crée une', async () => {
    installFetch(calls, null, 'admin');
    renderCard();
    const toggle = await screen.findByTestId('status-page-enabled');
    expect(toggle).not.toBeChecked();
    expect(screen.queryByTestId('status-page-link')).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true });
    const link = await screen.findByTestId('status-page-link');
    // Sans URL publique connue du panel, le lien se complète avec l'origine du navigateur.
    expect(link.textContent).toBe(`${window.location.origin}/s/aaaaaaaaaaaaaaaaaaaaaa`);

    // Désactivée, la page garde son jeton côté panel — mais on ne montre plus un lien qui ne
    // répond pas : collé dans un salon Discord, il serait pire que pas de lien du tout.
    fireEvent.click(screen.getByTestId('status-page-enabled'));
    await waitFor(() => {
      expect(screen.queryByTestId('status-page-link')).toBeNull();
    });
  });

  it('publie les pseudos seulement sur demande', async () => {
    installFetch(calls, page(), 'admin');
    renderCard();
    const names = await screen.findByTestId('status-page-show-players');
    expect(names).not.toBeChecked();
    fireEvent.click(names);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ showPlayers: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId('status-page-show-players')).toBeChecked();
    });
  });

  it('changer de lien demande confirmation, puis remplace le lien affiché', async () => {
    installFetch(calls, page(), 'admin');
    renderCard();
    fireEvent.click(await screen.findByTestId('status-page-rotate'));
    expect(screen.getByTestId('status-page-rotate-confirm')).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/rotate'))).toBe(false);

    fireEvent.click(screen.getByTestId('status-page-rotate-yes'));
    await waitFor(() => {
      expect(screen.getByTestId('status-page-link').textContent).toContain(
        'bbbbbbbbbbbbbbbbbbbbbb',
      );
    });
  });

  it('les demandes de whitelist sont un second opt-in, éteint par défaut', async () => {
    installFetch(calls, page(), 'admin');
    renderCard();
    const allow = await screen.findByTestId('status-page-allow-whitelist');
    expect(allow).not.toBeChecked();
    fireEvent.click(allow);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ allowWhitelist: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId('status-page-allow-whitelist')).toBeChecked();
    });
  });

  it('un lecteur voit l’état mais ne touche à rien', async () => {
    installFetch(calls, page({ showPlayers: true }), 'viewer');
    renderCard();
    // La page est bien publiée (le lien s'affiche), mais rien n'est actionnable.
    await screen.findByTestId('status-page-link');
    expect(screen.getByTestId('status-page-enabled')).toBeDisabled();
    expect(screen.getByTestId('status-page-show-players')).toBeDisabled();
    expect(screen.getByTestId('status-page-allow-whitelist')).toBeDisabled();
    expect(screen.getByTestId('status-page-rotate')).toBeDisabled();
  });
});
