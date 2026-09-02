/**
 * Lot 9 — vie privée : avatars coupés dans les réglages → initiales, aucune image demandée à
 * mc-heads.net. Le composant lit un drapeau synchrone (`lib/privacy.ts`), pas une requête.
 */
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { configurePrivacy } from '../../lib/privacy.js';
import { PlayerAvatar, avatarUrl, isOfflineUuid } from './PlayerAvatar.js';

function mount(node: React.ReactElement) {
  return render(<MantineProvider>{node}</MantineProvider>);
}

describe('PlayerAvatar', () => {
  afterEach(() => {
    configurePrivacy({ externalAvatars: true });
  });

  it('demande la tête du skin à mc-heads.net par défaut', () => {
    mount(<PlayerAvatar name="Steve" uuid="069a79f4-44e9-4726-a5be-fca90e38aaf5" />);
    const img = screen.getByTestId('player-avatar').querySelector('img');
    expect(img?.getAttribute('src')).toBe(
      avatarUrl('Steve', '069a79f4-44e9-4726-a5be-fca90e38aaf5', 64),
    );
    expect(img?.getAttribute('src')).toContain('https://mc-heads.net/avatar/');
  });

  it('avatars coupés : initiales seulement, aucune image', () => {
    configurePrivacy({ externalAvatars: false });
    mount(<PlayerAvatar name="Steve" uuid="069a79f4-44e9-4726-a5be-fca90e38aaf5" />);
    const avatar = screen.getByTestId('player-avatar');
    expect(avatar.querySelector('img')).toBeNull();
    // Mantine met les initiales en capitales.
    expect(avatar.textContent).toBe('ST');
  });

  it('un UUID de mode hors ligne (v3) n’a pas de skin : le pseudo sert d’identifiant', () => {
    expect(isOfflineUuid('5f4f2a4b-1c2d-3e4f-9a8b-7c6d5e4f3a2b')).toBe(true);
    expect(avatarUrl('Alex', '5f4f2a4b-1c2d-3e4f-9a8b-7c6d5e4f3a2b')).toContain('/avatar/Alex/');
  });
});
