import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { detectedServerSchema } from '@mmo/protocol';
import { describe, expect, it } from 'vitest';

import { createNodeDetectFs } from '../node/index.js';
import { detectServer, mcVersionFromNeoForge, parseProperties } from './detect.js';
import { MemoryDetectFs, MemoryJar } from './fs.js';
import { scanForServers } from './scan.js';
import { parseVelocityToml } from './velocity.js';

const FIXTURES = path.join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'servers');

interface Expected {
  loader: string;
  mcVersion: string;
  loaderVersion?: string;
  maxRamMb: number;
  minRamMb?: number;
  ramSource?: string;
  gamePort?: number;
  rconPort?: number;
  rconEnabled?: boolean;
  javaMajor?: number;
  javaStrict?: boolean;
  launch?: 'jar' | 'argfile';
  launchJar?: string;
  needsInstall?: boolean;
  eula?: boolean;
}

const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8')) as Record<
  string,
  Expected | null
>;
const fixtureDirs = readdirSync(FIXTURES).filter((d) =>
  statSync(path.join(FIXTURES, d)).isDirectory(),
);
const nodeFs = createNodeDetectFs();

describe('détection sur fixtures réelles (critère phase 2 : ≥ 90 % corrects)', () => {
  it('chaque fixture a une vérité terrain', () => {
    expect(fixtureDirs.filter((d) => !(d in expected))).toEqual([]);
  });

  const results = new Map<string, Awaited<ReturnType<typeof detectServer>>>();

  it.each(fixtureDirs)('%s', async (name) => {
    const exp = expected[name];
    const result = await detectServer(nodeFs, path.join(FIXTURES, name), { os: 'windows' });
    results.set(name, result);
    if (exp === null || exp === undefined) {
      expect(result).toBeUndefined();
      return;
    }
    expect(result, 'dossier non qualifié').toBeDefined();
    if (!result) return;
    // Le résultat est exactement le payload protocole `server.detected`
    const parsed = detectedServerSchema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(result.name).toBe(name);
    expect(result.eulaAccepted).toBe(exp.eula ?? true);
    if (exp.gamePort !== undefined) expect(result.gamePort).toBe(exp.gamePort);
    if (exp.rconPort !== undefined) expect(result.rconPort).toBe(exp.rconPort);
    if (exp.rconEnabled !== undefined) expect(result.rconEnabled).toBe(exp.rconEnabled);
    if (exp.javaMajor !== undefined)
      expect(result.javaRequirement?.majorVersion).toBe(exp.javaMajor);
    if (exp.javaStrict !== undefined) expect(result.javaRequirement?.strict).toBe(exp.javaStrict);
    if (exp.launch !== undefined) expect(result.launch?.kind).toBe(exp.launch);
    if (exp.launchJar !== undefined && result.launch?.kind === 'jar')
      expect(result.launch.jar).toBe(exp.launchJar);
    if (exp.needsInstall !== undefined) expect(result.needsInstall ?? false).toBe(exp.needsInstall);
    if (exp.ramSource !== undefined) expect(result.maxRamMb.source).toBe(exp.ramSource);
    if (exp.minRamMb !== undefined) expect(result.minRamMb?.value).toBe(exp.minRamMb);
  });

  it('loader + version + RAM corrects sur ≥ 90 % des fixtures, le reste en « à configurer »', async () => {
    const scored: { name: string; ok: boolean; detail: string }[] = [];
    for (const name of fixtureDirs) {
      const exp = expected[name];
      if (!exp) continue;
      const result =
        results.get(name) ??
        (await detectServer(nodeFs, path.join(FIXTURES, name), { os: 'windows' }));
      const got = {
        loader: result?.loader.value,
        mcVersion: result?.mcVersion?.value,
        loaderVersion: result?.loaderVersion?.value,
        maxRamMb: result?.maxRamMb.value,
      };
      const ok =
        got.loader === exp.loader &&
        got.mcVersion === exp.mcVersion &&
        got.maxRamMb === exp.maxRamMb &&
        (exp.loaderVersion === undefined || got.loaderVersion === exp.loaderVersion);
      scored.push({ name, ok, detail: `${JSON.stringify(got)} vs ${JSON.stringify(exp)}` });
      // Un échec doit rester « honnête » : jamais un loader faux avec une confiance élevée.
      if (result && got.loader !== exp.loader)
        expect(result.loader.confidence, name).not.toBe('high');
    }
    const failures = scored.filter((s) => !s.ok);
    const ratio = (scored.length - failures.length) / scored.length;
    expect(ratio, failures.map((f) => `${f.name}: ${f.detail}`).join('\n')).toBeGreaterThanOrEqual(
      0.9,
    );
  });
});

describe('détection — cas synthétiques (FS mémoire)', () => {
  const props =
    'server-port=25565\nenable-rcon=true\nrcon.port=25575\nrcon.password=x\nmotd=Hi\nlevel-name=world\n';

  it('Velocity : velocity.toml qualifie un proxy — port bind, Java 17, ni EULA ni RCON ni version MC', async () => {
    const fs = new MemoryDetectFs({
      '/srv/proxy': {
        'velocity.toml': [
          'config-version = "2.7"',
          'bind = "0.0.0.0:25577"',
          'motd = "<#09add3>Réseau"',
          'show-max-players = 500',
        ].join('\n'),
        'forwarding.secret': 'secret',
        'velocity-3.4.0-SNAPSHOT-446.jar': '',
        plugins: {},
      },
    });
    const r = await detectServer(fs, '/srv/proxy');
    expect(r?.loader).toEqual({ value: 'velocity', confidence: 'high', source: 'velocity.toml' });
    expect(r?.loaderVersion?.value).toBe('3.4.0-SNAPSHOT-446');
    expect(r?.mcVersion).toBeUndefined();
    expect(r?.launch).toEqual({ kind: 'jar', jar: 'velocity-3.4.0-SNAPSHOT-446.jar' });
    expect(r?.gamePort).toBe(25577);
    expect(r?.motd).toBe('<#09add3>Réseau');
    // Pas d'EULA Mojang à accepter, pas de RCON à provisionner : rien à reprocher au proxy.
    expect(r?.eulaAccepted).toBe(true);
    expect(r?.rconEnabled).toBe(false);
    expect(r?.javaRequirement).toEqual({ majorVersion: 17, strict: false, source: 'table' });
    expect(r?.confidence).toBe('high');
    // Le résultat reste un payload protocole `server.detected` valide.
    const parsed = detectedServerSchema.safeParse(r);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('parseVelocityToml : bind, motd, et replis honnêtes', () => {
    expect(parseVelocityToml('bind = "0.0.0.0:25577"\nmotd = "Hey"\n')).toEqual({
      port: 25577,
      motd: 'Hey',
    });
    expect(parseVelocityToml('bind = "192.168.1.4:26000"\n')).toEqual({ port: 26000 });
    expect(parseVelocityToml('# bind manquant\n')).toEqual({});
    expect(parseVelocityToml('bind = "0.0.0.0:99999"\n')).toEqual({});
  });

  it('FTB server-setup-config.yaml : loader, versions et RAM quand rien n’est installé', async () => {
    const fs = new MemoryDetectFs({
      '/srv/ftb': {
        'server.properties': props,
        'server-setup-config.yaml': [
          '_specver: 2',
          'modpack:',
          '  name: "Some Pack"',
          'install:',
          '  mcVersion: 1.16.5',
          '  loaderVersion: 36.2.39',
          '  modLoader: forge',
          'launch:',
          '  maxRam: 6G',
          '  javaArgs: "-Xmx6G -Xms2G -XX:+UseG1GC"',
        ].join('\n'),
        mods: {},
      },
    });
    const r = await detectServer(fs, '/srv/ftb');
    expect(r?.loader).toEqual({
      value: 'forge',
      confidence: 'medium',
      source: 'server_setup_config',
    });
    expect(r?.mcVersion?.value).toBe('1.16.5');
    expect(r?.loaderVersion?.value).toBe('36.2.39');
    expect(r?.javaRequirement).toEqual({ majorVersion: 8, strict: true, source: 'table' });
    expect(r?.gamePort).toBe(25565);
    expect(r?.rconEnabled).toBe(true);
    expect(r?.motd).toBe('Hi');
  });

  it('fabric-server-mc.<mc>-loader.<v>-launcher.<i>.jar : versions dans le nom', async () => {
    const fs = new MemoryDetectFs({
      '/srv/fab': {
        'eula.txt': 'eula=true',
        'fabric-server-mc.1.20.4-loader.0.15.6-launcher.1.0.0.jar': new MemoryJar({}),
        'start.sh':
          '#!/bin/sh\njava -Xmx3G -jar fabric-server-mc.1.20.4-loader.0.15.6-launcher.1.0.0.jar nogui\n',
      },
    });
    const r = await detectServer(fs, '/srv/fab', { os: 'linux' });
    expect(r?.loader.value).toBe('fabric');
    expect(r?.mcVersion).toEqual({ value: '1.20.4', confidence: 'high', source: 'jar_name' });
    expect(r?.loaderVersion?.value).toBe('0.15.6');
    expect(r?.maxRamMb).toEqual({ value: 3072, confidence: 'medium', source: 'script' });
    expect(r?.launch).toEqual({
      kind: 'jar',
      jar: 'fabric-server-mc.1.20.4-loader.0.15.6-launcher.1.0.0.jar',
    });
  });

  it('ancien schéma NeoForge 1.20.1-47.1.x et dérivation 21.1.x → 1.21.1', () => {
    expect(mcVersionFromNeoForge('21.1.219')).toBe('1.21.1');
    expect(mcVersionFromNeoForge('20.4.80')).toBe('1.20.4');
    expect(mcVersionFromNeoForge('20.2.0')).toBe('1.20.2');
    expect(mcVersionFromNeoForge('21.0.167')).toBe('1.21');
    expect(mcVersionFromNeoForge('1.20.1-47.1.3')).toBe('1.20.1');
    expect(mcVersionFromNeoForge('garbage')).toBeUndefined();
  });

  it('installer Forge seul + jar vanilla + mods : loader par l’installer, version par version.json, needsInstall', async () => {
    const fs = new MemoryDetectFs({
      '/srv/fresh': {
        'server.properties': props,
        'forge-1.20.1-47.3.0-installer.jar': new MemoryJar({ 'install_profile.json': '{}' }),
        mods: { 'a.jar': new MemoryJar({ 'META-INF/mods.toml': 'modLoader="javafml"' }) },
      },
    });
    const r = await detectServer(fs, '/srv/fresh');
    expect(r?.loader.value).toBe('forge');
    expect(r?.loader.confidence).toBe('high'); // installer + mods concordants
    expect(r?.needsInstall).toBe(true);
    expect(r?.mcVersion?.value).toBe('1.20.1');
    expect(r?.evidence.map((e) => e.code)).toContain('forge_installer_only');
  });

  it('jar forge racine qui est en fait un installer (Main-Class installer) → pas un forge legacy', async () => {
    const fs = new MemoryDetectFs({
      '/srv/x': {
        'eula.txt': 'eula=false',
        'forge-1.12.2-14.23.5.2860.jar': new MemoryJar({
          'META-INF/MANIFEST.MF':
            'Manifest-Version: 1.0\nMain-Class: net.minecraftforge.installer.SimpleInstaller\n',
          'install_profile.json': '{}',
        }),
      },
    });
    const r = await detectServer(fs, '/srv/x');
    expect(r?.loader.value).toBe('unknown');
    expect(r?.eulaAccepted).toBe(false);
    expect(r?.confidence).toBe('low');
    expect(r?.evidence.map((e) => e.code)).toContain('no_loader');
  });

  it('mods contradictoires avec le loader → confiance abaissée + evidence', async () => {
    const fs = new MemoryDetectFs({
      '/srv/mix': {
        'server.properties': props,
        'fabric-server-launch.jar': new MemoryJar({
          'install.properties': 'fabric-loader-version=0.15.0\ngame-version=1.20.1\n',
        }),
        mods: {
          'a.jar': new MemoryJar({ 'META-INF/mods.toml': '' }),
          'b.jar': new MemoryJar({ 'META-INF/mods.toml': '' }),
          'c.jar': new MemoryJar({ 'fabric.mod.json': '{}' }),
        },
      },
    });
    const r = await detectServer(fs, '/srv/mix');
    expect(r?.loader.value).toBe('fabric');
    expect(r?.loader.confidence).toBe('low');
    expect(r?.evidence.find((e) => e.code === 'mods_mismatch')?.detail).toBe('forge (2/3)');
    expect(r?.confidence).toBe('low');
  });

  it('versions contradictoires entre sources fortes → confiance moyenne + evidence', async () => {
    const fs = new MemoryDetectFs({
      '/srv/conf': {
        'eula.txt': 'eula=true',
        'minecraft_server.1.16.5.jar': new MemoryJar({
          'META-INF/MANIFEST.MF': 'Main-Class: net.minecraft.server.Main\n',
          'version.json': '{"id":"1.16.4"}',
        }),
      },
    });
    const r = await detectServer(fs, '/srv/conf');
    expect(r?.loader.value).toBe('vanilla');
    expect(r?.mcVersion?.confidence).toBe('medium');
    expect(r?.evidence.some((e) => e.code === 'version_conflict')).toBe(true);
  });

  it('marqueur .mmo-server.json lu, mais jamais décisif', async () => {
    const fs = new MemoryDetectFs({
      '/srv/m': { 'eula.txt': 'eula=true', '.mmo-server.json': '{"serverId":"srv_42"}' },
    });
    const r = await detectServer(fs, '/srv/m');
    expect(r?.markerServerId).toBe('srv_42');
    expect(r?.loader.value).toBe('unknown');
  });

  it('RAM : choix du script selon l’OS de l’agent, ambiguïté signalée', async () => {
    const tree = {
      'eula.txt': 'eula=true',
      'LaunchServer.bat': 'java -Xmx4G -jar forge.jar nogui\npause\n',
      'LaunchServer.sh': '#!/bin/sh\njava -Xmx10000m -jar forge.jar nogui\n',
    };
    const win = await detectServer(new MemoryDetectFs({ '/s': tree }), '/s', { os: 'windows' });
    const lin = await detectServer(new MemoryDetectFs({ '/s': tree }), '/s', { os: 'linux' });
    expect(win?.maxRamMb).toEqual({ value: 4096, confidence: 'low', source: 'script' });
    expect(lin?.maxRamMb.value).toBe(10000);
    expect(win?.evidence.some((e) => e.code === 'ram_ambiguous')).toBe(true);
  });

  it('RAM : lignes commentées ignorées (user_jvm_args.txt vide de sens → défaut)', async () => {
    const fs = new MemoryDetectFs({
      '/s': { 'eula.txt': 'eula=true', 'user_jvm_args.txt': '# -Xmx4G\n# -Xms2G\n' },
    });
    const r = await detectServer(fs, '/s');
    expect(r?.maxRamMb).toEqual({ value: 4096, confidence: 'low', source: 'default' });
  });

  it('scan : profondeur 2, dossier qualifié non exploré, exclusions', async () => {
    const fs = new MemoryDetectFs({
      '/root': {
        'Vanilla 1.20.1': {
          'MinecraftInstaller.exe': '',
          server: {
            'eula.txt': 'eula=true',
            'server.jar': new MemoryJar({ 'version.json': '{"id":"1.20.1"}' }),
          },
        },
        Direct: { 'server.properties': props, world: { 'server.properties': 'trap' } },
        '.mmo-trash': { Old: { 'eula.txt': 'eula=true' } },
        backups: { Snap: { 'eula.txt': 'eula=true' } },
        TooDeep: { a: { b: { 'eula.txt': 'eula=true' } } },
        // Lot 4 : restauration partielle côte à côte — le dossier a tout d'un serveur, il n'en est pas un.
        'restored-20260902-101530': { 'eula.txt': 'eula=true', 'server.properties': props },
        'restored-20260902-101530-2': { 'server.properties': props },
      },
    });
    const found = await scanForServers(fs, '/root', { excludePaths: ['/root/backups'] });
    expect(found.map((s) => s.path).sort()).toEqual([
      '/root/Direct',
      '/root/Vanilla 1.20.1/server',
    ]);
    expect(found.find((s) => s.name === 'server')?.mcVersion?.value).toBe('1.20.1');
  });

  it('parseProperties : commentaires, `:` et `=`, valeurs vides', () => {
    const m = parseProperties('# c\n!d\nserver-port=25565\nkey: value\nempty=\nbare\n');
    expect([...m.entries()]).toEqual([
      ['server-port', '25565'],
      ['key', 'value'],
      ['empty', ''],
      ['bare', ''],
    ]);
  });
});
