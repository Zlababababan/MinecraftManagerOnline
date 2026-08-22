import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LogLineClassifier, parseLogLine, parseLogText, stripAnsi } from './parser.js';
import { matchServerLogEvent } from './patterns.js';

const FIXTURES = path.join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'servers');

describe('parseLogLine — formats', () => {
  it('classique vanilla / fabric', () => {
    const p = parseLogLine(
      '[18:27:06] [Server thread/INFO]: Starting minecraft server version 1.20.1',
    );
    expect(p).toMatchObject({
      format: 'classic',
      time: '18:27:06',
      thread: 'Server thread',
      level: 'INFO',
      logger: undefined,
      message: 'Starting minecraft server version 1.20.1',
    });
  });

  it('classique Forge 1.12 avec logger', () => {
    const p = parseLogLine(
      '[20:44:27] [main/WARN] [FML]: The coremod ApotheosisCore (shadows.ApotheosisCore) is not signed!',
    );
    expect(p).toMatchObject({ format: 'classic', level: 'WARN', logger: 'FML', thread: 'main' });
    expect(p?.message).toContain('is not signed!');
  });

  it('moderne Forge/NeoForge, mois anglais et mois localisé français', () => {
    const en = parseLogLine(
      '[06Mar2026 20:45:07.936] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: args [--launchTarget, forgeserver, --fml.mcVersion, 1.21.1, nogui]',
    );
    expect(en).toMatchObject({
      format: 'modern',
      time: '20:45:07',
      date: { year: 2026, month: 3, day: 6 },
      thread: 'main',
      level: 'INFO',
      logger: 'cpw.mods.modlauncher.Launcher/MODLAUNCHER',
    });
    const fr = parseLogLine(
      '[14sept.2023 00:01:57.728] [Server thread/ERROR] [net.minecraft.Util/]: Invalid entity rotation: NaN, discarding.',
    );
    expect(fr).toMatchObject({
      format: 'modern',
      date: { year: 2023, month: 9, day: 14 },
      level: 'ERROR',
      logger: 'net.minecraft.Util/',
      message: 'Invalid entity rotation: NaN, discarding.',
    });
    const janv = parseLogLine(
      '[07janv.2023 04:51:03.419] [Server thread/INFO] [x/]: Done (10.735s)! For help',
    );
    expect(janv?.date).toEqual({ year: 2023, month: 1, day: 7 });
  });

  it('threads avec espaces, `#`, `/` ; niveaux WARNING/SEVERE normalisés', () => {
    expect(
      parseLogLine('[01:00:56] [User Authenticator #1/INFO]: UUID of player X is y')?.thread,
    ).toBe('User Authenticator #1');
    expect(parseLogLine('[01:00:56] [Netty Server IO #3/WARNING]: x')?.level).toBe('WARN');
    expect(parseLogLine('[01:00:56] [main/SEVERE]: x')?.level).toBe('ERROR');
  });

  it('ligne sans en-tête → continuation', () => {
    expect(
      parseLogLine('\tat net.minecraft.server.MinecraftServer.run(MinecraftServer.java:1)'),
    ).toBeUndefined();
    expect(parseLogLine('- achiopt 2.1.0')).toBeUndefined();
    expect(parseLogLine('')).toBeUndefined();
  });
});

describe('rattachement des stacktraces', () => {
  const text = [
    '[12:00:00] [Server thread/INFO]: Preparing level "world"',
    '[12:00:01] [Server thread/ERROR]: Encountered an unexpected exception',
    'java.lang.NullPointerException: boom',
    '\tat net.minecraft.server.MinecraftServer.run(MinecraftServer.java:1)',
    '\tat java.base/java.lang.Thread.run(Thread.java:840)',
    '[12:00:02] [Server thread/INFO]: Stopping server',
    '',
  ].join('\n');

  it('parseLogText regroupe les continuations sous l’entrée précédente, même niveau', () => {
    const entries = parseLogText(text);
    expect(entries).toHaveLength(3);
    expect(entries[1]?.level).toBe('ERROR');
    expect(entries[1]?.continuation).toHaveLength(3);
    expect(entries[2]?.continuation).toEqual([]);
  });

  it('LogLineClassifier (flux) donne le niveau de l’entrée précédente aux continuations', () => {
    const c = new LogLineClassifier();
    const levels = text
      .split('\n')
      .filter(Boolean)
      .map((l) => c.classify(l));
    expect(levels.map((l) => `${l.kind}:${l.level}`)).toEqual([
      'entry:INFO',
      'entry:ERROR',
      'continuation:ERROR',
      'continuation:ERROR',
      'continuation:ERROR',
      'entry:INFO',
    ]);
  });

  it('lignes orphelines avant tout en-tête → entrée INFO synthétique', () => {
    const entries = parseLogText('Picked up JAVA_TOOL_OPTIONS: -Dx\n[12:00:00] [main/INFO]: ok');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      level: 'INFO',
      message: 'Picked up JAVA_TOOL_OPTIONS: -Dx',
    });
  });
});

describe('événements serveur', () => {
  it('Done accepte point et virgule (locale JVM), sans exiger « For help »', () => {
    expect(matchServerLogEvent('Done (5.497s)! For help, type "help"')).toEqual({
      kind: 'done',
      seconds: 5.497,
    });
    expect(matchServerLogEvent('Done (5,309s)!')).toEqual({ kind: 'done', seconds: 5.309 });
    expect(matchServerLogEvent('Done (25.346s)! For help, type "help" or "?"')).toEqual({
      kind: 'done',
      seconds: 25.346,
    });
  });

  it('versions : vanilla, fabric, forge legacy, modlauncher', () => {
    expect(matchServerLogEvent('Starting minecraft server version 1.12.2')).toEqual({
      kind: 'starting',
      mcVersion: '1.12.2',
    });
    expect(matchServerLogEvent('Loading Minecraft 1.21.1 with Fabric Loader 0.17.3')).toEqual({
      kind: 'fabric_loading',
      mcVersion: '1.21.1',
      loaderVersion: '0.17.3',
    });
    expect(
      matchServerLogEvent('Forge Mod Loader version 14.23.5.2860 for Minecraft 1.12.2 loading'),
    ).toEqual({
      kind: 'forge_legacy_loading',
      mcVersion: '1.12.2',
      loaderVersion: '14.23.5.2860',
    });
    expect(
      matchServerLogEvent(
        'ModLauncher running: args [--launchTarget, forgeserver, --fml.neoForgeVersion, 21.1.219, --fml.fmlVersion, 4.0.42, --fml.mcVersion, 1.21.1, nogui]',
      ),
    ).toEqual({
      kind: 'modlauncher',
      mcVersion: '1.21.1',
      forgeVersion: undefined,
      neoForgeVersion: '21.1.219',
    });
  });

  it('joueurs, EULA, surcharge, crash', () => {
    expect(matchServerLogEvent('Player1 joined the game')).toEqual({
      kind: 'player_join',
      name: 'Player1',
    });
    expect(matchServerLogEvent('Player1 left the game')).toEqual({
      kind: 'player_leave',
      name: 'Player1',
    });
    expect(
      matchServerLogEvent('Player1[/[::1]:56887] logged in with entity id 172 at (1.0, 2.0, 3.0)'),
    ).toEqual({
      kind: 'player_login',
      name: 'Player1',
      address: '[::1]:56887',
      entityId: 172,
    });
    expect(
      matchServerLogEvent('UUID of player Player1 is 00000000-0000-4000-8000-000000000001'),
    ).toMatchObject({
      kind: 'player_uuid',
      name: 'Player1',
    });
    expect(
      matchServerLogEvent(
        'You need to agree to the EULA in order to run the server. Go to eula.txt for more info.',
      ),
    ).toEqual({ kind: 'eula_required' });
    expect(
      matchServerLogEvent(
        "Can't keep up! Is the server overloaded? Running 2345ms or 46 ticks behind",
      ),
    ).toEqual({
      kind: 'cant_keep_up',
      behindMs: 2345,
      behindTicks: 46,
    });
    expect(matchServerLogEvent('Exception in server tick loop')).toEqual({
      kind: 'crash_signal',
      code: 'tick_loop_exception',
    });
    expect(matchServerLogEvent('java.lang.OutOfMemoryError: Java heap space')).toEqual({
      kind: 'crash_signal',
      code: 'out_of_memory',
    });
    expect(matchServerLogEvent('**** FAILED TO BIND TO PORT!')).toEqual({ kind: 'bind_failed' });
    expect(matchServerLogEvent('Preparing spawn area: 42%')).toEqual({
      kind: 'preparing_spawn',
      percent: 42,
    });
    expect(matchServerLogEvent('Starting Minecraft server on *:25565')).toEqual({
      kind: 'listening',
      host: '*',
      port: 25565,
    });
    expect(matchServerLogEvent('nothing interesting')).toBeUndefined();
  });

  it('stripAnsi retire les codes couleur', () => {
    expect(stripAnsi('[32mDone[0m (1.0s)!')).toBe('Done (1.0s)!');
  });
});

describe('logs réels (fixtures anonymisées)', () => {
  const logs = readdirSync(FIXTURES)
    .map((d) => ({ name: d, file: path.join(FIXTURES, d, 'logs', 'latest.log') }))
    .filter((f) => existsSync(f.file));

  it('présents', () => {
    expect(logs.length).toBeGreaterThanOrEqual(15);
  });

  it.each(logs.map((l) => [l.name, l.file] as const))(
    '%s : en-têtes reconnus, continuations rattachées',
    (name, file) => {
      const text = readFileSync(file, 'utf8');
      const entries = parseLogText(text);
      expect(entries.length).toBeGreaterThan(2);
      // Aucune ligne commençant par « [HH:mm:ss] [ » ou « [ddMMMyyyy HH:mm:ss] [ » ne doit finir en continuation.
      for (const e of entries) {
        for (const c of e.continuation) {
          expect(c, `${name}: continuation suspecte`).not.toMatch(
            /^\[(\d{2}:\d{2}:\d{2}|\d{2}\S+\d{4} \d{2}:\d{2}:\d{2})\] \[/,
          );
        }
        expect(e.time, `${name}: en-tête sans heure : ${e.raw}`).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      }
    },
  );

  it('la version MC est lisible dans la majorité des logs (les logs tournés à minuit n’ont pas de démarrage)', () => {
    const withVersion = logs.filter(({ file }) =>
      parseLogText(readFileSync(file, 'utf8')).some((e) => {
        const ev = matchServerLogEvent(e.message);
        return (
          ev?.kind === 'starting' ||
          ev?.kind === 'fabric_loading' ||
          ev?.kind === 'forge_legacy_loading' ||
          ev?.kind === 'modlauncher'
        );
      }),
    );
    expect(withVersion.length / logs.length).toBeGreaterThanOrEqual(0.6);
  });
});
