import { describe, expect, it } from 'vitest';

import { localTimeZone } from '@mmo/shared';

import { timeZoneNotice } from './schedule-timezone.js';

const summer = Date.UTC(2026, 6, 1, 12, 0);

describe('avertissement de fuseau', () => {
  it('ne dit rien quand le fuseau du panel est inconnu', () => {
    expect(timeZoneNotice(undefined, summer)).toBeUndefined();
    expect(timeZoneNotice('', summer)).toBeUndefined();
  });

  it('décrit le fuseau du panel avec son décalage du moment', () => {
    expect(timeZoneNotice('Europe/Paris', summer)?.label).toBe('Europe/Paris (+02:00)');
    expect(timeZoneNotice('Europe/Paris', Date.UTC(2026, 0, 1))?.label).toBe(
      'Europe/Paris (+01:00)',
    );
  });

  it('compare sur l’heure affichée, pas sur le nom du fuseau', () => {
    // Deux noms différents, même heure à l'écran : rien à signaler à l'utilisateur.
    expect(timeZoneNotice('Europe/Madrid', summer)?.matchesBrowser).toBe(
      timeZoneNotice('Europe/Paris', summer)?.matchesBrowser,
    );
    expect(timeZoneNotice(localTimeZone(), summer)?.matchesBrowser).toBe(true);
  });
});
