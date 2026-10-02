/**
 * Machine hors ligne : on dit depuis quand, que l'agent retente seul, puis le remède si ça dure
 * (retour de Yassin, 02/10). Et rien de tout cela pour une machine en ligne ou jamais appairée.
 */
import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MachineDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { OfflineNotice } from './OfflineNotice.js';

const T0 = 1_800_000_000_000;
const machine = (over: Partial<MachineDto>): MachineDto =>
  ({
    id: 'm1',
    name: 'PC',
    connected: false,
    lastSeenAt: T0,
    os: 'windows',
    ...over,
  }) as MachineDto;
const mount = (m: MachineDto): void => {
  render(
    <MantineProvider>
      <OfflineNotice machine={m} />
    </MantineProvider>,
  );
};

describe('machine hors ligne', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 12_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('les deux premières minutes : attente normale, avec un compteur qui avance', () => {
    mount(machine({}));
    const notice = screen.getByTestId('machine-offline');
    expect(notice).toHaveAttribute('data-stage', 'waiting');
    expect(notice).toHaveTextContent('Hors ligne depuis 12 s : l’agent se reconnecte tout seul');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('machine-offline')).toHaveTextContent('Hors ligne depuis 15 s');
  });

  it('au-delà de deux minutes : ce n’est plus une attente, le remède est donné sur place', () => {
    vi.setSystemTime(T0 + 121_000);
    mount(machine({}));
    const notice = screen.getByTestId('machine-offline');
    expect(notice).toHaveAttribute('data-stage', 'stuck');
    expect(notice).toHaveTextContent('Hors ligne depuis 2 min 01 : l’agent ne revient pas');
    expect(notice).toHaveTextContent('Start-Service mmo-agent');
  });

  it('la commande Windows n’est pas proposée pour une machine Linux', () => {
    vi.setSystemTime(T0 + 300_000);
    mount(machine({ os: 'linux' }));
    expect(screen.getByTestId('machine-offline')).not.toHaveTextContent('Start-Service');
  });

  it('rien pour une machine en ligne, ni pour une machine jamais appairée', () => {
    mount(machine({ connected: true }));
    mount(machine({ lastSeenAt: null }));
    expect(screen.queryByTestId('machine-offline')).toBeNull();
  });
});
