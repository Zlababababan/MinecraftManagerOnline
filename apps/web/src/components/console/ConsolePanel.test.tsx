/**
 * Console : préchargement de l'historique depuis `logs/latest.log` (les lignes live arrivées
 * pendant la lecture sont rejouées APRÈS l'historique), bouton de téléchargement du log.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import type { RealtimeClient } from '../../ws/client.js';
import { ConsolePanel, historyLines } from './ConsolePanel.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Client temps réel factice : expose `emit` pour pousser des messages serveur. */
function fakeClient(): RealtimeClient & { emit(message: ServerMessage): void } {
  const handlers = new Set<(message: ServerMessage) => void>();
  return {
    on: (handler: (message: ServerMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    subscribe: () => () => undefined,
    connect: () => undefined,
    emit: (message: ServerMessage) => {
      for (const h of handlers) h(message);
    },
  } as unknown as RealtimeClient & { emit(message: ServerMessage): void };
}

describe('ConsolePanel', () => {
  let resolveRead: (r: Response) => void;

  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    const read = new Promise<Response>((resolve) => {
      resolveRead = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/files/read')) return read;
        return Promise.resolve(json(404, { code: 'E_NOT_FOUND', message: url }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("affiche l'historique de latest.log AVANT les lignes live arrivées pendant la lecture", async () => {
    const client = fakeClient();
    render(
      <MantineProvider>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ConsolePanel serverId="s1" canSend={false} client={client} />
        </QueryClientProvider>
      </MantineProvider>,
    );
    // Une ligne live arrive pendant que latest.log se charge : elle doit être mise en attente.
    client.emit({
      type: 'console.snapshot',
      serverId: 's1',
      truncated: false,
      latestSeq: 1,
      lines: [{ seq: 1, ts: 1, level: 'INFO', text: 'ligne directe' }],
    });
    resolveRead(
      json(200, {
        content: 'vieille ligne 1\nvieille ligne 2\n',
        encoding: 'utf8',
        sha256: '0'.repeat(64),
        size: 32,
        truncated: false,
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('console-mirror').textContent).toContain('ligne directe');
    });
    const mirror = screen.getByTestId('console-mirror').textContent;
    expect(mirror.indexOf('vieille ligne 1')).toBeGreaterThanOrEqual(0);
    expect(mirror.indexOf('vieille ligne 2')).toBeGreaterThan(mirror.indexOf('vieille ligne 1'));
    expect(mirror.indexOf('ligne directe')).toBeGreaterThan(mirror.indexOf('vieille ligne 2'));

    const download = screen.getByTestId('console-download-log');
    expect(download).toHaveAttribute(
      'href',
      '/api/servers/s1/files/download?path=logs%2Flatest.log',
    );
  });

  // Sur iOS, sans ces attributs le clavier met une majuscule au premier mot et autocorrige :
  // `say bonjour` part en `Say bonjour`, et un pseudo est réécrit. La commande est refusée par
  // le serveur sans que l'utilisateur comprenne pourquoi.
  it('le champ de commande désactive majuscule et autocorrection (clavier iOS)', () => {
    render(
      <MantineProvider>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ConsolePanel serverId="s1" canSend client={fakeClient()} />
        </QueryClientProvider>
      </MantineProvider>,
    );
    const input = screen.getByTestId('console-input');
    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('enterkeyhint', 'send');
  });

  it('historyLines : dernières lignes non vides, bornées', () => {
    expect(historyLines('a\r\nb\n\nc\n', 2)).toEqual(['b', 'c']);
    expect(historyLines('')).toEqual([]);
  });
});
