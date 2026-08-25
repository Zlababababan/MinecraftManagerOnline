import { describe, expect, it } from 'vitest';

import { coerceOrigin, normalizeOrigin } from './origin.js';

describe('normalizeOrigin', () => {
  it('accepte une origine stricte et retire le slash final', () => {
    expect(normalizeOrigin('https://panel.example/')).toBe('https://panel.example');
    expect(normalizeOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('refuse sans schéma, avec chemin ou identifiants', () => {
    expect(normalizeOrigin('panel.example')).toBeUndefined();
    expect(normalizeOrigin('https://panel.example/chemin')).toBeUndefined();
    expect(normalizeOrigin('https://user@panel.example')).toBeUndefined();
  });
});

describe('coerceOrigin (tolérance de saisie)', () => {
  it('ajoute https:// quand le schéma manque', () => {
    expect(coerceOrigin('desktop-abc.tail1234.ts.net')).toBe('https://desktop-abc.tail1234.ts.net');
    expect(coerceOrigin('  panel.example:8443/ ')).toBe('https://panel.example:8443');
  });

  it('conserve un schéma explicite', () => {
    expect(coerceOrigin('http://192.168.1.10:3000')).toBe('http://192.168.1.10:3000');
    expect(coerceOrigin('https://panel.example')).toBe('https://panel.example');
  });

  it('refuse toujours ce qui n’est pas une origine', () => {
    expect(coerceOrigin('ftp://panel.example')).toBeUndefined();
    expect(coerceOrigin('panel.example/chemin')).toBeUndefined();
    expect(coerceOrigin('deux mots')).toBeUndefined();
    expect(coerceOrigin('')).toBeUndefined();
    expect(coerceOrigin(undefined)).toBeUndefined();
  });
});
