/**
 * Filtrage, tri et aller-retour avec l'URL. Avec 53 serveurs, c'est la seule façon de retrouver
 * quoi que ce soit — et un filtre qui ment est pire que pas de filtre.
 */
import { describe, expect, it } from 'vitest';

import type { ServerDto } from '@mmo/protocol/client';

import {
  EMPTY_FILTER,
  filterOptions,
  filterServers,
  filterToSearch,
  searchToFilter,
  type ServerFilter,
} from './server-filter.js';

function srv(over: Partial<ServerDto> = {}): ServerDto {
  return {
    id: over.name ?? 'id',
    machineId: 'm1',
    name: 'Vanilla',
    path: 'E:\\Minecraft\\Server\\vanilla',
    loader: 'vanilla',
    mcVersion: '1.20.1',
    runState: 'stopped',
    startedAt: null,
    maxRamMb: 4096,
    reachable: true,
    groupId: null,
    groupPosition: 0,
    ...over,
  } as ServerDto;
}

const names = (list: ServerDto[]) => list.map((s) => s.name);
const f = (over: Partial<ServerFilter> = {}): ServerFilter => ({ ...EMPTY_FILTER, ...over });

describe('filterServers', () => {
  const fleet = [
    srv({ name: 'ATM10', path: 'E:\\MC\\atm10', loader: 'neoforge', mcVersion: '1.21.1' }),
    srv({ name: 'Vanilla', path: 'E:\\MC\\vanilla', runState: 'running' }),
    srv({ name: 'Fabric test', path: 'D:\\jeux\\fab', loader: 'fabric', machineId: 'm2' }),
  ];

  it('cherche dans le nom ET dans le chemin', () => {
    expect(names(filterServers(fleet, f({ q: 'atm' })))).toEqual(['ATM10']);
    // Le dossier est souvent ce dont on se souvient, pas le nom affiché.
    expect(names(filterServers(fleet, f({ q: 'D:\\jeux' })))).toEqual(['Fabric test']);
    expect(names(filterServers(fleet, f({ q: 'ATM' })))).toEqual(['ATM10']);
    expect(names(filterServers(fleet, f({ q: '  vanilla  ' })))).toEqual(['Vanilla']);
  });

  it('combine les filtres', () => {
    expect(names(filterServers(fleet, f({ machineId: 'm2' })))).toEqual(['Fabric test']);
    expect(names(filterServers(fleet, f({ loader: 'neoforge' })))).toEqual(['ATM10']);
    expect(names(filterServers(fleet, f({ runState: 'running' })))).toEqual(['Vanilla']);
    expect(names(filterServers(fleet, f({ machineId: 'm1', loader: 'fabric' })))).toEqual([]);
  });

  it('trie par nom en ordre naturel, pas alphabétique brut', () => {
    const list = [srv({ name: 'srv 10' }), srv({ name: 'srv 2' }), srv({ name: 'srv 1' })];
    expect(names(filterServers(list, f()))).toEqual(['srv 1', 'srv 2', 'srv 10']);
  });

  it('trie par état en mettant d’abord ce qui demande de l’attention', () => {
    const list = [
      srv({ name: 'arrêté', runState: 'stopped' }),
      srv({ name: 'planté', runState: 'crashed' }),
      srv({ name: 'en marche', runState: 'running' }),
    ];
    expect(names(filterServers(list, f({ sort: 'state' })))).toEqual([
      'planté',
      'en marche',
      'arrêté',
    ]);
  });

  it('trie par dernier démarrage en laissant « jamais démarré » à la fin', () => {
    const list = [
      srv({ name: 'jamais', startedAt: null }),
      srv({ name: 'ancien', startedAt: 1000 }),
      srv({ name: 'récent', startedAt: 9000 }),
    ];
    expect(names(filterServers(list, f({ sort: 'started' })))).toEqual([
      'récent',
      'ancien',
      'jamais',
    ]);
  });

  it('départage à égalité par le nom, pour un ordre stable', () => {
    const list = [srv({ name: 'b' }), srv({ name: 'a' }), srv({ name: 'c' })];
    expect(names(filterServers(list, f({ sort: 'ram' })))).toEqual(['a', 'b', 'c']);
  });

  it('ne propose que des valeurs de filtre réellement présentes', () => {
    const options = filterOptions(fleet);
    expect(options.loaders).toEqual(['fabric', 'neoforge', 'vanilla']);
    // Versions en ordre naturel décroissant : 1.21.1 avant 1.20.1.
    expect(options.mcVersions).toEqual(['1.21.1', '1.20.1']);
    expect(options.runStates).toEqual(['running', 'stopped']);
  });
});

describe('aller-retour avec l’URL', () => {
  it('n’écrit que ce qui s’écarte du défaut', () => {
    expect(filterToSearch(EMPTY_FILTER)).toEqual({});
    expect(filterToSearch(f({ q: '  atm  ', sort: 'state', desc: true }))).toEqual({
      q: 'atm',
      sort: 'state',
      desc: true,
    });
  });

  it('relit ce qu’il a écrit', () => {
    const original = f({
      q: 'atm',
      machineId: 'm2',
      loader: 'fabric',
      runState: 'running',
      sort: 'ram',
    });
    expect(searchToFilter(filterToSearch(original))).toEqual(original);
  });

  // Une URL se bricole à la main : un paramètre inconnu ne doit pas produire un filtre qui ne
  // correspondra jamais à rien, ni faire planter la page.
  it('ignore les valeurs qui ne sont pas du vocabulaire', () => {
    const parsed = searchToFilter({
      loader: 'bedrock',
      state: 'exploded',
      sort: 'tps',
      desc: 'oui',
    });
    expect(parsed.loader).toBeUndefined();
    expect(parsed.runState).toBeUndefined();
    expect(parsed.sort).toBe('name');
    expect(parsed.desc).toBe(false);
  });

  it('accepte les booléens sous leur forme de chaîne (URL)', () => {
    expect(searchToFilter({ desc: 'true' }).desc).toBe(true);
    expect(searchToFilter({ desc: true }).desc).toBe(true);
  });
});
