/**
 * Lot 4 — carte Webhooks : liste avec santé (échec en rouge + dernière erreur, URL masquée, rotation
 * du secret réservée au genre JSON), création d'un webhook JSON (corps envoyé, secret affiché une
 * fois), refus de la garde SSRF traduit, suppression confirmée en place.
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTIFICATION_DEFAULTS, NOTIFICATION_TYPES, type WebhookDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { WebhooksCard } from './WebhooksCard.js';

const discord: WebhookDto = {
  id: 'wh1',
  name: 'Salon #ops',
  kind: 'discord',
  url: 'https://discord.com/api/webhooks/123/••••',
  enabled: true,
  locale: 'fr',
  types: ['server.crashed'],
  hasSecret: false,
  createdAt: 1_788_321_600_000,
  updatedAt: 1_788_321_600_000,
  lastAttemptAt: 1_788_321_700_000,
  lastDeliveredAt: 1_788_321_700_000,
  lastStatus: 204,
  lastError: null,
  failCount: 0,
};
const failing: WebhookDto = {
  ...discord,
  id: 'wh2',
  name: 'n8n',
  kind: 'json',
  url: 'https://hooks.example.com/mmo',
  hasSecret: true,
  lastDeliveredAt: null,
  lastStatus: 404,
  lastError: 'HTTP 404: {"message":"nope"}',
  failCount: 3,
};
const SECRET = 'ab'.repeat(32);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(calls: Call[], list: WebhookDto[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      await Promise.resolve();
      if (method === 'GET' && path === '/api/webhooks') return json(200, { webhooks: list });
      if (method === 'POST' && path === '/api/webhooks') {
        const input = body as { url: string; kind: 'discord' | 'json'; name: string };
        if (input.url.includes('nas.local')) {
          return json(400, {
            code: 'E_VALIDATION',
            message: 'hostname nas.local refused (local)',
            details: { key: 'url', reason: 'BLOCKED_HOST', hostname: 'nas.local', range: 'local' },
          });
        }
        return json(201, {
          webhook: {
            ...discord,
            id: 'wh3',
            name: input.name,
            kind: input.kind,
            hasSecret: input.kind === 'json',
          },
          secret: input.kind === 'json' ? SECRET : null,
        });
      }
      if (method === 'DELETE') return json(200, { removed: true });
      return json(404, { code: 'E_NOT_FOUND', message: path });
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
        <WebhooksCard />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('WebhooksCard', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('liste les webhooks avec leur santé : URL masquée, échec en rouge avec la dernière erreur', async () => {
    installFetch(calls, [discord, failing]);
    renderCard();
    const row = await screen.findByTestId('webhook-row-wh1');
    expect(row).toHaveTextContent('Salon #ops');
    expect(row).toHaveTextContent('https://discord.com/api/webhooks/123/••••');
    expect(row).toHaveTextContent('Dernier envoi');
    expect(screen.getByTestId('webhook-failing-wh2')).toHaveTextContent('En échec (3)');
    expect(screen.getByTestId('webhook-last-error-wh2')).toHaveTextContent('HTTP 404');
    // Un secret n'existe que pour le JSON : la rotation n'est proposée que là.
    expect(screen.getByTestId('webhook-rotate-wh2')).toBeInTheDocument();
    expect(screen.queryByTestId('webhook-rotate-wh1')).toBeNull();
  });

  it('crée un webhook JSON avec les catégories par défaut (+ une cochée) et montre le secret une fois', async () => {
    installFetch(calls, []);
    renderCard();
    expect(await screen.findByTestId('webhooks-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('webhook-add'));
    fireEvent.change(await screen.findByTestId('webhook-name'), { target: { value: 'n8n' } });
    fireEvent.click(screen.getByLabelText('JSON signé'));
    fireEvent.change(screen.getByTestId('webhook-url'), {
      target: { value: 'https://hooks.example.com/mmo' },
    });
    fireEvent.click(screen.getByTestId('webhook-type-player.activity'));
    fireEvent.click(screen.getByTestId('webhook-save'));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/webhooks')).toBe(true);
    });
    const created = calls.find((c) => c.method === 'POST')?.body as {
      name: string;
      kind: string;
      url: string;
      locale: string;
      types: string[];
    };
    expect(created).toMatchObject({
      name: 'n8n',
      kind: 'json',
      url: 'https://hooks.example.com/mmo',
      locale: 'fr',
    });
    const expected = [
      ...NOTIFICATION_TYPES.filter((type) => NOTIFICATION_DEFAULTS[type]),
      'player.activity',
    ];
    expect([...created.types].sort()).toEqual([...expected].sort());
    expect(await screen.findByTestId('webhook-secret-value')).toHaveTextContent(SECRET);
  });

  it('traduit un refus de la garde SSRF avec le nom d’hôte en cause', async () => {
    installFetch(calls, []);
    renderCard();
    await screen.findByTestId('webhooks-empty');
    fireEvent.click(screen.getByTestId('webhook-add'));
    fireEvent.change(await screen.findByTestId('webhook-name'), { target: { value: 'nas' } });
    fireEvent.change(screen.getByTestId('webhook-url'), {
      target: { value: 'https://nas.local/hook' },
    });
    fireEvent.click(screen.getByTestId('webhook-save'));
    expect(await screen.findByText(/Nom d’hôte refusé \(nas\.local\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('webhook-secret-value')).toBeNull();
  });

  it('supprime après confirmation en place', async () => {
    installFetch(calls, [discord]);
    renderCard();
    fireEvent.click(await screen.findByTestId('webhook-delete-wh1'));
    expect(screen.getByTestId('webhook-confirm-delete')).toHaveTextContent('Salon #ops');
    fireEvent.click(screen.getByTestId('webhook-confirm-delete-yes'));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/webhooks/wh1')).toBe(true);
    });
  });
});
