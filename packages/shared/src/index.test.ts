import { describe, expect, it } from 'vitest';

import { isLocale, LOCALES, PROJECT_NAME } from './index.js';

describe('@mmo/shared', () => {
  it('expose le nom du projet', () => {
    expect(PROJECT_NAME).toBe('MinecraftManagerOnline');
  });

  it('reconnaît les langues supportées', () => {
    expect(LOCALES).toEqual(['fr', 'en']);
    expect(isLocale('fr')).toBe(true);
    expect(isLocale('de')).toBe(false);
  });
});
