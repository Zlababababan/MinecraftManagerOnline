/**
 * Réglages → Accès des joueurs : le défaut d'exposition s'écrit dans le réglage, et « appliquer à
 * tous » envoie le mode AFFICHÉ — jamais un autre.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../../i18n/index.js';
import { PlayerExposureCard } from './PlayerExposureCard.js';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function renderCard(settings: Record<string, string>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      calls.push({
        method: init?.method ?? 'GET',
        path,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      await Promise.resolve();
      return new Response(
        JSON.stringify(path === '/api/servers/expose-mode' ? { updated: 61 } : { settings }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <PlayerExposureCard settings={settings} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return calls;
}

describe('PlayerExposureCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tailnet par défaut ; choisir « Direct » écrit le réglage', async () => {
    const calls = renderCard({});
    expect(screen.getByLabelText('Tailnet (amis sur Tailscale)')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Direct (IPv6 / domaine)'));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        'servers.defaultExposeMode': 'direct',
      });
    });
    // Changer le défaut ne touche à aucun serveur existant.
    expect(calls.some((c) => c.path === '/api/servers/expose-mode')).toBe(false);
  });

  it('« appliquer à tous » envoie le mode affiché', async () => {
    const calls = renderCard({ 'servers.defaultExposeMode': 'direct' });
    expect(screen.getByLabelText('Direct (IPv6 / domaine)')).toBeChecked();
    fireEvent.click(screen.getByTestId('settings-expose-apply-all'));
    await waitFor(() => {
      expect(calls.find((c) => c.path === '/api/servers/expose-mode')).toMatchObject({
        method: 'POST',
        body: { mode: 'direct' },
      });
    });
  });
});
