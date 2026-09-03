/**
 * Réglages → Utilisateurs et Journal d'audit contre une API simulée : liste, garde-fous sur son
 * propre compte, création (POST), changement de rôle (PATCH), journal avec détail dépliable.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import type { AuditDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { AuditCard } from './AuditCard.js';
import { UsersCard } from './UsersCard.js';

const admin: UserDto = {
  id: 'u1',
  username: 'admin',
  role: 'admin',
  locale: 'fr',
  theme: 'dark',
  isActive: true,
  createdAt: 0,
  lastLoginAt: 1_787_330_000_000,
  scoped: false,
};
const viewer: UserDto = {
  id: 'u2',
  username: 'lecteur',
  role: 'viewer',
  locale: 'fr',
  theme: 'dark',
  isActive: true,
  createdAt: 0,
  lastLoginAt: null,
  scoped: false,
};

const entry: AuditDto = {
  id: 42,
  ts: 1_787_330_455_000,
  userId: 'u1',
  username: 'admin',
  action: 'server.start',
  targetType: 'server',
  targetId: 's1',
  targetLabel: 'Survie',
  details: { pid: 1234 },
  ip: '127.0.0.1',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function installFetch(calls: Call[], users: UserDto[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      await Promise.resolve();
      if (path === '/api/auth/me') return json(200, { user: admin });
      if (path === '/api/users' && method === 'GET') return json(200, { users });
      if (path === '/api/users' && method === 'POST') {
        const created = { ...viewer, id: 'u3', ...(body as object) };
        users.push(created);
        return json(201, { user: created });
      }
      if (path.startsWith('/api/users/') && method === 'PATCH') {
        return json(200, { user: { ...viewer, ...(body as object) } });
      }
      // Lot 8 : portées d'un compte limité.
      if (path.endsWith('/grants') && method === 'GET') {
        return json(200, {
          grants: {
            servers: [
              { serverId: 's-b', role: 'viewer' },
              { serverId: 's-c', role: 'viewer' },
            ],
            machines: [],
          },
        });
      }
      if (path.endsWith('/grants') && method === 'PUT') return json(200, { grants: body });
      if (path === '/api/machines') {
        return json(200, {
          machines: [
            { id: 'm1', name: 'PC', status: 'online' },
            { id: 'm2', name: 'VM', status: 'online' },
          ],
        });
      }
      if (path === '/api/servers') {
        return json(200, {
          servers: [
            { id: 's-a', name: 'Survie', machineId: 'm1' },
            { id: 's-b', name: 'Créatif', machineId: 'm1' },
            { id: 's-c', name: 'Modpack', machineId: 'm2' },
          ],
        });
      }
      if (path.startsWith('/api/audit')) return json(200, { audit: [entry] });
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderWith(node: ReactNode) {
  render(
    <MantineProvider>
      <Notifications />
      <ModalsProvider>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          {node}
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
}

describe('réglages — utilisateurs et audit', () => {
  let calls: Call[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
    installFetch(calls, [admin, viewer]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('liste les comptes, protège le compte courant, crée un utilisateur', async () => {
    const user = userEvent.setup();
    renderWith(<UsersCard />);
    const own = await screen.findByTestId('user-admin');
    expect(within(own).getByText(/vous/)).toBeInTheDocument();
    expect(screen.getByTestId('user-role-admin')).toBeDisabled();
    expect(screen.getByTestId('user-delete-admin')).toBeDisabled();
    expect(screen.getByTestId('user-role-lecteur')).toBeEnabled();

    await user.type(screen.getByTestId('user-create-username'), 'operateur');
    await user.type(screen.getByTestId('user-create-password'), 'correct horse battery');
    await user.click(screen.getByTestId('user-create-submit'));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST' && c.path === '/api/users')?.body).toEqual({
        username: 'operateur',
        password: 'correct horse battery',
        role: 'viewer',
        scoped: false,
      });
    });
    expect(await screen.findByTestId('user-operateur')).toBeInTheDocument();
  });

  it('lot 8 — accès « serveurs choisis » : PATCH scoped, puis la modale des portées enregistre machines et serveurs', async () => {
    const user = userEvent.setup();
    const scoped: UserDto = { ...viewer, id: 'u4', username: 'ami', scoped: true };
    installFetch(calls, [admin, viewer, scoped]);
    renderWith(<UsersCard />);
    await screen.findByTestId('user-ami');
    // Un administrateur voit tout : son accès ne se règle pas ; un lecteur, si.
    expect(screen.getByTestId('user-access-admin')).toBeDisabled();
    expect(screen.getByTestId('user-access-lecteur')).toBeEnabled();
    expect(screen.queryByTestId('user-grants-lecteur')).toBeNull();
    expect(screen.getByTestId('user-grants-ami')).toBeInTheDocument();

    await user.click(screen.getByTestId('user-grants-ami'));
    const modal = await screen.findByTestId('grants-modal');
    // Portées reçues : s-b coché, tout le reste libre.
    await waitFor(() => {
      expect(within(modal).getByTestId('grant-server-s-b')).toBeChecked();
    });
    expect(within(modal).getByTestId('grant-server-s-a')).not.toBeChecked();
    // Accorder la machine m2 : son serveur s-c (accordé seul jusque-là) passe « couvert par la
    // machine » et perd sa ligne propre à l'enregistrement.
    expect(within(modal).getByTestId('grant-server-s-c')).toBeChecked();
    expect(within(modal).getByTestId('grant-server-s-c')).toBeEnabled();
    await user.click(within(modal).getByTestId('grant-machine-m2'));
    expect(within(modal).getByTestId('grant-server-s-c')).toBeChecked();
    expect(within(modal).getByTestId('grant-server-s-c')).toBeDisabled();
    await user.click(within(modal).getByTestId('grant-server-s-a'));
    await user.click(within(modal).getByTestId('grants-save'));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/api/users/u4/grants');
    });
    // Un lecteur n'a que « lecture » à accorder ; s-c n'a pas de ligne propre (couvert).
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      machines: [{ machineId: 'm2', role: 'viewer' }],
      servers: [
        { serverId: 's-b', role: 'viewer' },
        { serverId: 's-a', role: 'viewer' },
      ],
    });
  });

  it('désactivation d’un compte : PATCH sur le compte visé', async () => {
    const user = userEvent.setup();
    renderWith(<UsersCard />);
    await user.click(await screen.findByTestId('user-active-lecteur'));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.path).toBe('/api/users/u2');
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ isActive: false });
  });

  it('journal d’audit : lignes lisibles, détail au clic', async () => {
    const user = userEvent.setup();
    renderWith(<AuditCard />);
    const row = await screen.findByTestId('audit-42');
    expect(row.textContent).toContain('admin');
    expect(row.textContent).toContain('server.start');
    expect(row.textContent).toContain('Survie');
    expect(screen.queryByText(/"pid": 1234/)).toBeNull();
    await user.click(row);
    expect(await screen.findByText(/"pid": 1234/)).toBeInTheDocument();
  });
});
