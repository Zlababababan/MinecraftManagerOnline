/**
 * Lot 8 — la page vue par un ami : état, adresse, version, joueurs, prochaine sauvegarde. Les
 * pseudos n'apparaissent qu'avec l'opt-in, et un lien mort le dit sans en dire plus.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
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
  whitelist: false,
  source: 'agent',
  updatedAt: 1_788_321_600_000,
};

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function installFetch(
  status: PublicStatus | undefined,
  calls: Call[] = [],
  submitted: { state: string } = { state: 'pending' },
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const raw = init?.body;
      calls.push({
        path: url.replace(/^https?:\/\/[^/]+/, ''),
        method: init?.method ?? 'GET',
        body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
      });
      await Promise.resolve();
      const json = (body: unknown, code = 200) =>
        new Response(JSON.stringify(body), {
          status: code,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/whitelist')) return json(submitted);
      return status === undefined
        ? json({ code: 'E_NOT_FOUND', message: 'status page not found' }, 404)
        : json({ status });
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

  it('le formulaire de demande n’existe que si le serveur l’a autorisé', async () => {
    installFetch(base);
    renderPage();
    await screen.findByTestId('public-status-name');
    expect(screen.queryByTestId('public-whitelist')).toBeNull();
  });

  it('demande de whitelist : pseudo validé sur place, puis message d’attente', async () => {
    const calls: Call[] = [];
    installFetch({ ...base, whitelist: true }, calls);
    renderPage();
    const name = await screen.findByTestId('public-whitelist-name');

    // Un pseudo impossible ne part pas : ce serait une réponse d'API à une faute de frappe.
    fireEvent.change(name, { target: { value: 'a b' } });
    fireEvent.click(screen.getByTestId('public-whitelist-submit'));
    await screen.findByText('3 à 16 caractères : lettres, chiffres et « _ » uniquement.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(name, { target: { value: 'Alice_42' } });
    fireEvent.change(screen.getByTestId('public-whitelist-note'), {
      target: { value: 'Paul du lycée' },
    });
    fireEvent.click(screen.getByTestId('public-whitelist-submit'));
    const result = await screen.findByTestId('public-whitelist-result');
    expect(result).toHaveAttribute('data-state', 'pending');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/status/aaaaaaaaaaaaaaaaaaaaaa/whitelist');
    expect(post?.body).toEqual({ name: 'Alice_42', note: 'Paul du lycée' });
  });

  it('redemander après une acceptation le dit — c’est la seule façon de le savoir', async () => {
    installFetch({ ...base, whitelist: true }, [], { state: 'accepted' });
    renderPage();
    fireEvent.change(await screen.findByTestId('public-whitelist-name'), {
      target: { value: 'Alice' },
    });
    fireEvent.click(screen.getByTestId('public-whitelist-submit'));
    expect(await screen.findByTestId('public-whitelist-result')).toHaveAttribute(
      'data-state',
      'accepted',
    );
  });

  it('lien mort : un message, et rien d’autre', async () => {
    installFetch(undefined);
    renderPage();
    expect(await screen.findByTestId('public-status-missing')).toBeInTheDocument();
    expect(screen.queryByTestId('public-status')).toBeNull();
  });
});
