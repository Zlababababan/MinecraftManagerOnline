/**
 * Préférences d'affichage d'une liste. Ce qui mérite d'être prouvé n'est pas « ça écrit puis ça
 * relit », c'est le comportement quand le stockage ment : valeur inconnue, JSON cassé, tri
 * disparu du code, stockage qui refuse — dans tous les cas la liste doit s'afficher.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isListMode, readListPrefs, writeListPrefs, type ListPrefs } from './list-view.js';

const fallback: ListPrefs = { mode: 'table', sort: 'name', desc: false };
const isSort = (value: unknown): boolean => value === 'name' || value === 'state';

describe('préférences de liste', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('rend le défaut quand rien n’est mémorisé, et relit ce qu’elle a écrit', () => {
    expect(readListPrefs('servers', fallback, isSort)).toEqual(fallback);
    writeListPrefs('servers', { mode: 'cards', sort: 'state', desc: true });
    expect(readListPrefs('servers', fallback, isSort)).toEqual({
      mode: 'cards',
      sort: 'state',
      desc: true,
    });
    // La clé est préfixée : deux listes ne se marchent pas dessus.
    expect(readListPrefs('machines', fallback, isSort)).toEqual(fallback);
  });

  it('ne retient pas un champ illisible, sans emporter les autres', () => {
    localStorage.setItem(
      'mmo-list-servers',
      JSON.stringify({ mode: 'mosaïque', sort: 'state', desc: 'oui' }),
    );
    expect(readListPrefs('servers', fallback, isSort)).toEqual({
      mode: 'table',
      sort: 'state',
      desc: false,
    });
  });

  it('un tri disparu du code retombe sur le défaut', () => {
    // Trier sur une colonne qui n'existe plus ne trierait sur rien : c'est le validateur de la
    // page qui tranche, pas le stockage.
    localStorage.setItem('mmo-list-servers', JSON.stringify({ sort: 'tps' }));
    expect(readListPrefs('servers', fallback, isSort).sort).toBe('name');
  });

  it('JSON cassé ou valeur qui n’est pas un objet : défaut', () => {
    localStorage.setItem('mmo-list-servers', '{pas du json');
    expect(readListPrefs('servers', fallback, isSort)).toEqual(fallback);
    localStorage.setItem('mmo-list-servers', '"cards"');
    expect(readListPrefs('servers', fallback, isSort)).toEqual(fallback);
    localStorage.setItem('mmo-list-servers', 'null');
    expect(readListPrefs('servers', fallback, isSort)).toEqual(fallback);
  });

  it('un stockage qui refuse ne casse rien (fenêtre privée, cookies bloqués)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('access denied');
      },
      setItem: () => {
        throw new Error('access denied');
      },
    });
    expect(readListPrefs('servers', fallback, isSort)).toEqual(fallback);
    expect(() => {
      writeListPrefs('servers', { mode: 'cards', sort: 'name', desc: false });
    }).not.toThrow();
  });

  it('isListMode ne reconnaît que les modes du code', () => {
    expect(isListMode('cards')).toBe(true);
    expect(isListMode('table')).toBe(true);
    expect(isListMode('grid')).toBe(false);
    expect(isListMode(undefined)).toBe(false);
  });
});
