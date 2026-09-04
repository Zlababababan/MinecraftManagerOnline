/**
 * Lot 8 — carte « Demandes en attente » : ce qu'un opérateur voit des demandes reçues sur la page
 * publique, accepter (qui ajoute réellement à la liste blanche), refuser, oublier. Un compte qui
 * n'est pas opérateur voit les demandes mais n'a aucun bouton.
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDto, WhitelistRequestDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { WhitelistRequestsCard } from './WhitelistRequestsCard.js';

const server = { id: 'srv1', machineId: 'm1' } as ServerDto;

const request = (over: Partial<WhitelistRequestDto> = {}): WhitelistRequestDto => ({
  id: 'req1',
  serverId: 'srv1',
  name: 'Alice',
  note: null,
  status: 'pending',
  createdAt: 1_788_321_600_000,
  decidedAt: null,
  decidedBy: null,
  ...over,
});

interface Call {
  method: string;
  path: string;
}

function installFetch(calls: Call[], initial: WhitelistRequestDto[]): void {
  let current = initial;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      calls.push({ method, path });
      await Promise.resolve();
      if (path.endsWith('/accept')) {
        current = current.map((r) =>
          r.status === 'pending' ? { ...r, status: 'accepted', decidedBy: 'admin' } : r,
        );
      } else if (path.endsWith('/reject')) {
        current = current.map((r) =>
          r.status === 'pending' ? { ...r, status: 'rejected', decidedBy: 'admin' } : r,
        );
      } else if (method === 'DELETE') {
        current = [];
      }
      return new Response(JSON.stringify({ requests: current }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function renderCard(requests: WhitelistRequestDto[], canOperate = true): Call[] {
  const calls: Call[] = [];
  installFetch(calls, requests);
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <WhitelistRequestsCard server={server} canOperate={canOperate} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return calls;
}

describe('WhitelistRequestsCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aucune demande : aucune carte — la vue Liste blanche reste ce qu’elle était', async () => {
    renderCard([]);
    await waitFor(() => {
      expect(screen.queryByTestId('whitelist-requests')).toBeNull();
    });
  });

  it('montre le pseudo, le mot laissé, et compte ce qui attend', async () => {
    renderCard([request({ note: 'Paul du lycée' })]);
    expect(await screen.findByTestId('whitelist-request-Alice')).toBeInTheDocument();
    expect(screen.getByTestId('whitelist-request-note-Alice')).toHaveTextContent('Paul du lycée');
    expect(screen.getByTestId('whitelist-requests-count')).toHaveTextContent('1');
  });

  it('accepter appelle la route d’acceptation et la demande passe en « Acceptée »', async () => {
    const calls = renderCard([request()]);
    fireEvent.click(await screen.findByTestId('whitelist-accept-Alice'));
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.path.endsWith('/whitelist-requests/req1/accept'),
        ),
      ).toBe(true);
    });
    expect(await screen.findByTestId('whitelist-request-status-Alice')).toHaveTextContent(
      'Acceptée',
    );
    // Une demande tranchée n'attend plus : la pastille disparaît.
    expect(screen.queryByTestId('whitelist-requests-count')).toBeNull();
  });

  it('refuser puis oublier : la demande disparaît, la personne pourra en refaire une', async () => {
    const calls = renderCard([request()]);
    fireEvent.click(await screen.findByTestId('whitelist-reject-Alice'));
    const badge = await screen.findByTestId('whitelist-request-status-Alice');
    expect(badge).toHaveTextContent('Refusée');
    expect(badge).toHaveTextContent('admin');

    fireEvent.click(screen.getByTestId('whitelist-forget-Alice'));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('whitelist-requests')).toBeNull();
    });
  });

  it('un compte qui ne peut pas opérer voit les demandes sans aucun bouton', async () => {
    renderCard([request()], false);
    await screen.findByTestId('whitelist-request-Alice');
    expect(screen.queryByTestId('whitelist-accept-Alice')).toBeNull();
    expect(screen.queryByTestId('whitelist-reject-Alice')).toBeNull();
  });
});
