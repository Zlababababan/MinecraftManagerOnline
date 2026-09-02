/**
 * `config.get/set` et `player.action` : routage fichiers (serveur arrêté) vs commandes (serveur
 * en marche, fake Java server qui réécrit les JSON comme le vrai), préservation des clés inconnues
 * de `server.properties`, `expectedSha256`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerConfig } from '@mmo/protocol';

import { Logger } from '../log.js';
import { StateStore } from '../state/store.js';
import { FAKE_SERVER, freePort, tmpDir, waitFor } from '../test/helpers.js';
import { ConfigService, formatBanDate, type CommandResult } from './config-files.js';
import { offlineUuid } from './players.js';
import { ServerManager, type CommandContext } from './server-manager.js';

const logger = new Logger('test', { stderr: false });
const NOW = 1_787_300_000_000;

async function readJson(file: string): Promise<unknown[]> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown[];
}

function count(r: { data: unknown }): number {
  return (r.data as unknown[]).length;
}

describe('ConfigService — serveur arrêté (édition de fichiers)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let sent: string[];
  let svc: ConfigService;

  beforeEach(async () => {
    ({ dir, cleanup } = await tmpDir());
    sent = [];
    await writeFile(
      path.join(dir, 'server.properties'),
      '#Minecraft server properties\nmotd=A Minecraft Server\nonline-mode=false\nmod-custom-key=keep me\nmax-players=20\n',
    );
    svc = new ConfigService({
      serverDir: dir,
      isRunning: () => false,
      exec: (command): Promise<CommandResult> => {
        sent.push(command);
        return Promise.resolve({ via: 'stdin' });
      },
      now: () => NOW,
    });
  });
  afterEach(() => cleanup());

  it('server.properties : lecture en objet, patch en place (clés inconnues et ordre préservés, null supprime)', async () => {
    const got = await svc.get('server.properties');
    expect(got.source).toBe('file');
    expect(got.data).toEqual({
      motd: 'A Minecraft Server',
      'online-mode': 'false',
      'mod-custom-key': 'keep me',
      'max-players': '20',
    });
    const r = await svc.set(
      'server.properties',
      { motd: 'Bienvenue §6ici', 'max-players': null, 'white-list': 'true' },
      got.sha256,
    );
    expect(r).toMatchObject({ applied: 'file', restartRequired: false });
    expect(await readFile(path.join(dir, 'server.properties'), 'utf8')).toBe(
      '#Minecraft server properties\nmotd=Bienvenue \\u00a76ici\nonline-mode=false\nmod-custom-key=keep me\nwhite-list=true\n',
    );
    await expect(svc.set('server.properties', { motd: 'x' }, got.sha256)).rejects.toMatchObject({
      code: 'E_CONFLICT',
    });
    await expect(svc.set('server.properties', { motd: 42 })).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    expect(sent).toEqual([]);
  });

  it('whitelist/ops/bans : fichier absent = [], écriture complète avec valeurs par défaut', async () => {
    expect((await svc.get('whitelist.json')).data).toEqual([]);
    const r = await svc.set('whitelist.json', [{ uuid: offlineUuid('Bob'), name: 'Bob' }]);
    expect(r.applied).toBe('file');
    expect(await readJson(path.join(dir, 'whitelist.json'))).toEqual([
      { uuid: offlineUuid('Bob'), name: 'Bob' },
    ]);
    await svc.set('ops.json', [{ uuid: offlineUuid('Carol'), name: 'Carol' }]);
    expect(await readJson(path.join(dir, 'ops.json'))).toEqual([
      { uuid: offlineUuid('Carol'), name: 'Carol', level: 4, bypassesPlayerLimit: false },
    ]);
    await svc.set('banned-players.json', [
      { uuid: offlineUuid('Dave'), name: 'Dave', reason: 'griefing' },
    ]);
    expect(await readJson(path.join(dir, 'banned-players.json'))).toEqual([
      {
        uuid: offlineUuid('Dave'),
        name: 'Dave',
        created: formatBanDate(NOW),
        source: 'MMO',
        expires: 'forever',
        reason: 'griefing',
      },
    ]);
    await svc.set('banned-ips.json', [{ ip: '10.0.0.1' }]);
    expect((await svc.get('banned-ips.json')).data).toEqual([
      {
        ip: '10.0.0.1',
        created: formatBanDate(NOW),
        source: 'MMO',
        expires: 'forever',
        reason: 'Banned by an operator.',
      },
    ]);
    expect(sent).toEqual([]);
  });

  it('conserve les champs inconnus des entrées existantes (mods) et tolère les entrées invalides', async () => {
    await writeFile(
      path.join(dir, 'ops.json'),
      JSON.stringify([
        {
          uuid: offlineUuid('Carol'),
          name: 'Carol',
          level: 2,
          bypassesPlayerLimit: true,
          extra: 1,
        },
        { garbage: true },
      ]),
    );
    const got = await svc.get('ops.json');
    expect(got.data).toEqual([
      { uuid: offlineUuid('Carol'), name: 'Carol', level: 2, bypassesPlayerLimit: true },
    ]);
    await svc.set('ops.json', [
      { uuid: offlineUuid('Carol'), name: 'Carol', level: 3 },
      { uuid: offlineUuid('Erin'), name: 'Erin' },
    ]);
    expect(await readJson(path.join(dir, 'ops.json'))).toEqual([
      { uuid: offlineUuid('Carol'), name: 'Carol', level: 3, bypassesPlayerLimit: true, extra: 1 },
      { uuid: offlineUuid('Erin'), name: 'Erin', level: 4, bypassesPlayerLimit: false },
    ]);
  });

  it('player.action hors ligne : résolution UUID v3 (online-mode=false), kick refusé', async () => {
    expect(await svc.playerAction('whitelistAdd', 'Bob')).toEqual({ applied: 'file' });
    expect(await readJson(path.join(dir, 'whitelist.json'))).toEqual([
      { uuid: offlineUuid('Bob'), name: 'Bob' },
    ]);
    await svc.playerAction('whitelistAdd', 'bob'); // même UUID → remplace, pas de doublon
    expect(await readJson(path.join(dir, 'whitelist.json'))).toHaveLength(1);
    await svc.playerAction('op', 'Carol', undefined, 2);
    expect(await readJson(path.join(dir, 'ops.json'))).toMatchObject([{ name: 'Carol', level: 2 }]);
    await svc.playerAction('ban', 'Dave', 'spam');
    expect(await readJson(path.join(dir, 'banned-players.json'))).toMatchObject([
      { name: 'Dave', reason: 'spam' },
    ]);
    await svc.playerAction('pardon', 'dave');
    expect(await readJson(path.join(dir, 'banned-players.json'))).toEqual([]);
    await svc.playerAction('banIp', '10.0.0.9', 'bot');
    await svc.playerAction('pardonIp', '10.0.0.9');
    expect(await readJson(path.join(dir, 'banned-ips.json'))).toEqual([]);
    await svc.playerAction('whitelistRemove', 'Bob');
    await svc.playerAction('deop', 'Carol');
    expect(await readJson(path.join(dir, 'whitelist.json'))).toEqual([]);
    expect(await readJson(path.join(dir, 'ops.json'))).toEqual([]);
    await expect(svc.playerAction('kick', 'Bob')).rejects.toMatchObject({
      code: 'E_CONFLICT',
      details: { reason: 'not_running' },
    });
    await expect(svc.playerAction('ban', 'bad name')).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    expect(sent).toEqual([]);
  });

  it('online-mode=true sans réseau : E_NOT_FOUND (uuid_unresolved)', async () => {
    await writeFile(path.join(dir, 'server.properties'), 'online-mode=true\n');
    const online = new ConfigService({
      serverDir: dir,
      isRunning: () => false,
      exec: () => Promise.resolve({ via: 'stdin' }),
      fetchImpl: () => Promise.reject(new Error('no network')),
    });
    await expect(online.playerAction('whitelistAdd', 'Ghost')).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
      details: { reason: 'uuid_unresolved' },
    });
  });
});

describe('ConfigService — serveur en marche (commandes via le fake Java server)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let stateDir: string;
  let cleanupState: () => Promise<void>;
  let manager: ServerManager;

  beforeEach(async () => {
    const gamePort = await freePort();
    ({ dir, cleanup } = await tmpDir());
    ({ dir: stateDir, cleanup: cleanupState } = await tmpDir('mmo-state-'));
    await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
    await writeFile(
      path.join(dir, 'server.properties'),
      `server-port=${String(gamePort)}\nonline-mode=false\n`,
    );
    await writeFile(path.join(dir, 'server.jar'), '');
    const store = new StateStore(stateDir, { restrictPermissions: false });
    await store.load();
    manager = new ServerManager({
      store,
      logger,
      os: 'linux',
      onEvent: () => undefined,
      commandBuilder: (ctx: CommandContext) => ({
        file: process.execPath,
        args: [FAKE_SERVER, '--done-after', '50', '--join', 'Alice'],
        cwd: ctx.config.path,
        cmdlineKey: 'fake-java-server.mjs',
        files: [],
      }),
      javaResolver: () =>
        Promise.resolve({
          majorVersion: 17,
          vendor: 'fake',
          path: process.execPath,
          managed: false,
        }),
      totalRamMb: () => 8192,
      // `freePort()` peut rendre > 65000 sur les runners Windows : plage vide sinon (session 5).
      rconPortRange: [Math.min(await freePort(), 64_000), 65000],
      rconProbeIntervalMs: 100,
      exitPollMs: 100,
    });
    const config: ServerConfig = {
      serverId: 'srv_1',
      path: dir,
      maxRamMb: 1024,
      mcVersion: '1.20.1',
      loader: 'vanilla',
      launch: { kind: 'jar', jar: 'server.jar' },
    };
    await manager.applyConfigs([config]);
    await manager.start('srv_1');
    await waitFor(() => manager.get('srv_1')?.state === 'running', 15_000);
    await waitFor(async () => (await manager.get('srv_1')?.listPlayers())?.online === 1, 10_000);
  });
  afterEach(async () => {
    const p = manager.get('srv_1');
    if (p?.isRunning) await p.kill();
    manager.dispose();
    await cleanup();
    await cleanupState();
  });

  it('config.set whitelist → diff en commandes, le serveur réécrit le fichier ; properties → restartRequired', async () => {
    const cfg = manager.config('srv_1');
    const r = await cfg.set('whitelist.json', [
      { uuid: offlineUuid('Bob'), name: 'Bob' },
      { uuid: offlineUuid('Carol'), name: 'Carol' },
    ]);
    expect(r).toMatchObject({
      applied: 'commands',
      restartRequired: false,
      commands: ['whitelist add Bob', 'whitelist add Carol'],
    });
    expect(r.warnings).toBeUndefined();
    await waitFor(async () => count(await cfg.get('whitelist.json')) === 2);
    expect(await readJson(path.join(dir, 'whitelist.json'))).toEqual([
      { uuid: offlineUuid('Bob'), name: 'Bob' },
      { uuid: offlineUuid('Carol'), name: 'Carol' },
    ]);
    // Retrait de Carol + niveau d'op non applicable à chaud.
    const r2 = await cfg.set('whitelist.json', [{ uuid: offlineUuid('Bob'), name: 'Bob' }]);
    expect(r2.commands).toEqual(['whitelist remove Carol']);
    await waitFor(async () => count(await cfg.get('whitelist.json')) === 1);
    const r3 = await cfg.set('ops.json', [{ uuid: offlineUuid('Bob'), name: 'Bob', level: 2 }]);
    expect(r3).toMatchObject({
      applied: 'commands',
      commands: ['op Bob'],
      warnings: ['W_OP_LEVEL_LIVE'],
    });
    await waitFor(async () => count(await cfg.get('ops.json')) === 1);

    const props = await cfg.set('server.properties', { motd: 'Live', 'white-list': 'true' });
    expect(props).toMatchObject({
      applied: 'file',
      restartRequired: true,
      commands: ['whitelist on'],
    });
    expect(await readFile(path.join(dir, 'server.properties'), 'utf8')).toContain('motd=Live');
  });

  it('player.action en marche : kick/ban via commandes avec réponse RCON, commande invalide signalée', async () => {
    const cfg = manager.config('srv_1');
    const kick = await cfg.playerAction('kick', 'Alice', 'bye');
    expect(kick.applied).toBe('commands');
    expect(kick.response).toContain('Kicked Alice: bye');
    await waitFor(async () => (await manager.get('srv_1')?.listPlayers())?.online === 0);
    const ban = await cfg.playerAction('ban', 'Dave', 'griefing');
    expect(ban.response).toContain('Banned Dave');
    expect((await cfg.get('banned-players.json')).data).toMatchObject([
      { name: 'Dave', reason: 'griefing', expires: 'forever' },
    ]);
    const miss = await cfg.playerAction('kick', 'Nobody');
    expect(miss.warnings).toEqual(['W_COMMAND_FAILED']);
  });
});
