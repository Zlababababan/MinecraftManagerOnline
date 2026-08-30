/**
 * Recherche de la palette. Le piège à éviter est l'inverse de l'intuition : sur un parc où les
 * noms se ressemblent (ATM10, ATM10Aero…), c'est la PRÉCISION du classement qui compte, pas la
 * tolérance — une palette qui propose le mauvais serveur en premier fait démarrer le mauvais.
 */
import { describe, expect, it } from 'vitest';

import { moveSelection, normalize, searchPalette, type PaletteItem } from './palette.js';

const item = (
  label: string,
  group: PaletteItem['group'] = 'server',
  hint?: string,
): PaletteItem => ({ id: label, label, group, ...(hint === undefined ? {} : { hint }) });

const labels = (list: PaletteItem[]) => list.map((i) => i.label);

describe('searchPalette', () => {
  const items = [
    item('Tableau de bord', 'action'),
    item('ATM10Aero', 'server', 'PC du salon · E:\\MC\\atm10aero'),
    item('ATM10', 'server', 'PC du salon · E:\\MC\\atm10'),
    item('Vanilla 1.20', 'server', 'Raspberry · /srv/vanilla'),
    item('PC du salon', 'machine'),
  ];

  it('classe « commence par » avant « contient »', () => {
    expect(labels(searchPalette(items, 'atm'))).toEqual(['ATM10', 'ATM10Aero']);
  });

  it('cherche aussi dans la deuxième ligne, mais après le libellé', () => {
    // « salon » n'est le libellé que de la machine ; les serveurs ne matchent que par leur indice.
    expect(labels(searchPalette(items, 'salon'))).toEqual(['PC du salon', 'ATM10', 'ATM10Aero']);
  });

  it('trouve par le chemin du dossier', () => {
    expect(labels(searchPalette(items, '/srv/'))).toEqual(['Vanilla 1.20']);
  });

  it('ignore la casse et les accents', () => {
    expect(normalize('Forêt Noire')).toBe('foret noire');
    expect(labels(searchPalette([item('Forêt')], 'foret'))).toEqual(['Forêt']);
    expect(labels(searchPalette([item('foret')], 'Forêt'))).toEqual(['foret']);
  });

  it('sans saisie, propose les actions d’abord', () => {
    expect(searchPalette(items, '')[0]?.group).toBe('action');
    expect(searchPalette(items, '   ')[0]?.group).toBe('action');
  });

  it('ne rend rien quand rien ne correspond, et borne le nombre de résultats', () => {
    expect(searchPalette(items, 'zzz')).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => item(`srv ${String(i)}`));
    expect(searchPalette(many, 'srv')).toHaveLength(12);
    expect(searchPalette(many, 'srv', 3)).toHaveLength(3);
  });
});

describe('moveSelection', () => {
  it('boucle dans les deux sens', () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
  });

  it('ne divise pas par zéro sur une liste vide', () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});
