/**
 * Complétion et aperçu de la console. Le point de bascule de cette version : le modèle vient du
 * serveur quand il a répondu, et d'une table locale sinon — mais les DEUX passent par la même
 * représentation en tokens, donc un seul moteur. C'est ce qui permet de compléter au 3ᵉ mot, ce
 * dont la table plate d'avant était incapable.
 */
import { describe, expect, it } from 'vitest';

import { specsFromUsageLines } from '@mmo/shared';

import {
  CommandHistory,
  complete,
  recentVerbs,
  signature,
  tokenize,
  type Suggestion,
} from './commands.js';

/** Ce qui serait réellement écrit dans le champ. */
const inserts = (list: Suggestion[]) => list.map((s) => s.insert);

describe('complétion console', () => {
  it('complète les commandes par préfixe, avec ou sans slash', () => {
    expect(inserts(complete('sa'))).toEqual(['save-all', 'save-off', 'save-on', 'say']);
    expect(inserts(complete('/wh'))).toEqual(['/whitelist']);
    expect(complete('zzz')).toEqual([]);
    // Le libellé affiché reste le mot seul : la liste ne doit pas répéter la ligne entière.
    expect(complete('/wh')[0]?.label).toBe('whitelist');
  });

  it('ajoute les commandes du loader', () => {
    expect(inserts(complete('fo', { loader: 'forge' }))).toEqual(['forceload', 'forge']);
    expect(inserts(complete('fo', { loader: 'vanilla' }))).toEqual(['forceload']);
  });

  it('propose les valeurs de la position courante, et les joueurs là où c’est attendu', () => {
    expect(inserts(complete('whitelist a'))).toEqual(['whitelist add']);
    expect(inserts(complete('kick Al', { players: ['Alice', 'Bob'] }))).toEqual(['kick Alice']);
    expect(inserts(complete('gamemode c', { players: ['Charlie'] }))).toEqual([
      'gamemode creative',
    ]);
    // `say <message...>` n'attend rien de complétable : ne rien proposer plutôt que du bruit.
    expect(complete('say hello')).toEqual([]);
  });

  it('n’injecte plus les pseudos à toutes les positions', () => {
    // Avant, tout mot d'une commande « qui prend un joueur » se voyait proposer des pseudos.
    // `gamemode` attend d'abord un mode : proposer un joueur ici induisait en erreur.
    // (« creative » sort bien, la casse n'entre pas en ligne de compte — mais pas « Charlie ».)
    expect(inserts(complete('gamemode C', { players: ['Charlie'] }))).toEqual([
      'gamemode creative',
    ]);
    // Au mot suivant, en revanche, la cible est bien attendue.
    expect(inserts(complete('gamemode creative C', { players: ['Charlie'] }))).toEqual([
      'gamemode creative Charlie',
    ]);
  });

  it('complète au-delà du deuxième mot', () => {
    // Le défaut de l'ancienne table : « set day » était une chaîne, jamais recomplétée.
    expect(inserts(complete('time set d'))).toEqual(['time set day']);
  });

  it('le serveur fait autorité dès qu’il a répondu', () => {
    const discovered = specsFromUsageLines(['ftbchunks admin (unclaim-all|reload)']);
    // Une commande de mod, absente de toute table écrite à la main.
    expect(inserts(complete('ftb', { discovered }))).toEqual(['ftbchunks']);
    expect(inserts(complete('ftbchunks admin u', { discovered }))).toEqual([
      'ftbchunks admin unclaim-all',
    ]);
    // Et le catalogue local ne vient plus polluer : `say` n'existe pas sur ce serveur-là.
    expect(complete('say', { discovered })).toEqual([]);
  });

  it('remonte ce que l’utilisateur tape souvent, sans jamais devancer le préfixe', () => {
    const history = recentVerbs(['/list', 'say bonjour', 'save-all']);
    expect(inserts(complete('sa', { history }))).toEqual([
      'save-all',
      'say',
      'save-off',
      'save-on',
    ]);
    // Le classement ne joue qu'à préfixe égal : `stop` ne peut pas remonter sur « sa ».
    expect(inserts(complete('sa', { history }))).not.toContain('stop');
  });

  it('découpe en respectant les guillemets', () => {
    expect(tokenize('say "bonjour tout le monde"')).toEqual({
      words: ['say', '"bonjour tout le monde"'],
      trailingSpace: false,
    });
    expect(tokenize('whitelist add ')).toEqual({
      words: ['whitelist', 'add'],
      trailingSpace: true,
    });
  });
});

describe('aperçu des options', () => {
  it('montre les formes compatibles avec ce qui est tapé', () => {
    const view = signature('whitelist ');
    expect(view?.name).toBe('whitelist');
    expect(view?.usages).toEqual(['(on|off|list|reload)', '(add|remove) <targets>']);
    // Une fois `add` tapé, la forme sans argument ne s'applique plus.
    expect(signature('whitelist add ')?.usages).toEqual(['(add|remove) <targets>']);
  });

  it('dit ce que la position courante attend', () => {
    expect(signature('whitelist add ')?.expects).toBe('targets');
    expect(signature('give Alice ')?.expects).toBe('item');
    // Position sans argument attendu : rien à expliquer, on se tait.
    expect(signature('whitelist on ')?.expects).toBeUndefined();
  });

  it('se tait tant que la commande n’est pas identifiée', () => {
    expect(signature('')).toBeUndefined();
    expect(signature('whit')).toBeUndefined();
    expect(signature('nimportequoi ')).toBeUndefined();
  });

  it('avoue quand l’arbre n’est pas déplié', () => {
    // `execute ...` : Brigadier a replié le sous-arbre, l'aperçu ne peut pas être complet.
    expect(signature('execute ')?.partial).toBe(true);
    expect(signature('whitelist ')?.partial).toBe(false);
  });

  it('borne le nombre de formes affichées', () => {
    const discovered = specsFromUsageLines(['many a', 'many b', 'many c', 'many d', 'many e']);
    const view = signature('many ', { discovered }, 3);
    expect(view?.usages).toHaveLength(3);
    expect(view?.more).toBe(2);
  });
});

describe('verbes récents', () => {
  it('ne garde que le verbe, jamais la ligne entière', () => {
    // La ligne contient des pseudos de joueurs qui n'ont plus rien à faire là.
    expect(recentVerbs(['/kick Alice spam', 'say bonjour', 'kick Bob'])).toEqual(['kick', 'say']);
    expect(recentVerbs([])).toEqual([]);
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
