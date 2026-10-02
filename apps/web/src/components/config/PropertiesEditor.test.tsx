/**
 * Éditeur de configuration : arriver sur un champ précis (lien de l'aperçu) et le piège des deux
 * ports de Minecraft (retour de Yassin, 02/10 : il avait changé `query.port` en croyant changer le
 * port de jeu).
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { PropertiesEditor } from './PropertiesEditor.js';

const admin: UserDto = {
  id: 'u1',
  username: 'admin',
  role: 'admin',
  locale: 'fr',
  theme: 'dark',
  isActive: true,
  createdAt: 0,
  lastLoginAt: null,
  scoped: false,
};

const server = {
  id: 's1',
  machineId: 'm1',
  name: 'Survie',
  runState: 'stopped',
  reachable: true,
} as unknown as ServerDto;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderEditor(focusKey?: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      await Promise.resolve();
      if (path === '/api/auth/me') return json(200, { user: admin });
      if (path === '/api/servers/s1/config/server.properties') {
        return json(200, {
          file: 'server.properties',
          data: { 'server-port': '25565', 'query.port': '25565', motd: 'Hi' },
          sha256: 'a'.repeat(64),
          source: 'file',
        });
      }
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={qc}>
        <PropertiesEditor server={server} focusKey={focusKey} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

const target = (key: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-focus-target="${key}"]`);
  if (node === null) throw new Error(`cible ${key} absente`);
  return node;
};
const expanded = (category: string): string | null =>
  screen.getByTestId(`properties-cat-${category}`).getAttribute('aria-expanded');

describe('éditeur de configuration — arriver sur un champ, les deux ports', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('?focus=server-port : la rubrique Réseau est ouverte et le champ mis en avant, lui seul', async () => {
    renderEditor('server-port');
    await screen.findByTestId('prop-server-port');
    expect(expanded('network')).toBe('true');
    expect(target('server-port')).toHaveClass('mmo-focus');
    expect(target('query.port')).not.toHaveClass('mmo-focus');
  });

  it('sans focus : rien n’est mis en avant et Réseau reste fermé', async () => {
    renderEditor();
    await screen.findByTestId('prop-server-port');
    expect(expanded('network')).toBe('false');
    expect(document.querySelector('.mmo-focus')).toBeNull();
  });

  it('changer seulement query.port prévient et mène au port de jeu ; changer aussi server-port ne prévient plus', async () => {
    const user = userEvent.setup();
    renderEditor('query.port');
    const query = await screen.findByTestId('prop-query.port');
    expect(screen.queryByTestId('properties-warning-queryPortOnly')).toBeNull();

    await user.clear(query);
    await user.type(query, '25570');
    expect(await screen.findByTestId('properties-warning-queryPortOnly')).toHaveTextContent(
      /pas le port que les joueurs tapent/,
    );

    await user.click(screen.getByTestId('properties-warning-queryPortOnly-show'));
    expect(target('server-port')).toHaveClass('mmo-focus');
    expect(target('query.port')).not.toHaveClass('mmo-focus');

    const port = screen.getByTestId('prop-server-port');
    await user.clear(port);
    await user.type(port, '25570');
    expect(screen.queryByTestId('properties-warning-queryPortOnly')).toBeNull();
  });
});
