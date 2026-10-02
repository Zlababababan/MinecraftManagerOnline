/**
 * Les pièges de `server.properties` : chaque avertissement apparaît quand on tombe dans le piège,
 * et seulement là — ni sur un réglage qu'on n'a pas touché, ni quand le remède est déjà en place.
 */
import { describe, expect, it } from 'vitest';

import { propertyWarnings } from './properties-warnings.js';

const base = {
  'server-port': '25565',
  'query.port': '25565',
  'online-mode': 'true',
  'server-ip': '',
  'level-name': 'world',
  'level-seed': '',
  gamemode: 'survival',
  'force-gamemode': 'false',
};
const others = new Map([[25570, 'Créatif']]);
/** Les identifiants des avertissements pour un jeu de modifications. */
const ids = (patch: Record<string, string>, original: Record<string, string> = base): string[] =>
  propertyWarnings(original, { ...original, ...patch }, patch, { otherPorts: others }).map(
    (w) => w.id,
  );

describe('avertissements de configuration', () => {
  it('rien sans modification, ni pour une modification sans piège', () => {
    expect(ids({})).toEqual([]);
    expect(ids({ motd: 'Bonjour' })).toEqual([]);
    expect(ids({ 'server-port': '25580' })).toEqual([]);
  });

  it('query.port seul prévient ; avec server-port, non', () => {
    expect(ids({ 'query.port': '25571' })).toEqual(['queryPortOnly']);
    expect(ids({ 'query.port': '25571', 'server-port': '25571' })).toEqual([]);
  });

  it('port déjà pris par un autre serveur de la machine : nommé', () => {
    const [w] = propertyWarnings(
      base,
      { ...base, 'server-port': '25570' },
      { 'server-port': '25570' },
      {
        otherPorts: others,
      },
    );
    expect(w).toEqual({ id: 'portTaken', params: { port: '25570', name: 'Créatif' } });
  });

  it('mode en ligne : prévient quand on le coupe, pas quand on le remet', () => {
    expect(ids({ 'online-mode': 'false' })).toEqual(['onlineModeOff']);
    expect(ids({ 'online-mode': 'true' }, { ...base, 'online-mode': 'false' })).toEqual([]);
  });

  it('adresse d’écoute : prévient quand on la renseigne, pas quand on la vide', () => {
    expect(ids({ 'server-ip': '192.168.1.10' })).toEqual(['serverIp']);
    expect(ids({ 'server-ip': '' }, { ...base, 'server-ip': '10.0.0.1' })).toEqual([]);
  });

  it('nom du monde : prévient s’il existait déjà un monde, pas sur un fichier neuf', () => {
    expect(ids({ 'level-name': 'monde2' })).toEqual(['levelName']);
    expect(ids({ 'level-name': 'monde2' }, {})).toEqual([]);
  });

  it('graine : prévient toujours (elle ne change jamais un monde existant)', () => {
    expect(ids({ 'level-seed': '1234' })).toEqual(['levelSeed']);
  });

  it('mode de jeu : prévient et mène à « forcer », sauf si « forcer » est déjà activé', () => {
    const [w] = propertyWarnings(
      base,
      { ...base, gamemode: 'creative' },
      { gamemode: 'creative' },
      {
        otherPorts: others,
      },
    );
    expect(w).toEqual({ id: 'gamemode', focus: 'force-gamemode' });
    expect(ids({ gamemode: 'creative' }, { ...base, 'force-gamemode': 'true' })).toEqual([]);
    expect(ids({ gamemode: 'creative', 'force-gamemode': 'true' })).toEqual([]);
  });
});
