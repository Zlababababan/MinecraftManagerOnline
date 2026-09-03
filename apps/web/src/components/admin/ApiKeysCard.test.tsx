/**
 * Lot 8 — carte Clés d'API : liste (préfixe seul, expirée en rouge, dernière utilisation), création
 * (rôles proposés ≤ le sien, corps envoyé, jeton montré une fois), révocation confirmée en place,
 * vue admin avec la colonne Compte et sans bouton de création.
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiKeyDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { ApiKeysCard } from './ApiKeysCard.js';

const TOKEN = `mmo_${'x'.repeat(43)}`;
const me = {
  user: {
    id: 'u1',
    username: 'op',
    role: 'operator',
    locale: 'fr',
    theme: 'dark',
    isActive: true,
    createdAt: 0,
    lastLoginAt: null,
    scoped: false,
  },
  scheduleTimezone: 'Europe/Paris',
  panelUpdate: null,
  privacy: { externalAvatars: true },
  grants: null,
};
const live: ApiKeyDto = {
  id: 'k1',
  userId: 'u1',
  username: 'op',
  name: 'Script de sauvegarde',
  prefix: 'mmo_abcdefgh',
  role: 'viewer',
  createdAt: 1_788_321_600_000,
  expiresAt: null,
  lastUsedAt: 1_788_321_700_000,
  lastUsedIp: '100.64.0.7',
};
const expired: ApiKeyDto = {
  ...live,
  id: 'k2',
  name: 'Ancienne',
  prefix: 'mmo_zzzzzzzz',
  role: 'operator',
  expiresAt: 1_700_000_000_000,
  lastUsedAt: null,
  lastUsedIp: null,
};

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

function installFetch(calls: Call[], keys: ApiKeyDto[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      await Promise.resolve();
      if (method === 'GET' && path === '/api/auth/me') return json(200, me);
      if (method === 'GET' && path.startsWith('/api/api-keys')) return json(200, { keys });
      if (method === 'POST' && path === '/api/api-keys') {
        const input = body as { name: string; role: string };
        return json(201, {
          key: { ...live, id: 'k3', name: input.name, role: input.role, prefix: 'mmo_xxxxxxxx' },
          token: TOKEN,
        });
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderCard(all = false): void {
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ApiKeysCard all={all} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('ApiKeysCard', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('liste les clés : préfixe seul, expirée en rouge, dernière utilisation avec l’adresse', async () => {
    installFetch(calls, [live, expired]);
    renderCard();
    const row = await screen.findByTestId('apikey-row-k1');
    expect(row).toHaveTextContent('Script de sauvegarde');
    expect(row).toHaveTextContent('mmo_abcdefgh…');
    expect(row).toHaveTextContent(i18n.t('web:role.viewer'));
    expect(row).toHaveTextContent('Jamais');
    expect(row).toHaveTextContent('100.64.0.7');
    expect(screen.getByTestId('apikey-expired-k2')).toHaveTextContent('Expirée');
    expect(screen.getByTestId('apikey-row-k2')).toHaveTextContent('Jamais utilisée');
    // Le jeton n'existe nulle part dans la liste.
    expect(document.body.textContent).not.toContain('x'.repeat(43));
  });

  it('crée une clé (rôle ≤ le sien, expiration) et montre le jeton une seule fois', async () => {
    installFetch(calls, []);
    renderCard();
    expect(await screen.findByText('Aucune clé d’API.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('apikey-create'));
    fireEvent.change(await screen.findByTestId('apikey-name'), {
      target: { value: '  Home Assistant ' },
    });
    // Un opérateur ne se voit pas proposer « Administrateur ».
    expect(screen.getByLabelText(i18n.t('web:role.operator'))).toBeInTheDocument();
    expect(screen.queryByLabelText(i18n.t('web:role.admin'))).toBeNull();
    fireEvent.click(screen.getByLabelText(i18n.t('web:role.operator')));
    fireEvent.click(screen.getByTestId('apikey-submit'));

    const token = await screen.findByTestId('apikey-token-value');
    expect(token).toHaveTextContent(TOKEN);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ name: 'Home Assistant', role: 'operator', expiresInDays: 90 });
    // Fermé, le jeton n'est plus affiché nulle part.
    fireEvent.click(screen.getByText('Fermer'));
    await waitFor(() => {
      expect(screen.queryByTestId('apikey-token-value')).toBeNull();
    });
  });

  it('révoque après confirmation en place', async () => {
    installFetch(calls, [live]);
    renderCard();
    fireEvent.click(await screen.findByTestId('apikey-revoke-k1'));
    expect(screen.getByTestId('apikey-confirm-revoke')).toHaveTextContent('Script de sauvegarde');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByTestId('apikey-confirm-revoke-yes'));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/api-keys/k1')).toBe(true);
    });
  });

  it('vue admin : toutes les clés avec leur compte, sans bouton de création', async () => {
    installFetch(calls, [live, { ...expired, username: 'ami', userId: 'u2' }]);
    renderCard(true);
    const row = await screen.findByTestId('apikey-row-k2');
    expect(row).toHaveTextContent('ami');
    expect(screen.queryByTestId('apikey-create')).toBeNull();
    expect(calls.some((c) => c.path === '/api/api-keys?all=true')).toBe(true);
  });
});
