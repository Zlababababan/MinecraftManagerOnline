/**
 * Réglages d'un serveur : la priorité CPU (remontée « un onglet Twitch qui rame »). Le formulaire
 * part de la valeur du serveur — pas d'un défaut en dur — et n'envoie que ce que l'utilisateur a
 * choisi. `SegmentedControl` et non `Select` : trois valeurs, et il rend de vrais boutons radio
 * que jsdom sait atteindre.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDto, UserDto } from '@mmo/protocol/client';

import { i18n } from '../i18n/index.js';
import { Settings } from './ServerPage.js';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => undefined,
  createLink: (component: unknown) => component,
}));

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

function server(over: Partial<ServerDto> = {}): ServerDto {
  return {
    id: 's1',
    machineId: 'm1',
    directoryId: null,
    path: 'E:/mc/survie',
    name: 'Survie',
    loader: 'forge',
    mcVersion: '1.20.1',
    loaderVersion: null,
    detected: true,
    javaMajorRequired: 17,
    javaArgs: [],
    minRamMb: 1024,
    maxRamMb: 8192,
    cpuPriority: 'normal',
    gamePort: 25565,
    rconEnabled: true,
    rconPort: null,
    eulaAccepted: true,
    exposeMode: 'tailnet',
    provisioning: 'ready',
    runState: 'running',
    desiredState: 'running',
    attachMode: 'attached',
    lastExitReason: null,
    autoRestart: false,
    crashLoopMax: 3,
    watchdogFreezeS: 120,
    pid: 1234,
    startedAt: 0,
    stoppedAt: null,
    createdAt: 0,
    updatedAt: 0,
    reachable: true,
    groupId: null,
    groupPosition: 0,
    ...over,
  };
}

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

function renderSettings(dto: ServerDto, focus?: string): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      await Promise.resolve();
      if (path === '/api/auth/me') return json(200, { user: admin });
      if (path === '/api/servers/s1') return json(200, { server: dto });
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <Notifications />
      <ModalsProvider>
        <QueryClientProvider client={qc}>
          <Settings server={dto} focus={focus} />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
  return calls;
}

describe('réglages serveur — priorité CPU', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('propose les trois niveaux et part de celui du serveur', async () => {
    renderSettings(server({ cpuPriority: 'low' }));
    // Le champ n'apparaît qu'une fois `me` résolu (les réglages sont réservés aux administrateurs).
    expect(await screen.findByLabelText('Minimale')).toBeChecked();
    expect(screen.getByLabelText('Normale')).not.toBeChecked();
    expect(screen.getByLabelText('Réduite')).not.toBeChecked();
  });

  it('enregistre le niveau choisi', async () => {
    const user = userEvent.setup();
    const calls = renderSettings(server());
    expect(await screen.findByLabelText('Normale')).toBeChecked();

    await user.click(screen.getByLabelText('Réduite'));
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH' && c.path === '/api/servers/s1')).toBe(true);
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ cpuPriority: 'below_normal' });
  });

  it('?focus=ram (lien « Mémoire » de l’aperçu) met la mémoire en avant, et rien sans focus', async () => {
    renderSettings(server(), 'ram');
    await screen.findByLabelText('Normale');
    expect(document.querySelector('[data-focus-target="ram"]')).toHaveClass('mmo-focus');
    expect(document.querySelector('[data-focus-target="auto-restart"]')).not.toHaveClass(
      'mmo-focus',
    );
  });

  it('sans focus, aucun réglage n’est mis en avant', async () => {
    renderSettings(server());
    await screen.findByLabelText('Normale');
    expect(document.querySelector('.mmo-focus')).toBeNull();
  });

  it('dit quand le réglage prend effet', async () => {
    renderSettings(server());
    expect(await screen.findByText(/prochain démarrage/i)).toBeInTheDocument();
  });
});
