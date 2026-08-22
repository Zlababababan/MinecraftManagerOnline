import { describe, expect, it } from 'vitest';

import { CommandHistory, complete } from './commands.js';

describe('complétion console (V1)', () => {
  it('complète les commandes par préfixe, avec ou sans slash', () => {
    expect(complete('sa')).toEqual(['save-all', 'save-off', 'save-on', 'say']);
    expect(complete('/wh')).toEqual(['/whitelist']);
    expect(complete('zzz')).toEqual([]);
  });

  it('ajoute les commandes du loader', () => {
    expect(complete('fo', { loader: 'forge' })).toEqual(['forceload', 'forge']);
    expect(complete('fo', { loader: 'vanilla' })).toEqual(['forceload']);
  });

  it('complète les sous-commandes et les joueurs en ligne', () => {
    expect(complete('whitelist a')).toEqual(['whitelist add']);
    expect(complete('kick Al', { players: ['Alice', 'Bob'] })).toEqual(['kick Alice']);
    expect(complete('gamemode c', { players: ['Charlie'] })).toEqual([
      'gamemode Charlie',
      'gamemode creative',
    ]);
    expect(complete('say hello')).toEqual([]);
  });
});

describe('historique de commandes', () => {
  it('navigue ↑/↓ en conservant le brouillon', () => {
    const h = new CommandHistory();
    h.push('list');
    h.push('say a');
    h.push('say a'); // doublon consécutif ignoré
    expect(h.all).toEqual(['list', 'say a']);
    expect(h.up('draft')).toBe('say a');
    expect(h.up('')).toBe('list');
    expect(h.up('')).toBe('list');
    expect(h.down()).toBe('say a');
    expect(h.down()).toBe('draft');
    expect(h.down()).toBeUndefined();
  });

  it('seed place l’historique serveur avant les entrées locales, borné', () => {
    const h = new CommandHistory([], 3);
    h.push('c');
    h.seed(['a', 'b']);
    expect(h.all).toEqual(['a', 'b', 'c']);
    h.push('d');
    expect(h.all).toEqual(['b', 'c', 'd']);
  });
});
