/**
 * Bandeau « il faut attendre » : visible quand le panel vient de démarrer et qu'un agent n'est pas
 * encore revenu, ou quand le panel ne répond plus ; absent dans tous les autres cas.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../i18n/index.js';
import { useRealtimeStore } from '../store/realtime.js';
import { StartupBanner } from './StartupBanner.js';

interface World {
  uptimeMs: number;
  machines: { id: string; status: 'pending' | 'online' | 'offline' | 'disabled' }[];
}

function renderBanner(world: World, downGraceMs?: number): QueryClient {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      await Promise.resolve();
      const body = url.endsWith('/api/auth/me')
        ? { user: { id: 'u1', username: 'ambre', role: 'admin' }, uptimeMs: world.uptimeMs }
        : { machines: world.machines };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <StartupBanner {...(downGraceMs === undefined ? {} : { downGraceMs })} />
        <span data-testid="page">page</span>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return client;
}

describe('StartupBanner', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    useRealtimeStore.getState().setStatus('open');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useRealtimeStore.getState().reset();
  });

  it('panel tout juste démarré, un agent pas encore revenu : on demande d’attendre, puis ça disparaît', async () => {
    const world: World = {
      uptimeMs: 10_000,
      machines: [
        { id: 'a', status: 'online' },
        { id: 'b', status: 'offline' },
        // Jamais appairée, ou désactivée : on ne l'attend pas.
        { id: 'c', status: 'pending' },
        { id: 'd', status: 'disabled' },
      ],
    };
    const client = renderBanner(world);
    const banner = await screen.findByTestId('startup-banner-starting');
    expect(banner).toHaveTextContent('Le panel vient de démarrer');
    expect(banner).toHaveTextContent('1/2');
    // L'agent revient : plus rien à attendre.
    world.machines = world.machines.map((m) => (m.id === 'b' ? { ...m, status: 'online' } : m));
    await act(() => client.invalidateQueries());
    await waitFor(() => {
      expect(screen.queryByTestId('startup-banner-starting')).not.toBeInTheDocument();
    });
  });

  it('panel démarré depuis longtemps : une machine hors ligne est juste hors ligne, pas de bandeau', async () => {
    const client = renderBanner({
      uptimeMs: 3_600_000,
      machines: [{ id: 'b', status: 'offline' }],
    });
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
    });
    await screen.findByTestId('page');
    expect(screen.queryByTestId('startup-banner-starting')).not.toBeInTheDocument();
    expect(screen.queryByTestId('startup-banner-down')).not.toBeInTheDocument();
  });

  it('panel qui ne répond plus : bandeau après le délai de grâce, retiré au retour', async () => {
    renderBanner({ uptimeMs: 3_600_000, machines: [] }, 1_500);
    act(() => {
      useRealtimeStore.getState().setStatus('closed');
    });
    // Une coupure d'un instant ne fait pas clignoter le bandeau.
    expect(screen.queryByTestId('startup-banner-down')).not.toBeInTheDocument();
    const banner = await screen.findByTestId('startup-banner-down', {}, { timeout: 5_000 });
    expect(banner).toHaveTextContent('Le panel ne répond pas');
    act(() => {
      useRealtimeStore.getState().setStatus('open');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('startup-banner-down')).not.toBeInTheDocument();
    });
  });
});
