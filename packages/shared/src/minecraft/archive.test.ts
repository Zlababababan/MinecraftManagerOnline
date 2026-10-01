/** Scripts recopiés du zip ATM10 Aero 0.7.1 (mesure du 01/10/2026), réduits aux lignes lues. */
import { describe, expect, it } from 'vitest';

import { readArchiveHints, readArchiveProperties } from './archive.js';

const SH = [
  '#!/bin/sh',
  'set -eu',
  'NEOFORGE_VERSION=21.1.250',
  'INSTALLER="neoforge-$NEOFORGE_VERSION-installer.jar"',
  'if [ ! -e server.properties ]; then',
  '    printf "allow-flight=true\\nmotd=All the Mods 10 Aeronautics\\nmax-tick-time=180000\\nsimulation-distance=4\\nview-distance=7" > server.properties',
  'fi',
].join('\n');

const BAT = [
  '@echo off',
  'set NEOFORGE_VERSION=21.1.250',
  'if not exist "server.properties" (',
  '    (',
  '        echo allow-flight=true',
  '        echo motd=All the Mods 10 Aeronautics',
  '        echo max-tick-time=180000',
  '        echo simulation-distance=4',
  '       \techo view-distance=7',
  '    )> "server.properties"',
  ')',
].join('\r\n');

const ATM = {
  'allow-flight': 'true',
  motd: 'All the Mods 10 Aeronautics',
  'max-tick-time': '180000',
  'simulation-distance': '4',
  'view-distance': '7',
};

describe('archive de serveur — lecture des scripts', () => {
  it('ATM10 : NeoForge et son build, lus dans le .sh comme dans le .bat', () => {
    for (const [name, content] of [
      ['startserver.sh', SH],
      ['startserver.bat', BAT],
    ] as const) {
      expect(
        readArchiveHints([
          { name: 'README.txt', content: 'hello' },
          { name, content },
        ]),
      ).toEqual({
        loader: 'neoforge',
        mcVersion: '1.21.1',
        loaderVersion: '21.1.250',
        source: name,
      });
    }
  });

  it('Forge : version de jeu lue dans la variable, le nom de l’installeur ou le build complet', () => {
    expect(
      readArchiveHints([
        {
          name: 'startserver.sh',
          content: 'FORGE_VERSION=47.3.11\nINSTALLER="forge-1.20.1-$FORGE_VERSION-installer.jar"',
        },
      ]),
    ).toMatchObject({ loader: 'forge', mcVersion: '1.20.1', loaderVersion: '47.3.11' });
    expect(
      readArchiveHints([{ name: 'run.bat', content: 'set FORGE_VERSION=1.19.2-43.4.0' }]),
    ).toMatchObject({ loader: 'forge', mcVersion: '1.19.2', loaderVersion: '43.4.0' });
    expect(
      readArchiveHints([
        { name: 'variables.txt', content: 'MINECRAFT_VERSION=1.18.2\nFORGE_VERSION=40.2.0' },
      ]),
    ).toMatchObject({ loader: 'forge', mcVersion: '1.18.2', loaderVersion: '40.2.0' });
  });

  it('rien de reconnu : undefined, jamais un chargeur deviné', () => {
    expect(readArchiveHints([{ name: 'start.sh', content: 'java -jar server.jar nogui' }])).toBe(
      undefined,
    );
    // Un build Forge sans version de jeu ne suffit pas.
    expect(readArchiveHints([{ name: 'start.sh', content: 'FORGE_VERSION=47.3.11' }])).toBe(
      undefined,
    );
    // NEOFORGE_VERSION n'est pas lu comme FORGE_VERSION.
    expect(readArchiveHints([{ name: 'a.sh', content: 'NEOFORGE_VERSION=abc' }])).toBe(undefined);
  });

  it('server.properties par défaut du script : mêmes cinq lignes en sh et en bat', () => {
    expect(readArchiveProperties([{ name: 'startserver.sh', content: SH }])).toEqual(ATM);
    expect(readArchiveProperties([{ name: 'startserver.bat', content: BAT }])).toEqual(ATM);
    expect(readArchiveProperties([{ name: 'x.sh', content: 'echo hello' }])).toEqual({});
  });

  it('les clés gérées par le panel (port, RCON) ne sont jamais reprises d’un script', () => {
    const content =
      'printf "server-port=1234\\nenable-rcon=true\\nrcon.password=x\\nquery.port=9\\npvp=false" > server.properties';
    expect(readArchiveProperties([{ name: 's.sh', content }])).toEqual({ pvp: 'false' });
  });
});
