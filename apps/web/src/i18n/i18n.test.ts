import { describe, expect, it } from 'vitest';

import { i18n, initialLocale, tDynamic, webResources } from './index.js';

function leaves(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'string'
      ? [`${prefix}${k}`]
      : leaves(v as Record<string, unknown>, `${prefix}${k}.`),
  );
}

describe('i18n web', () => {
  it('fr et en (espace `web`) ont exactement les mêmes clés, aucune vide', () => {
    const en = leaves(webResources.en.web).sort();
    const fr = leaves(webResources.fr.web).sort();
    expect(fr).toEqual(en);
    expect(en.length).toBeGreaterThan(100);
    for (const key of en) {
      expect(i18n.t(key as never, { lng: 'fr', ns: 'web' }), `fr ${key}`).not.toBe('');
      expect(i18n.t(key as never, { lng: 'en', ns: 'web' }), `en ${key}`).not.toBe('');
    }
  });

  it('les espaces partagés (common/errors/detection) sont disponibles', () => {
    expect(i18n.t('common:runState.running', { lng: 'fr' })).toBe('En marche');
    expect(i18n.t('errors:E_AGENT_OFFLINE', { lng: 'en' })).toContain('agent');
  });

  it('initialLocale : préférence locale > navigateur > fr', () => {
    const storage = (value: string | null) => ({ getItem: () => value });
    expect(initialLocale(storage('en'), 'fr-FR')).toBe('en');
    expect(initialLocale(storage('de'), 'en-US')).toBe('en');
    expect(initialLocale(storage(null), 'de-DE')).toBe('en');
    expect(initialLocale(storage(null), '')).toBe('en');
  });

  it('tDynamic traduit une clé dynamique avec interpolation', () => {
    expect(tDynamic(i18n, 'web:events.types.player.joined', { name: 'Alice', lng: 'en' })).toBe(
      'Player joined: Alice',
    );
  });
});
