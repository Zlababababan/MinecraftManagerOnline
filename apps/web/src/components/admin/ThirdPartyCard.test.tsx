/**
 * Réglages → Services tiers : l'interrupteur FTB écrit le réglage (booléen strict), et le tableau
 * liste chaque service avec ce qui reste à vérifier.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THIRD_PARTY_SERVICES } from '@mmo/shared';

import { i18n } from '../../i18n/index.js';
import { ThirdPartyCard } from './ThirdPartyCard.js';

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
      calls.push({
        method: init?.method ?? 'GET',
        path: url.replace(/^https?:\/\/[^/]+/, ''),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      await Promise.resolve();
      return new Response(JSON.stringify({ settings }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <ThirdPartyCard settings={settings} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return calls;
}

describe('ThirdPartyCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('FTB activé par défaut ; le couper écrit « false »', async () => {
    const calls = renderCard({});
    const toggle = screen.getByTestId('settings-ftb-enabled');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        'modpacks.ftb.enabled': 'false',
      });
    });
  });

  it('coupé, l’interrupteur le montre ; le rallumer écrit « true »', async () => {
    const calls = renderCard({ 'modpacks.ftb.enabled': 'false' });
    const toggle = screen.getByTestId('settings-ftb-enabled');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        'modpacks.ftb.enabled': 'true',
      });
    });
  });

  it('liste chaque service tiers', () => {
    renderCard({});
    for (const s of THIRD_PARTY_SERVICES) {
      expect(screen.getByTestId(`third-party-${s.id}`)).toBeInTheDocument();
    }
  });
});
