/**
 * Lot 8 — la page vue par un ami : état, adresse, version, joueurs, prochaine sauvegarde. Les
 * pseudos n'apparaissent qu'avec l'opt-in, et un lien mort le dit sans en dire plus.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicStatus } from '@mmo/protocol/client';

import { i18n } from '../i18n/index.js';
import { PublicStatusPage } from './PublicStatusPage.js';

const base: PublicStatus = {
  name: 'Copains',
  state: 'online',
  address: '100.64.0.5:25565',
  version: '1.20.1',
  loader: 'vanilla',
  motd: 'Chez les copains',
  players: { online: 2, max: 20, names: [], named: false },
  nextBackupAt: 1_788_400_000_000,
  source: 'agent',
  updatedAt: 1_788_321_600_000,
};

function installFetch(status: PublicStatus | undefined): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (): Promise<Response> => {
      await Promise.resolve();
      return status === undefined
        ? new Response(JSON.stringify({ code: 'E_NOT_FOUND', message: 'status page not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ status }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }),
  );
}

function renderPage(): void {
  render(
    <MantineProvider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PublicStatusPage token="aaaaaaaaaaaaaaaaaaaaaa" />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('PublicStatusPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('montre l’essentiel : état, adresse, version, nombre de joueurs, prochaine sauvegarde', async () => {
    installFetch(base);
    renderPage();
    expect(await screen.findByTestId('public-status-name')).toHaveTextContent('Copains');
    expect(screen.getByTestId('public-status-state')).toHaveAttribute('data-state', 'online');
    expect(screen.getByTestId('public-status-address')).toHaveTextContent('100.64.0.5:25565');
    expect(screen.getByTestId('public-status-version')).toHaveTextContent('1.20.1');
    expect(screen.getByTestId('public-status-players')).toHaveTextContent('2 / 20');
    expect(screen.getByTestId('public-status-motd')).toHaveTextContent('Chez les copains');
    expect(screen.getByTestId('public-status-backup')).toBeInTheDocument();
    // Sans opt-in, aucun pseudo — même si le serveur en compte deux.
    expect(screen.queryByTestId('public-status-names')).toBeNull();
  });

  it('affiche les pseudos quand ils sont publiés, et le repli par interrogation directe', async () => {
    installFetch({
      ...base,
      players: { online: 2, max: 20, names: ['Alice', 'Bob'], named: true },
      source: 'ping',
    });
    renderPage();
    expect(await screen.findByTestId('public-status-names')).toHaveTextContent('Alice, Bob');
    expect(screen.getByTestId('public-status-source')).toHaveAttribute('data-source', 'ping');
  });

  it('lien mort : un message, et rien d’autre', async () => {
    installFetch(undefined);
    renderPage();
    expect(await screen.findByTestId('public-status-missing')).toBeInTheDocument();
    expect(screen.queryByTestId('public-status')).toBeNull();
  });
});
