import { describe, expect, it } from 'vitest';

import { webResources } from '../i18n/index.js';
import {
  PROPERTY_BY_KEY,
  PROPERTY_SPECS,
  diffProperties,
  groupProperties,
  normalizeValue,
  propertyI18nKey,
  validateValue,
} from './properties-catalog.js';

describe('catalogue server.properties', () => {
  it('chaque clé connue a un libellé et une aide en fr et en en', () => {
    for (const spec of PROPERTY_SPECS) {
      const k = propertyI18nKey(spec.key) as keyof typeof webResources.en.web.properties.keys;
      for (const lang of ['fr', 'en'] as const) {
        const entry = webResources[lang].web.properties.keys[k];
        expect(entry, `${lang} ${spec.key}`).toBeDefined();
        expect(entry.label).not.toBe('');
        expect(entry.help).not.toBe('');
      }
    }
    // Pas de doublon de clé.
    expect(new Set(PROPERTY_SPECS.map((s) => s.key)).size).toBe(PROPERTY_SPECS.length);
    expect(PROPERTY_BY_KEY.get('rcon.port')?.managed).toBe(true);
  });

  it('valide les valeurs selon le type', () => {
    const port = PROPERTY_BY_KEY.get('server-port')!;
    expect(validateValue(port, '25565')).toBeUndefined();
    expect(validateValue(port, 'abc')).toBe('integer');
    expect(validateValue(port, '0')).toBe('min');
    expect(validateValue(port, '70000')).toBe('max');
    const mode = PROPERTY_BY_KEY.get('gamemode')!;
    expect(validateValue(mode, 'creative')).toBeUndefined();
    expect(validateValue(mode, 'god')).toBe('enum');
    expect(normalizeValue(PROPERTY_BY_KEY.get('pvp'), 'TRUE')).toBe('true');
    expect(normalizeValue(PROPERTY_BY_KEY.get('max-players'), '020')).toBe('20');
    expect(normalizeValue(undefined, ' x ')).toBe(' x ');
  });

  it('diffProperties : patch minimal, null pour les clés supprimées, valeurs équivalentes ignorées', () => {
    const original = { motd: 'A', pvp: 'true', 'max-players': '20', 'mod-key': 'x' };
    expect(
      diffProperties(original, { motd: 'B', pvp: 'TRUE', 'max-players': '020', 'new-key': 'y' }),
    ).toEqual({ motd: 'B', 'new-key': 'y', 'mod-key': null });
    expect(diffProperties(original, original)).toEqual({});
  });

  it('groupProperties : catégories ordonnées + clés inconnues triées', () => {
    const { categories, unknown } = groupProperties({
      motd: 'A',
      'zeta-mod': '1',
      'alpha-mod': '2',
      'rcon.port': '25575',
    });
    expect(categories.map((c) => c.category)).toEqual([
      'general',
      'players',
      'world',
      'network',
      'performance',
      'rcon',
      'advanced',
    ]);
    expect(categories[0]?.specs.some((s) => s.key === 'motd')).toBe(true);
    expect(unknown).toEqual(['alpha-mod', 'zeta-mod']);
  });
});
