/**
 * Lot 5 — assistant de création : le chemin final est montré avant d'écrire quoi que ce soit, un
 * nom de dossier invalide arrête là, le pré-contrôle est demandé avant le dernier écran, et le
 * bouton de création reste inerte tant que l'EULA n'est pas cochée — elle ne l'est jamais d'avance.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MachineDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { CreateServerModal } from './CreateServerModal.js';

const machine = { id: 'm1', name: 'Tour', os: 'linux' } as MachineDto;
const directories = [
  { id: 'dir1', path: '/srv/minecraft', enabled: true, lastScanAt: null },
  { id: 'dir2', path: '/data/mc', enabled: true, lastScanAt: null },
];

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function installFetch(calls: Call[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      const body: unknown =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      await Promise.resolve();
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path.startsWith('/api/install/catalog')) {
        return json({
          loader: path.includes('fabric') ? 'fabric' : 'vanilla',
          versions: [
            { id: '1.20.1', stable: true },
            { id: '1.20.2-pre1', stable: false },
          ],
        });
      }
      if (path.endsWith('/install/precheck')) {
        return json({
          precheck: {
            ok: false,
            path: { ok: true },
            port: { ok: false, code: 'port_in_use' },
            java: { ok: true },
            disk: { ok: true },
            target: {
              path: '/srv/minecraft/survie',
              gamePort: 25565,
              javaMajor: 17,
              loaderVersion: null,
            },
          },
        });
      }
      return json({ server: { id: 'srv-new' } });
    }),
  );
}

function renderModal(): { calls: Call[]; created: string[] } {
  const calls: Call[] = [];
  const created: string[] = [];
  installFetch(calls);
  render(
    <MantineProvider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CreateServerModal
          machine={machine}
          directories={directories}
          opened
          onClose={() => undefined}
          onCreated={(id) => created.push(id)}
        />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { calls, created };
}

/** Remplit le premier écran et avance jusqu'au récapitulatif. */
async function walkToReview(): Promise<void> {
  fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'survie' } });
  fireEvent.click(screen.getByTestId('install-next'));
  const version = await screen.findByTestId('install-version');
  await waitFor(() => {
    expect(version.querySelectorAll('option').length).toBeGreaterThan(1);
  });
  fireEvent.change(version, { target: { value: '1.20.1' } });
  fireEvent.click(screen.getByTestId('install-next'));
  fireEvent.click(await screen.findByTestId('install-next'));
}

describe('CreateServerModal', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('montre le chemin final, composé du répertoire choisi et du nom de dossier', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'survie' } });
    expect(screen.getByTestId('install-path')).toHaveTextContent('/srv/minecraft/survie');
    fireEvent.change(screen.getByTestId('install-directory'), { target: { value: 'dir2' } });
    await waitFor(() => {
      expect(screen.getByTestId('install-path')).toHaveTextContent('/data/mc/survie');
    });
  });

  it('un nom de dossier impossible n’avance pas d’un écran', () => {
    renderModal();
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: '../ailleurs' } });
    fireEvent.click(screen.getByTestId('install-next'));
    // Toujours le premier écran : le chemin final est encore là.
    expect(screen.getByTestId('install-path')).toBeInTheDocument();
  });

  it('le récapitulatif dit ce que la machine refuse, sans empêcher de continuer', async () => {
    const { calls } = renderModal();
    await walkToReview();
    expect(await screen.findByTestId('install-precheck-problems')).toHaveTextContent('port');
    expect(calls.some((c) => c.path.endsWith('/install/precheck'))).toBe(true);
  });

  it('l’EULA n’est jamais cochée d’avance, et rien ne part avant qu’elle le soit', async () => {
    const { calls, created } = renderModal();
    await walkToReview();
    const eula = await screen.findByTestId('install-eula');
    expect(eula).not.toBeChecked();
    expect(screen.getByTestId('install-submit')).toBeDisabled();
    fireEvent.click(eula);
    fireEvent.click(screen.getByTestId('install-submit'));
    await waitFor(() => {
      expect(created).toEqual(['srv-new']);
    });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/machines/m1/install');
    expect(post?.body).toMatchObject({
      directoryId: 'dir1',
      folderName: 'survie',
      loader: 'vanilla',
      mcVersion: '1.20.1',
      acceptEula: true,
    });
  });

  it('changer de chargeur relit le catalogue et oublie la version choisie', async () => {
    const { calls } = renderModal();
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'survie' } });
    fireEvent.click(screen.getByTestId('install-next'));
    const version = await screen.findByTestId('install-version');
    await waitFor(() => {
      expect(version.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    fireEvent.change(version, { target: { value: '1.20.1' } });
    fireEvent.click(screen.getByLabelText('Fabric'));
    await waitFor(() => {
      expect(calls.some((c) => c.path.includes('loader=fabric'))).toBe(true);
    });
    // La version repart de zéro : celle de vanilla n'est pas forcément supportée par Fabric.
    await waitFor(() => {
      expect(screen.getByTestId('install-version')).toHaveValue('');
    });
  });
});
