/**
 * Phase 11 — carte « Distribution » (Réglages) : état vide avec commandes de publication, puis
 * plateformes disponibles/manquantes, badge release, clé de dev, one-liners, suppression.
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DistStatusDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { DistributionCard } from './DistributionCard.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const published: DistStatusDto = {
  available: true,
  version: '0.11.0',
  protocolVersion: 1,
  runtimeVersion: '24.19.0',
  builtAt: 0,
  signingKey: 'dev',
  releasePublished: true,
  platforms: {
    'win-x64': {
      file: 'mmo-agent-0.11.0-win-x64.zip',
      sha256: 'a'.repeat(64),
      size: 37_104_842,
      url: '/dist/mmo-agent-0.11.0-win-x64.zip',
    },
    'linux-arm64': {
      file: 'mmo-agent-0.11.0-linux-arm64.tar.gz',
      sha256: 'b'.repeat(64),
      size: 45_436_656,
      url: '/dist/mmo-agent-0.11.0-linux-arm64.tar.gz',
    },
  },
  install: {
    windows: '& ([scriptblock]::Create((irm https://panel.example/install.ps1)))',
    unix: 'curl -fsSL https://panel.example/install.sh | sh',
  },
};

const empty: DistStatusDto = {
  available: false,
  version: null,
  protocolVersion: null,
  runtimeVersion: null,
  builtAt: null,
  signingKey: null,
  releasePublished: false,
  platforms: {},
  install: null,
};

describe('phase 11 — distribution', () => {
  let state: { dist: DistStatusDto };
  let calls: string[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
    state = { dist: published };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${path}`);
        await Promise.resolve();
        if (path === '/api/dist') return json(200, state.dist);
        if (path === '/api/admin/dist' && method === 'DELETE') {
          state.dist = empty;
          return json(200, { ok: true });
        }
        return json(404, { code: 'E_NOT_FOUND', message: path });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderCard() {
    render(
      <MantineProvider>
        <Notifications />
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <DistributionCard />
        </QueryClientProvider>
      </MantineProvider>,
    );
  }

  it('plateformes, badges, one-liners puis suppression', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderCard();
    expect((await screen.findByTestId('distribution-version')).textContent).toContain('0.11.0');
    expect(screen.getByTestId('distribution-release').textContent).toContain('publiée');
    expect(screen.getByTestId('distribution-dev-key')).toBeInTheDocument();
    expect(screen.getByTestId('dist-platform-win-x64')).toHaveAttribute('data-available', 'true');
    expect(screen.getByTestId('dist-platform-win-x64').textContent).toContain('Windows x64');
    expect(screen.getByTestId('dist-platform-linux-x64')).toHaveAttribute(
      'data-available',
      'false',
    );
    expect(screen.getByTestId('dist-platform-linux-x64').textContent).toContain('non publiée');
    expect(screen.getByTestId('dist-oneliner-unix').textContent).toContain('install.sh | sh');
    await user.click(screen.getByTestId('distribution-clear'));
    await waitFor(() => {
      expect(calls).toContain('DELETE /api/admin/dist');
    });
    await screen.findByTestId('distribution-empty');
    expect(screen.queryByTestId('distribution-version')).toBeNull();
  });

  it('état vide : commandes de build/publication affichées', async () => {
    state.dist = empty;
    renderCard();
    const alert = await screen.findByTestId('distribution-empty');
    expect(alert.textContent).toContain('tools/release/build.mjs');
    expect(alert.textContent).toContain('publish.mjs');
  });
});
