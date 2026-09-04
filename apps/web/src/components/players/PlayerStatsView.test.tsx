/**
 * Lot 8 — vue « Statistiques » de l'onglet Joueurs : les quatre chiffres, l'histogramme des
 * heures, le classement des temps de jeu, et le changement de fenêtre qui redemande au panel.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerStatsDto, ServerDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { PlayerStatsView } from './PlayerStatsView.js';

const server = { id: 'srv1', machineId: 'm1' } as ServerDto;
const HOUR = 3_600_000;
const DAY0 = Date.UTC(2026, 5, 30, 22, 0);

const stats = (over: Partial<PlayerStatsDto> = {}): PlayerStatsDto => ({
  from: DAY0,
  to: DAY0 + 3 * 24 * HOUR,
  timeZone: 'Europe/Paris',
  totals: {
    sessions: 4,
    players: 2,
    newPlayers: 1,
    playtimeMs: 5 * HOUR,
    longestSessionMs: 3 * HOUR,
    peakPlayers: 2,
    peakAt: DAY0 + 21 * HOUR,
  },
  days: [
    { start: DAY0, sessions: 3, players: 2, playtimeMs: 4 * HOUR },
    { start: DAY0 + 24 * HOUR, sessions: 1, players: 1, playtimeMs: HOUR },
    { start: DAY0 + 48 * HOUR, sessions: 0, players: 0, playtimeMs: 0 },
  ],
  hours: Array.from({ length: 24 }, (_, h) => (h === 21 ? 3 * HOUR : h === 20 ? 2 * HOUR : 0)),
  top: [
    {
      name: 'Alice',
      uuid: 'uuid-alice',
      playtimeMs: 4 * HOUR,
      sessions: 3,
      lastSeenAt: DAY0 + 23 * HOUR,
      firstSeenAt: DAY0 - 1000,
      isNew: false,
    },
    {
      name: 'Bob',
      uuid: null,
      playtimeMs: 90 * 60_000,
      sessions: 1,
      lastSeenAt: DAY0 + 22 * HOUR,
      firstSeenAt: DAY0 + HOUR,
      isNew: true,
    },
  ],
  ...over,
});

function installFetch(calls: string[], body: PlayerStatsDto): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url.replace(/^https?:\/\/[^/]+/, ''));
      await Promise.resolve();
      return new Response(JSON.stringify({ stats: body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function renderView(body = stats()): string[] {
  const calls: string[] = [];
  installFetch(calls, body);
  render(
    <MantineProvider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PlayerStatsView server={server} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return calls;
}

describe('PlayerStatsView', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('montre les totaux, le classement et les heures de jeu', async () => {
    renderView();
    expect(await screen.findByTestId('stat-players')).toHaveTextContent('2');
    expect(screen.getByTestId('stat-sessions')).toHaveTextContent('4');
    // Un total de temps de jeu ne s'arrondit pas : 5 h reste 5 h, et 1 h 30 reste 1 h 30.
    expect(screen.getByTestId('stat-playtime')).toHaveTextContent('5 h');
    expect(screen.getByTestId('stat-peak')).toHaveTextContent('2');

    expect(screen.getByTestId('stats-playtime-Alice')).toHaveTextContent('4 h');
    expect(screen.getByTestId('stats-playtime-Bob')).toHaveTextContent('1 h 30');
    // Le badge « nouveau » ne va qu'à qui vient d'arriver sur ce serveur.
    expect(screen.getByTestId('stats-player-Bob')).toHaveTextContent('nouveau');
    expect(screen.getByTestId('stats-player-Alice')).not.toHaveTextContent('nouveau');

    // L'histogramme porte ses valeurs : la barre de 21 h est la plus haute.
    expect(screen.getByTestId('stats-hour-21')).toHaveAttribute('data-value', String(3 * HOUR));
    expect(screen.getByTestId('stats-hour-3')).toHaveAttribute('data-value', '0');
    // Le fuseau est dit : lues ailleurs, ces heures ne voudraient rien dire.
    expect(screen.getByText(/Europe\/Paris/)).toBeInTheDocument();
  });

  it('changer de fenêtre redemande au panel', async () => {
    const calls = renderView();
    await screen.findByTestId('stat-players');
    expect(calls[0]).toBe('/api/servers/srv1/players/stats?days=30');

    fireEvent.click(screen.getByText('7 j'));
    await waitFor(() => {
      expect(calls.some((c) => c.endsWith('days=7'))).toBe(true);
    });
  });

  it('une période sans personne le dit, au lieu d’un tableau vide', async () => {
    renderView(
      stats({
        totals: {
          sessions: 0,
          players: 0,
          newPlayers: 0,
          playtimeMs: 0,
          longestSessionMs: 0,
          peakPlayers: 0,
          peakAt: null,
        },
        top: [],
      }),
    );
    expect(await screen.findByTestId('stats-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-top')).toBeNull();
    expect(screen.getByTestId('stat-players')).toHaveTextContent('0');
  });
});
