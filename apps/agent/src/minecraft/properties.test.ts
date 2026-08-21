import { describe, expect, it } from 'vitest';

import { escapeValue, parseProperties, updateProperties } from './properties.js';

const SAMPLE = `#Minecraft server properties
#Thu Aug 21 10:00:00 CEST 2026
enable-rcon=false
server-port=25565
motd=A Minecraft Server \\u00e9\\u00e8
level-name=world
custom.mod.key=value:with=signs
`;

describe('server.properties (doc 06 §7)', () => {
  it('parse avec désérialisation des échappements', () => {
    const p = parseProperties(SAMPLE);
    expect(p.get('server-port')).toBe('25565');
    expect(p.get('motd')).toBe('A Minecraft Server éè');
    expect(p.get('custom.mod.key')).toBe('value:with=signs');
    expect(p.has('#Minecraft server properties')).toBe(false);
  });

  it('met à jour en place : ordre, commentaires et clés inconnues conservés, clés absentes ajoutées', () => {
    const out = updateProperties(SAMPLE, {
      'enable-rcon': 'true',
      'rcon.port': '25575',
      'rcon.password': 'p4ss',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('#Minecraft server properties');
    expect(lines[2]).toBe('enable-rcon=true');
    expect(lines[3]).toBe('server-port=25565');
    expect(out).toContain('custom.mod.key=value:with=signs'); // ligne non modifiée : conservée telle quelle
    expect(out.trimEnd().split('\n').slice(-2)).toEqual(['rcon.port=25575', 'rcon.password=p4ss']);
    expect(out.endsWith('\n')).toBe(true);
    expect(parseProperties(out).get('motd')).toBe('A Minecraft Server éè');
  });

  it('écriture sûre universelle : ASCII + \\uXXXX', () => {
    expect(escapeValue('été §a:b=c #d')).toBe('\\u00e9t\\u00e9 \\u00a7a\\:b\\=c \\#d');
    expect(escapeValue(' leading')).toBe('\\ leading');
    const out = updateProperties('', { motd: 'été' });
    expect(out).toBe('motd=\\u00e9t\\u00e9\n');
    expect(parseProperties(out).get('motd')).toBe('été');
  });

  it('supprime une clé avec null et respecte les fins de ligne CRLF', () => {
    const out = updateProperties('a=1\r\nb=2\r\n', { a: null, c: '3' });
    expect(out).toBe('b=2\r\nc=3\r\n');
  });
});
