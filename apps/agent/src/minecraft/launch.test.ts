import { describe, expect, it } from 'vitest';

import { ProtocolError } from '@mmo/protocol';

import { buildLaunchCommand, log4ShellMitigation } from './launch.js';
import { LOG4J2_112_116_FILENAME } from './log4j2-config.js';

const base = {
  serverDir: '/srv/x',
  os: 'linux' as const,
  javaPath: '/usr/bin/java',
  javaMajor: 17,
  maxRamMb: 4096,
};

describe('matrice de lancement (doc 06 §1)', () => {
  it('vanilla, Fabric, Forge ancien : -jar <jar> nogui, cwd = dossier, jamais de shell', () => {
    const cmd = buildLaunchCommand({
      ...base,
      launch: { kind: 'jar', jar: 'server.jar' },
      mcVersion: '1.20.1',
      minRamMb: 2048,
    });
    expect(cmd.file).toBe('/usr/bin/java');
    expect(cmd.cwd).toBe('/srv/x');
    expect(cmd.args).toEqual([
      '-Xms2048M',
      '-Xmx4096M',
      '-Dfile.encoding=UTF-8',
      '-XX:+ExitOnOutOfMemoryError',
      '-Djava.awt.headless=true',
      '-Dlog4j.skipJansi=true',
      '-jar',
      'server.jar',
      'nogui',
    ]);
    expect(cmd.cmdlineKey).toBe('server.jar');
    expect(cmd.files).toEqual([]);
  });

  it('Velocity : jamais de `nogui` (argument inconnu du proxy, qui refuserait de démarrer)', () => {
    const cmd = buildLaunchCommand({
      ...base,
      launch: { kind: 'jar', jar: 'velocity-3.4.0.jar' },
      loader: 'velocity',
    });
    expect(cmd.args.at(-1)).toBe('velocity-3.4.0.jar');
    expect(cmd.args).not.toContain('nogui');
    // mcVersion inconnue : la propriété no_lookups est injectée (inoffensive), rien d'autre.
    expect(cmd.args).toContain('-Dlog4j2.formatMsgNoLookups=true');
  });

  it('Forge/NeoForge modernes : @argfile selon l’OS, jvmArgs après les flags injectés', () => {
    const launch = {
      kind: 'argfile' as const,
      argfileDir: 'libraries/net/neoforged/neoforge/21.1.219',
      hasWinArgs: true,
      hasUnixArgs: true,
    };
    const win = buildLaunchCommand({
      ...base,
      os: 'windows',
      javaMajor: 21,
      launch,
      mcVersion: '1.21.1',
      jvmArgs: ['-XX:+UseG1GC'],
    });
    expect(win.args).toContain('@libraries/net/neoforged/neoforge/21.1.219/win_args.txt');
    expect(win.args).toContain('-Dstdout.encoding=UTF-8');
    expect(win.args.indexOf('-XX:+UseG1GC')).toBeGreaterThan(
      win.args.indexOf('-Dlog4j.skipJansi=true'),
    );
    expect(win.args.at(-1)).toBe('nogui');
    expect(win.args).not.toContain('-Dlog4j2.formatMsgNoLookups=true');
    const unix = buildLaunchCommand({ ...base, launch, mcVersion: '1.21.1' });
    expect(unix.args).toContain('@libraries/net/neoforged/neoforge/21.1.219/unix_args.txt');
  });

  it('argfile de l’OS absent → E_NOT_FOUND typé (migration inter-OS)', () => {
    expect(() =>
      buildLaunchCommand({
        ...base,
        os: 'windows',
        launch: {
          kind: 'argfile',
          argfileDir: 'libraries/x',
          hasWinArgs: false,
          hasUnixArgs: true,
        },
      }),
    ).toThrow(ProtocolError);
  });

  it('Log4Shell : fichier de configuration 1.12–1.16.5, propriété 1.17–1.18.0, rien ensuite', () => {
    expect(log4ShellMitigation('1.12.2')).toBe('config_file');
    expect(log4ShellMitigation('1.16.5')).toBe('config_file');
    expect(log4ShellMitigation('1.17.1')).toBe('no_lookups');
    expect(log4ShellMitigation('1.18')).toBe('no_lookups');
    expect(log4ShellMitigation('1.18.1')).toBe('none');
    expect(log4ShellMitigation('1.21.1')).toBe('none');
    expect(log4ShellMitigation(undefined)).toBe('no_lookups');
    const legacy = buildLaunchCommand({
      ...base,
      javaMajor: 8,
      launch: { kind: 'jar', jar: 'forge-1.12.2-14.23.5.2860.jar' },
      mcVersion: '1.12.2',
    });
    expect(legacy.args).toContain(`-Dlog4j.configurationFile=${LOG4J2_112_116_FILENAME}`);
    expect(legacy.files.map((f) => f.name)).toEqual([LOG4J2_112_116_FILENAME]);
    expect(legacy.files[0]!.content).toContain('%msg{nolookups}');
  });
});
