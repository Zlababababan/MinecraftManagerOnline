/**
 * Onglet Métriques contre une API simulée : valeurs « maintenant », résolution annoncée, graphiques
 * rendus, TPS **honnête** (indisponible expliqué, spark proposé jamais requis), avertissement
 * `cpuSource: 'ticks'`, changement de plage.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDto, ServerMetricsResult } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { ServerMetricsPanel, tpsUnavailableReason } from './MetricsPanel.js';

const base: ServerDto = {
  id: 's1',
  machineId: 'm1',
  directoryId: null,
  path: '/srv/a',
  name: 'A',
  loader: 'fabric',
  mcVersion: '1.20.1',
  loaderVersion: null,
  detected: true,
  javaMajorRequired: 17,
  javaArgs: [],
  minRamMb: 1024,
  maxRamMb: 2048,
  gamePort: 25565,
  rconEnabled: true,
  rconPort: 25575,
  eulaAccepted: true,
  exposeMode: 'tailnet',
  provisioning: 'ready',
  runState: 'running',
  desiredState: 'running',
  attachMode: 'attached',
  lastExitReason: null,
  autoRestart: true,
  crashLoopMax: 3,
  watchdogFreezeS: 120,
  pid: 1,
  startedAt: 0,
  stoppedAt: null,
  createdAt: 0,
  updatedAt: 0,
  reachable: true,
  groupId: null,
  groupPosition: 0,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(
  result: (query: URLSearchParams) => ServerMetricsResult,
  calls: string[] = [],
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      calls.push(path);
      await Promise.resolve();
      if (path.startsWith('/api/servers/s1/metrics')) {
        return json(200, result(new URL(url, 'http://x').searchParams));
      }
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function rawResult(over: Partial<ServerMetricsResult> = {}): ServerMetricsResult {
  const now = Date.now();
  return {
    resolution: 'raw',
    from: now - 3_600_000,
    to: now,
    points: [
      { ts: now - 45_000, cpu: 40, ram: 1500, tps: null, mspt: null, players: 1 },
      { ts: now - 30_000, cpu: null, ram: 1510, tps: null, mspt: null, players: 1 },
      { ts: now - 15_000, cpu: 55.5, ram: 1520, tps: null, mspt: null, players: 2 },
    ],
    latest: { ts: now - 15_000, cpu: 55.5, ram: 1520, tps: null, mspt: null, players: 2 },
    tpsSource: null,
    cpuSource: 'cycles',
    ...over,
  };
}

function renderPanel(server: ServerDto = base) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <ServerMetricsPanel server={server} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('ServerMetricsPanel — graphiques et TPS honnête', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('affiche « maintenant », la résolution, les 4 graphiques, et explique le TPS indisponible (Fabric sans spark)', async () => {
    installFetch(() => rawResult());
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('metrics-resolution')).toHaveTextContent('Échantillons bruts');
    });
    expect(screen.getByText('56 %')).toBeInTheDocument();
    expect(screen.getByText('1.5 GB')).toBeInTheDocument();
    for (const id of ['chart-cpu', 'chart-ram', 'chart-tps', 'chart-players']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // Ligne CPU : le trou (null au milieu) coupe le tracé en deux segments « M »
    const cpuPath = screen.getByTestId('series-cpu').querySelector('path[fill="none"]');
    expect(cpuPath?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    const alert = screen.getByTestId('tps-unavailable');
    expect(alert).toHaveTextContent('TPS indisponible');
    expect(alert).toHaveTextContent('Fabric n’a pas de commande TPS intégrée');
    expect(alert).toHaveTextContent('jamais requis');
    expect(screen.getByRole('link', { name: 'Télécharger spark' })).toHaveAttribute(
      'href',
      'https://spark.lucko.me/download',
    );
    expect(screen.queryByTestId('cpu-ticks-warning')).not.toBeInTheDocument();
  });

  it('TPS mesuré (forge) avec sa source, avertissement quand le CPU est mesuré par ticks', async () => {
    installFetch(() =>
      rawResult({
        latest: { ts: 1, cpu: 10, ram: 1000, tps: 19.6, mspt: 12.3, players: 0 },
        tpsSource: 'forge',
        cpuSource: 'ticks',
      }),
    );
    renderPanel({ ...base, loader: 'forge' });
    await waitFor(() => {
      expect(screen.getByText('19.6')).toBeInTheDocument();
    });
    expect(screen.getByText('12.3 ms · via /forge tps')).toBeInTheDocument();
    expect(screen.queryByTestId('tps-unavailable')).not.toBeInTheDocument();
    expect(screen.getByTestId('cpu-ticks-warning')).toHaveTextContent('CPU mesuré par ticks');
  });

  it('changement de plage : nouvelle requête, résolution agrégée annoncée, bande min/max', async () => {
    const calls: string[] = [];
    installFetch((query) => {
      const from = Number(query.get('from'));
      const span = Date.now() - from;
      if (span > 2 * 3_600_000) {
        return rawResult({
          resolution: '1h',
          from,
          points: [
            {
              ts: from + 3_600_000,
              cpu: 20,
              cpuMax: 60,
              ram: 1000,
              ramMax: 1200,
              tps: 19,
              tpsMin: 15,
              players: 3,
              samples: 240,
            },
            {
              ts: from + 7_200_000,
              cpu: 25,
              cpuMax: 70,
              ram: 1100,
              ramMax: 1300,
              tps: 20,
              tpsMin: 18,
              players: 1,
              samples: 240,
            },
          ],
        });
      }
      return rawResult();
    }, calls);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('metrics-resolution')).toHaveTextContent('bruts');
    });
    await userEvent.click(screen.getByRole('radio', { name: '7 j' }));
    await waitFor(() => {
      expect(screen.getByTestId('metrics-resolution')).toHaveTextContent('Moyennes horaires');
    });
    expect(calls.filter((c) => c.includes('/metrics')).length).toBeGreaterThanOrEqual(2);
    // La bande max est dessinée (polygone rempli) pour les plages agrégées
    expect(screen.getByTestId('series-cpu').querySelector('path[opacity]')).not.toBeNull();
  });

  it('tpsUnavailableReason : raisons honnêtes par loader/version', () => {
    expect(
      tpsUnavailableReason({ loader: 'vanilla', mcVersion: '1.12.2', runState: 'running' }),
    ).toBe('vanillaOld');
    expect(
      tpsUnavailableReason({ loader: 'vanilla', mcVersion: '1.21', runState: 'running' }),
    ).toBe('unknown');
    expect(
      tpsUnavailableReason({ loader: 'fabric', mcVersion: '1.20.1', runState: 'running' }),
    ).toBe('fabricNoSpark');
    expect(
      tpsUnavailableReason({ loader: 'fabric', mcVersion: '1.21.1', runState: 'running' }),
    ).toBe('unknown');
    expect(
      tpsUnavailableReason({ loader: 'forge', mcVersion: '1.16.5', runState: 'running' }),
    ).toBe('forgeNoAnswer');
    expect(
      tpsUnavailableReason({ loader: 'forge', mcVersion: '1.16.5', runState: 'stopped' }),
    ).toBe('notRunning');
  });
});
