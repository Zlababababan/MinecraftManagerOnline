/**
 * Une macro est à un clic. Le comportement qui compte est donc celui du clic : une séquence
 * anodine part directement, une séquence qui arrête ou détruit passe par une confirmation qui
 * montre les commandes exactes — c'est la séquence qu'on approuve, pas un nom.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MacroDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { MacroBar } from './MacroBar.js';

const MACROS: MacroDto[] = [
  {
    id: 'm1',
    name: 'Annonce',
    commands: ['say bonjour'],
    serverId: null,
    createdBy: 'u1',
    updatedAt: 1,
    destructive: false,
  },
  {
    id: 'm2',
    name: 'Redémarrage',
    commands: ['say arrêt dans 10s', 'save-all flush', 'stop'],
    serverId: null,
    createdBy: 'u1',
    updatedAt: 1,
    destructive: true,
  },
];

interface Call {
  method: string;
  url: string;
  body: string;
}

function renderBar(calls: Call[], runResult: unknown, runStatus = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      const isRun = url.includes('/run');
      return Promise.resolve(
        new Response(JSON.stringify(isRun ? runResult : { macros: MACROS }), {
          status: isRun ? runStatus : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <MacroBar serverId="srv_1" canSend />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('barre de macros', () => {
  let calls: Call[];

  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('joue une macro anodine d’un seul clic', async () => {
    const user = userEvent.setup();
    renderBar(calls, { results: [{ command: 'say bonjour', ok: true, via: 'rcon' }] });
    await user.click(await screen.findByTestId('macro-run-m1'));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/macros/m1/run') && c.method === 'POST')).toBe(true);
    });
  });

  it('demande confirmation avant une séquence qui arrête le serveur, et montre laquelle', async () => {
    const user = userEvent.setup();
    renderBar(calls, { results: [] });
    await user.click(await screen.findByTestId('macro-run-m2'));
    // Rien n'est parti tant que rien n'est confirmé.
    expect(calls.some((c) => c.url.includes('/run'))).toBe(false);
    await screen.findByTestId('macro-confirm-run');
    // Les commandes exactes sont sous les yeux : c'est ce qu'on approuve.
    expect(screen.getByText('stop')).toBeInTheDocument();
    expect(screen.getByText('save-all flush')).toBeInTheDocument();

    await user.click(screen.getByTestId('macro-confirm-run'));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/macros/m2/run'))).toBe(true);
    });
    // La confirmation voyage jusqu'au panel : c'est LUI qui tranche, pas le DTO en cache.
    // La VALEUR est verrouillée : `toContain('confirmDestructive')` passerait aussi avec `false`.
    expect(calls.find((c) => c.url.includes('/run'))?.body).toContain('"confirmDestructive":true');
    // Et elle approuve la VERSION affichée dans le modal, pas un booléen nu.
    expect(calls.find((c) => c.url.includes('/run'))?.body).toContain('"approvedAt":1');
  });

  it('ouvre la confirmation quand le panel la réclame, avec la séquence qu’il renvoie', async () => {
    const user = userEvent.setup();
    // Cas réel : la macro a gagné un « stop » depuis un autre onglet, la liste locale l'ignore.
    renderBar(
      calls,
      {
        code: 'E_CONFLICT',
        message: 'this macro needs an explicit confirmation',
        retryable: false,
        details: {
          reason: 'confirm_required',
          name: 'Annonce',
          commands: ['say bonjour', 'stop'],
          updatedAt: 2,
        },
      },
      409,
    );
    await user.click(await screen.findByTestId('macro-run-m1'));
    // `macro-confirm` est posé sur la racine de la modale, que Mantine rend même fermée :
    // c'est le bouton d'action qui prouve son ouverture.
    await screen.findByTestId('macro-confirm-run');
    // La séquence affichée est celle du serveur, pas celle qu'on croyait connaître.
    expect(screen.getByText('stop')).toBeInTheDocument();

    await user.click(screen.getByTestId('macro-confirm-run'));
    await waitFor(() => {
      expect(calls.filter((c) => c.url.includes('/run')).length).toBe(2);
    });
    // La ré-approbation porte la version FRAÎCHE renvoyée par le refus, pas celle du cache.
    expect(calls.filter((c) => c.url.includes('/run'))[1]?.body).toContain('"approvedAt":2');
  });

  it('une liste en échec le dit, au lieu de se faire passer pour vide', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ code: 'E_INTERNAL', message: 'internal error', retryable: false }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineProvider>
        <QueryClientProvider client={client}>
          <MacroBar serverId="srv_1" canSend />
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(await screen.findByTestId('macros-error')).toBeInTheDocument();
  });

  it('annuler la confirmation n’envoie rien', async () => {
    const user = userEvent.setup();
    renderBar(calls, { results: [] });
    await user.click(await screen.findByTestId('macro-run-m2'));
    await screen.findByTestId('macro-confirm-run');
    await user.click(screen.getByText('Annuler'));
    await waitFor(() => {
      expect(screen.queryByTestId('macro-confirm-run')).not.toBeInTheDocument();
    });
    expect(calls.some((c) => c.url.includes('/run'))).toBe(false);
  });

  it('un lecteur seule ne voit pas la barre', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <MantineProvider>
        <QueryClientProvider client={client}>
          <MacroBar serverId="srv_1" canSend={false} />
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(container.querySelector('[data-testid="console-macros"]')).toBeNull();
  });
});
