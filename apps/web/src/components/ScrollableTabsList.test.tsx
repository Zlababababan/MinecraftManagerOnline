/** Chevrons de défilement des onglets : absents sans débordement, cliquables et bornés sinon. */
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../i18n/index.js';
import { ScrollableTabsList } from './ScrollableTabsList.js';

function viewport(): HTMLElement {
  const el = document.querySelector('.mantine-ScrollArea-viewport');
  if (!(el instanceof HTMLElement)) throw new Error('viewport introuvable');
  return el;
}

describe('ScrollableTabsList', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    render(
      <MantineProvider>
        <ScrollableTabsList>
          <div>onglets</div>
        </ScrollableTabsList>
      </MantineProvider>,
    );
  });

  it('sans débordement : aucun chevron', () => {
    expect(screen.queryByTestId('tabs-scroll-left')).toBeNull();
    expect(screen.queryByTestId('tabs-scroll-right')).toBeNull();
  });

  it('avec débordement : chevrons bornés, clic = défilement', async () => {
    const user = userEvent.setup();
    const el = viewport();
    Object.defineProperty(el, 'scrollWidth', { value: 600, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 300, configurable: true });
    const scrollBy = vi.fn();
    el.scrollBy = scrollBy;
    fireEvent.scroll(el);

    // En butée gauche : chevron gauche désactivé, droit actif.
    expect(screen.getByTestId('tabs-scroll-left')).toBeDisabled();
    const right = screen.getByTestId('tabs-scroll-right');
    expect(right).toBeEnabled();
    await user.click(right);
    expect(scrollBy).toHaveBeenCalledWith({ left: 240, behavior: 'smooth' });

    // Au milieu : les deux actifs ; en butée droite : droit désactivé.
    el.scrollLeft = 150;
    fireEvent.scroll(el);
    expect(screen.getByTestId('tabs-scroll-left')).toBeEnabled();
    expect(screen.getByTestId('tabs-scroll-right')).toBeEnabled();
    el.scrollLeft = 300;
    fireEvent.scroll(el);
    expect(screen.getByTestId('tabs-scroll-right')).toBeDisabled();
  });
});
