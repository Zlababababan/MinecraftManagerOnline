/**
 * Lot 8 — carte Appareils connectés : liste (résumé du navigateur, « cet appareil », adresse),
 * déconnexion d'un autre appareil (DELETE /:id), de l'appareil courant (rechargement), et de tous
 * les autres (DELETE sans id, bouton désactivé quand il n'y en a pas).
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { SessionsCard } from './SessionsCard.js';

const here: SessionDto = {
  id: 7,
  createdAt: 1_788_321_600_000,
  lastSeenAt: 1_788_321_700_000,
  expiresAt: 1_790_913_600_000,
  ip: '100.64.0.7',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/130.0',
  current: true,
};
const phone: SessionDto = {
  ...here,
  id: 9,
  ip: '100.64.0.9',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Safari/604.1',
  current: false,
};

interface Call {
  method: string;
  path: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(calls: Call[], sessions: SessionDto[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      calls.push({ method, path });
      await Promise.resolve();
      if (method === 'GET' && path === '/api/auth/sessions') return json(200, { sessions });
      if (method === 'DELETE' && path === '/api/auth/sessions') return json(200, { revoked: 1 });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderCard(reload = vi.fn()): void {
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SessionsCard reload={reload} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('SessionsCard', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('liste les appareils avec le navigateur résumé et « cet appareil »', async () => {
    installFetch(calls, [here, phone]);
    renderCard();
    const mine = await screen.findByTestId('session-row-7');
    expect(mine).toHaveTextContent('Firefox · Windows');
    expect(mine).toHaveTextContent('Cet appareil');
    expect(mine).toHaveTextContent('100.64.0.7');
    const other = screen.getByTestId('session-row-9');
    expect(other).toHaveTextContent('Safari · iPhone');
    expect(other).not.toHaveTextContent('Cet appareil');
    expect(screen.getByTestId('sessions-revoke-others')).toBeEnabled();
  });

  it('déconnecte un autre appareil, puis le sien (rechargement), puis tous les autres', async () => {
    const reload = vi.fn();
    installFetch(calls, [here, phone]);
    renderCard(reload);
    fireEvent.click(await screen.findByTestId('session-revoke-9'));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/auth/sessions/9')).toBe(
        true,
      );
    });
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('session-revoke-7'));
    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId('sessions-revoke-others'));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/auth/sessions')).toBe(
        true,
      );
    });
  });

  it('seul appareil : le bouton « les autres » est désactivé', async () => {
    installFetch(calls, [here]);
    renderCard();
    await screen.findByTestId('session-row-7');
    expect(screen.getByTestId('sessions-revoke-others')).toBeDisabled();
  });
});
