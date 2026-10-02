/**
 * Données sensibles floutées par défaut (demande de Yassin, 02/10) : floues tant qu'on n'a rien
 * demandé, révélées d'un clic ou par l'interrupteur de l'en-tête, et le choix « tout afficher »
 * se retient dans le navigateur.
 */
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '../i18n/index.js';
import { setRevealSensitive } from '../lib/sensitive.js';
import { Sensitive, SensitiveSentence, SensitiveToggle } from './Sensitive.js';

function mount(): void {
  render(
    <MantineProvider>
      <SensitiveToggle />
      <p data-testid="a">
        <Sensitive>2001:db8::1</Sensitive>
      </p>
      <p data-testid="b">
        <SensitiveSentence value="mc.example:25570" render={(v) => `Prêt à l’adresse ${v} !`} />
      </p>
    </MantineProvider>,
  );
}
const hidden = (): number => document.querySelectorAll('[data-sensitive="hidden"]').length;

describe('données sensibles', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    setRevealSensitive(false);
  });
  afterEach(() => {
    setRevealSensitive(false);
  });

  it('floues par défaut ; la phrase autour reste lisible et le texte reste dans la page', () => {
    mount();
    expect(hidden()).toBe(2);
    expect(screen.getByText('2001:db8::1')).toHaveClass('mmo-sensitive-hidden');
    expect(screen.getByTestId('b')).toHaveTextContent('Prêt à l’adresse mc.example:25570 !');
    expect(screen.getByText('mc.example:25570')).toHaveClass('mmo-sensitive-hidden');
  });

  it('un clic révèle la donnée cliquée, pas les autres', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByText('2001:db8::1'));
    expect(screen.getByText('2001:db8::1')).not.toHaveClass('mmo-sensitive-hidden');
    expect(screen.getByText('mc.example:25570')).toHaveClass('mmo-sensitive-hidden');
  });

  it('l’interrupteur affiche tout, le retient dans le navigateur, puis refloute tout', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sensitive-toggle'));
    expect(hidden()).toBe(0);
    expect(localStorage.getItem('mmo.revealSensitive')).toBe('1');
    await user.click(screen.getByTestId('sensitive-toggle'));
    expect(hidden()).toBe(2);
    expect(localStorage.getItem('mmo.revealSensitive')).toBeNull();
  });
});
