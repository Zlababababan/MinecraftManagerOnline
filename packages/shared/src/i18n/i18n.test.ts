import { ERROR_CODES } from '@mmo/protocol';
import { describe, expect, it } from 'vitest';

import {
  createI18n,
  resolveLocale,
  resources,
  translateError,
  translateEvidence,
} from './index.js';

function leaves(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'string'
      ? [`${prefix}${k}`]
      : leaves(v as Record<string, unknown>, `${prefix}${k}.`),
  );
}

describe('i18n', () => {
  it('fr et en ont exactement les mêmes clés (aucune feuille vide)', () => {
    const enKeys = leaves(resources.en).sort();
    const frKeys = leaves(resources.fr).sort();
    expect(frKeys).toEqual(enKeys);
    for (const locale of ['fr', 'en'] as const) {
      const i18n = createI18n(locale);
      for (const key of enKeys) {
        const [ns, ...rest] = key.split('.');
        const value = i18n.t(`${ns ?? ''}:${rest.join('.')}`);
        expect(value, `${locale} ${key}`).not.toBe('');
      }
    }
  });

  it('chaque code d’erreur du protocole est traduit en fr et en en', () => {
    for (const code of ERROR_CODES) {
      expect(resources.fr.errors).toHaveProperty(code);
      expect(resources.en.errors).toHaveProperty(code);
    }
  });

  it('traduit une erreur avec ses détails, et un code inconnu vers E_INTERNAL', () => {
    const fr = createI18n('fr');
    expect(translateError(fr, { code: 'E_PORT_IN_USE', details: { port: 25565 } })).toBe(
      'Le port 25565 est déjà utilisé.',
    );
    expect(translateError(fr, { code: 'E_FUTURE_CODE' })).toBe(fr.t('errors:E_INTERNAL'));
    const en = createI18n('en');
    expect(
      translateError(en, { code: 'E_RAM_GUARD', details: { needMb: 8192, freeMb: 2048 } }),
    ).toBe('Not enough free memory: 8192 MB needed, 2048 MB available.');
  });

  it('traduit un indice de détection, et retombe sur le détail brut pour un code inconnu', () => {
    const en = createI18n('en');
    expect(translateEvidence(en, { code: 'neoforge_libraries', detail: '21.1.219' })).toBe(
      'NeoForge libraries found (21.1.219)',
    );
    expect(translateEvidence(en, { code: 'something_new', detail: 'raw' })).toBe('raw');
  });

  it('résout une langue navigateur vers une locale supportée', () => {
    expect(resolveLocale('fr-FR')).toBe('fr');
    expect(resolveLocale('en_US')).toBe('en');
    expect(resolveLocale('de')).toBe('fr');
    expect(resolveLocale(undefined, 'en')).toBe('en');
  });

  it('les instances sont indépendantes (langue par destinataire)', () => {
    const fr = createI18n('fr');
    const en = createI18n('en');
    expect(fr.t('common:runState.running')).toBe('En marche');
    expect(en.t('common:runState.running')).toBe('Running');
  });
});
