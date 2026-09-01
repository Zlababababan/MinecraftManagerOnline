/**
 * Fonctions pures de la duplication : choix du port de jeu du clone (ports connus et plage RCON
 * de l'agent évités, repli sous le port de départ) et nom de dossier dérivé du nom du clone.
 */
import { describe, expect, it } from 'vitest';

import { folderNameForDuplicate, pickGamePort } from './migrations.js';

describe('pickGamePort', () => {
  it('reprend le port préféré quand il est libre (cible = autre machine)', () => {
    expect(pickGamePort(new Set(), 25_565)).toBe(25_565);
  });

  it('avance au port suivant quand la source occupe le port (même machine)', () => {
    expect(pickGamePort(new Set([25_565]), 25_565)).toBe(25_566);
  });

  it('saute les ports connus et toute la plage RCON par défaut de l’agent', () => {
    const used = new Set<number>();
    for (let p = 25_565; p <= 25_574; p += 1) used.add(p);
    // 25575–25675 = plage RCON : jamais proposée comme port de jeu.
    expect(pickGamePort(used, 25_565)).toBe(25_676);
  });

  it('repart sous le port de départ quand le haut de la plage est épuisé', () => {
    const used = new Set<number>();
    for (let p = 65_530; p <= 65_535; p += 1) used.add(p);
    expect(pickGamePort(used, 65_530)).toBe(1024);
  });

  it('défaut 25565 sans préférence', () => {
    expect(pickGamePort(new Set())).toBe(25_565);
  });
});

describe('folderNameForDuplicate', () => {
  it('garde un nom simple tel quel', () => {
    expect(folderNameForDuplicate('Survie (copie)')).toBe('Survie (copie)');
  });

  it('remplace les caractères interdits Windows et compacte les espaces', () => {
    expect(folderNameForDuplicate('ATM10: <Aero>/v2')).toBe('ATM10 Aero v2');
    expect(folderNameForDuplicate('a' + String.fromCharCode(0x5c) + 'b')).toBe('a b');
  });

  it('retire points et espaces finaux (interdits par Windows)', () => {
    expect(folderNameForDuplicate('Copie...  ')).toBe('Copie');
  });

  it('remplace les caractères de contrôle', () => {
    expect(folderNameForDuplicate('a' + String.fromCharCode(9) + 'b')).toBe('a b');
  });

  it('repli quand il ne reste rien d’utilisable', () => {
    expect(folderNameForDuplicate('***')).toBe('server-copy');
  });
});
