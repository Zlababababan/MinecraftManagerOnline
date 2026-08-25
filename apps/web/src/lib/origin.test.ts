import { describe, expect, it } from 'vitest';

import { coerceOriginInput, isValidOriginInput } from './origin.js';

describe('coerceOriginInput', () => {
  it('ajoute https:// quand le schéma manque', () => {
    expect(coerceOriginInput('desktop-abc.tail1234.ts.net')).toBe(
      'https://desktop-abc.tail1234.ts.net',
    );
    expect(coerceOriginInput('  panel.example:8443/ ')).toBe('https://panel.example:8443');
  });

  it('conserve un schéma explicite et retire le slash final', () => {
    expect(coerceOriginInput('http://192.168.1.10:3000/')).toBe('http://192.168.1.10:3000');
  });

  it('laisse la valeur vide vide', () => {
    expect(coerceOriginInput('   ')).toBe('');
  });
});

describe('isValidOriginInput', () => {
  it('accepte vide, hôte nu et origine complète', () => {
    expect(isValidOriginInput('')).toBe(true);
    expect(isValidOriginInput('panel.example')).toBe(true);
    expect(isValidOriginInput('https://panel.example:8443')).toBe(true);
  });

  it('refuse chemin, espaces et autres schémas', () => {
    expect(isValidOriginInput('panel.example/chemin')).toBe(false);
    expect(isValidOriginInput('deux mots')).toBe(false);
    expect(isValidOriginInput('ftp://panel.example')).toBe(false);
  });
});
