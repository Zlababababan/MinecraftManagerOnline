import { describe, expect, it } from 'vitest';

import { configChanges, diffKeyValues, parseKeyValues, textChanges } from './config-diff.js';

describe('config-diff : ce que l’audit retient d’une modification', () => {
  it('parseKeyValues ignore commentaires et lignes vides, garde les « = » de la valeur', () => {
    expect(parseKeyValues('#Minecraft\n\nserver-port=25565\r\nmotd=a=b\n! note\nsans-egal\n')).toEqual(
      { 'server-port': '25565', motd: 'a=b' },
    );
  });

  it('diffKeyValues : clé changée, ajoutée, retirée ; une clé identique est tue', () => {
    expect(diffKeyValues({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' })).toEqual({
      b: { from: '2', to: '9' },
      c: { from: '3', to: null },
      d: { from: null, to: '4' },
    });
  });

  it('un secret est masqué des deux côtés, mais son changement reste visible', () => {
    expect(diffKeyValues({ 'rcon.password': 'x' }, { 'rcon.password': 'y' })).toEqual({
      'rcon.password': { from: '•••', to: '•••' },
    });
  });

  it('configChanges : un patch ne rapporte que ses clés réellement modifiées', () => {
    expect(
      configChanges({ 'server-port': '25565', pvp: 'true' }, { 'server-port': '25565', pvp: null }),
    ).toEqual({ keys: { pvp: { from: 'true', to: null } } });
  });

  it('configChanges : une liste JSON donne les noms ajoutés et retirés', () => {
    expect(configChanges([{ name: 'Bob' }, { name: 'Al' }], [{ name: 'Al' }, { name: 'Eve' }])).toEqual(
      { added: ['Eve'], removed: ['Bob'] },
    );
  });

  it('textChanges : fichier créé, fichier clé=valeur, texte libre', () => {
    expect(textChanges('notes.txt', undefined, 'a')).toEqual({ created: true });
    expect(textChanges('config/x.properties', 'a=1\n', 'a=2\n')).toEqual({
      keys: { a: { from: '1', to: '2' } },
    });
    expect(textChanges('eula.txt', 'eula=true', 'eula=false')).toEqual({
      keys: { eula: { from: 'true', to: 'false' } },
    });
    expect(textChanges('ops.txt', 'a\nb\nc', 'a\nc\nd\ne')).toEqual({
      linesAdded: 2,
      linesRemoved: 1,
    });
  });
});
