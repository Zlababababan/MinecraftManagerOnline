/**
 * `server.install` (lot 5) : plan exécuté dans l'ordre, EULA écrite APRÈS les étapes (l'invariant
 * du lanceur Fabric, doc 06 §6ter), sortie d'un `runJar` bornée et jointe au seul échec, code de
 * retour du processus qui fait foi, dossier créé défait en cas d'échec — jamais en mode réparer.
 *
 * Le faux installeur est un script Node lancé par le VRAI `spawn` (via `spawnImpl`) : tout le
 * chemin réel est exercé (flux, fermeture, code de sortie, timeout) sans dépendre d'un JDK.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { serverInstallSchema, type JavaRuntime } from '@mmo/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_CAPABILITIES } from '../agent.js';
import { ForbiddenRoots } from '../files/forbidden.js';
import { Logger } from '../log.js';
import { TaskJournal, TaskRunner } from '../tasks/runner.js';
import { buildZip, freePort, tmpDir } from '../test/helpers.js';
import { AGENT_USER_AGENT } from '../util/user-agent.js';
import { ServerInstaller, type ServerInstallRequest } from './installer.js';

const logger = new Logger('test', { stderr: false });

const JAVA: JavaRuntime = {
  majorVersion: 21,
  fullVersion: '21.0.3',
  vendor: 'temurin',
  path: '/usr/bin/java',
  managed: false,
};

describe('ServerInstaller (lot 5)', () => {
  let stateDir: string;
  let serverDir: string;
  let cleanup: () => Promise<void>;
  let server: http.Server;
  let origin: string;
  let files: Map<string, Buffer>;
  /** Requêtes reçues par le faux fournisseur (chemin, User-Agent). */
  let hits: { url: string; ua: string | undefined }[];
  /** Chemins auxquels le faux fournisseur répond 503 (service surchargé). */
  let busy: Set<string>;
  let runner: TaskRunner;
  let installer: ServerInstaller;
  let events: { type: string; payload: unknown }[];
  let runtimes: JavaRuntime[];
  /** Script exécuté à la place du JAR ; réécrit par les tests qui exercent `runJar`. */
  let fakeInstaller: string;

  beforeEach(async () => {
    ({ dir: stateDir, cleanup } = await tmpDir('mmo-install-'));
    serverDir = path.join(stateDir, 'servers', 'new-one');
    files = new Map();
    hits = [];
    busy = new Set();
    server = http.createServer((req, res) => {
      hits.push({ url: req.url ?? '', ua: req.headers['user-agent'] });
      if (busy.has(req.url ?? '')) {
        res.writeHead(503).end();
        return;
      }
      const data = files.get(req.url ?? '');
      if (!data) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(data.byteLength) }).end(data);
    });
    const port = await freePort();
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    origin = `http://127.0.0.1:${String(port)}`;
    events = [];
    runtimes = [JAVA];
    fakeInstaller = path.join(stateDir, 'fake-installer.mjs');
    const journal = new TaskJournal(path.join(stateDir, 'journal'));
    await journal.load();
    runner = new TaskRunner({
      journal,
      logger,
      emit: (type, payload) => {
        events.push({
          type,
          payload: typeof payload === 'function' ? payload('01J5X8ZK3Q9WYE2R7M4T6B8N2A') : payload,
        });
      },
    });
    installer = new ServerInstaller({
      logger,
      java: {
        select: async (req) =>
          Promise.resolve(runtimes.find((r) => r.majorVersion === req.majorVersion)),
        list: async () => Promise.resolve(runtimes),
      },
      // Le dossier d'état de l'agent est interdit comme cible d'installation.
      forbidden: new ForbiddenRoots([path.join(stateDir, 'agent-home')]),
      os: process.platform === 'win32' ? 'windows' : 'linux',
      panelOrigin: () => origin,
      archiveRoots: () => [{ id: 'dir_1', path: path.join(stateDir, 'servers') }],
      // `java -jar <jar> <args>` devient `node <script> <jar> <args>` : même mécanique de processus.
      spawnImpl: ((_cmd: string, args: readonly string[], opts: object) =>
        spawn(process.execPath, [fakeInstaller, ...args.slice(1)], opts)) as typeof spawn,
    });
  });

  afterEach(async () => {
    await runner.dispose();
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
    await cleanup();
  });

  function serve(url: string, body: string): { url: string; sha1: string; size: number } {
    const data = Buffer.from(body);
    files.set(url, data);
    return {
      url: `${origin}${url}`,
      sha1: createHash('sha1').update(data).digest('hex'),
      size: data.byteLength,
    };
  }

  async function run(req: ServerInstallRequest, taskId = '01J5X8ZK3Q9WYE2R7M4T6B8N2B') {
    await installer.precheck(req);
    await runner.start(
      { taskId, kind: 'server.install', serverId: req.serverId, payload: req },
      (ctx) => installer.install(req, ctx),
    );
    await runner.wait(taskId);
    return runner.journal.get(taskId);
  }

  const base = (over: Record<string, unknown> = {}): ServerInstallRequest => {
    const { taskId: _ignored, ...req } = serverInstallSchema.parse({
      taskId: '01J5X8ZK3Q9WYE2R7M4T6B8N2B',
      serverId: 'srv_new',
      path: serverDir,
      loader: 'vanilla',
      steps: [{ kind: 'writeText', path: '.keep', content: '' }],
      ...over,
    });
    return req;
  };

  it('installe un vanilla : téléchargement vérifié, properties fusionnées, EULA, marqueur, détection', async () => {
    const jar = serve('/server.jar', 'PK-not-really-a-jar');
    const record = await run(
      base({
        mcVersion: '1.20.1',
        acceptEula: true,
        steps: [
          { kind: 'download', path: 'server.jar', url: jar.url, sha1: jar.sha1, size: jar.size },
          {
            kind: 'setProperties',
            path: 'server.properties',
            values: { 'server-port': '25566', motd: 'Chez nous' },
          },
        ],
      }),
    );
    expect(record?.status).toBe('done');
    const result = record?.result as { files: number; bytes: number; eulaAccepted: boolean };
    expect(result.eulaAccepted).toBe(true);
    expect(await readFile(path.join(serverDir, 'server.jar'), 'utf8')).toBe('PK-not-really-a-jar');
    const props = await readFile(path.join(serverDir, 'server.properties'), 'utf8');
    expect(props).toContain('server-port=25566');
    expect(props).toContain('motd=Chez nous');
    // La ligne d'EULA est une vraie ligne : un « \n » écrit en toutes lettres ne vaudrait rien.
    const eula = await readFile(path.join(serverDir, 'eula.txt'), 'utf8');
    expect(eula.split('\n')).toContain('eula=true');
    expect(eula).not.toContain(String.fromCharCode(92) + 'n');
    const marker: unknown = JSON.parse(
      await readFile(path.join(serverDir, '.mmo-server.json'), 'utf8'),
    );
    expect(marker).toMatchObject({ serverId: 'srv_new' });
    // Aucun `.part` laissé derrière.
    expect((await readdir(serverDir)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('exécute le jar AVANT d’écrire l’EULA (sinon le lanceur Fabric démarrerait le serveur)', async () => {
    // Le faux lanceur se comporte comme celui de Fabric : il installe, puis constate l'EULA.
    await writeFile(
      fakeInstaller,
      [
        "import { mkdirSync, writeFileSync, existsSync } from 'node:fs';",
        "mkdirSync('libraries', { recursive: true });",
        "writeFileSync('libraries/marker.txt', 'x');",
        "if (existsSync('eula.txt')) writeFileSync('would-have-started.txt', 'the server was launched');",
        "console.log('Downloading library from https://example.invalid/a.jar');",
      ].join('\n'),
      'utf8',
    );
    const jar = serve('/launcher.jar', 'launcher');
    const record = await run(
      base({
        loader: 'fabric',
        mcVersion: '1.20.1',
        acceptEula: true,
        steps: [
          { kind: 'download', path: 'launcher.jar', url: jar.url },
          { kind: 'runJar', jar: 'launcher.jar', args: ['nogui'], expect: ['libraries'] },
        ],
      }),
    );
    expect(record?.status).toBe('done');
    expect(await exists(path.join(serverDir, 'libraries', 'marker.txt'))).toBe(true);
    expect(await exists(path.join(serverDir, 'would-have-started.txt'))).toBe(false);
    expect(await exists(path.join(serverDir, 'eula.txt'))).toBe(true);
  });

  it('Forge/NeoForge : installeur rangé à part, exécuté dans le dossier, puis retiré avec son journal', async () => {
    // Mesuré sur les vrais installeurs (doc 06 §6quater) : lancé depuis un sous-dossier, il
    // installe dans le dossier courant et y laisse `installer.jar.log`.
    await writeFile(
      fakeInstaller,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "if (!process.argv.includes('--installServer')) process.exit(2);",
        "mkdirSync('libraries/net/neoforged/neoforge/21.1.209', { recursive: true });",
        "writeFileSync('libraries/net/neoforged/neoforge/21.1.209/win_args.txt', '-cp x');",
        "writeFileSync('libraries/net/neoforged/neoforge/21.1.209/unix_args.txt', '-cp x');",
        "writeFileSync('run.bat', 'java @libraries/net/neoforged/neoforge/21.1.209/win_args.txt');",
        "writeFileSync('installer.jar.log', 'log');",
        "console.log('The server installed successfully');",
      ].join('\n'),
      'utf8',
    );
    const jar = serve('/neoforge-installer.jar', 'installer');
    const record = await run(
      base({
        loader: 'neoforge',
        mcVersion: '1.21.1',
        acceptEula: true,
        steps: [
          { kind: 'download', path: '.mmo-install/installer.jar', url: jar.url, sha1: jar.sha1 },
          {
            kind: 'runJar',
            jar: '.mmo-install/installer.jar',
            args: ['--installServer'],
            expect: ['libraries'],
          },
          { kind: 'remove', path: '.mmo-install' },
          { kind: 'remove', path: 'installer.jar.log' },
        ],
      }),
    );
    expect(record?.status).toBe('done');
    expect(await exists(path.join(serverDir, '.mmo-install'))).toBe(false);
    expect(await exists(path.join(serverDir, 'installer.jar.log'))).toBe(false);
    expect(await exists(path.join(serverDir, 'run.bat'))).toBe(true);
    const result = record?.result as { detected?: { loader: { value: string } } };
    expect(result.detected?.loader.value).toBe('neoforge');
    // Une étape `remove` ne peut viser ni le dossier lui-même, ni en sortir.
    for (const bad of ['', '..', '../voisin', 'a/../../b']) {
      expect(() =>
        serverInstallSchema.parse({
          taskId: '01J5X8ZK3Q9WYE2R7M4T6B8N2B',
          serverId: 'srv_new',
          path: serverDir,
          loader: 'forge',
          steps: [{ kind: 'remove', path: bad }],
        }),
      ).toThrow();
    }
    // Et l'agent qui sait retirer le dit : sans la capacité, le panel refuse Forge/NeoForge en
    // demandant une mise à jour de l'agent (doc 05 §6).
    expect(AGENT_CAPABILITIES).toContain('install-remove');
  });

  it('un installeur qui échoue, qui ne produit rien, ou qui s’éternise : trois échecs distincts', async () => {
    const jar = serve('/launcher.jar', 'launcher');
    await writeFile(
      fakeInstaller,
      "console.log('There was an error during installation');\nprocess.exit(1);",
      'utf8',
    );
    const failed = await run(
      base({
        steps: [
          { kind: 'download', path: 'l.jar', url: jar.url },
          { kind: 'runJar', jar: 'l.jar' },
        ],
      }),
    );
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatchObject({ code: 'E_IO' });
    const details = failed?.error?.details as { reason: string; exitCode: number; output: string };
    expect(details.reason).toBe('RUN_FAILED');
    expect(details.exitCode).toBe(1);
    expect(details.output).toContain('There was an error during installation');
    // Le dossier créé pour l'occasion a été défait : rien de louche ne reste sur le disque.
    expect(await exists(serverDir)).toBe(false);

    // Sortie 0 mais rien de produit : le code de retour ne suffit pas.
    await writeFile(fakeInstaller, "console.log('The server installed successfully');", 'utf8');
    const incomplete = await run(
      base({
        steps: [
          { kind: 'download', path: 'l.jar', url: jar.url },
          { kind: 'runJar', jar: 'l.jar', expect: ['libraries'] },
        ],
      }),
      '01J5X8ZK3Q9WYE2R7M4T6B8N2C',
    );
    expect(incomplete?.status).toBe('failed');
    expect(incomplete?.error?.details).toMatchObject({
      reason: 'RUN_INCOMPLETE',
      missing: 'libraries',
    });

    // Installeur qui ne rend jamais la main.
    await writeFile(fakeInstaller, 'setInterval(() => {}, 1000);', 'utf8');
    const stuck = await run(
      base({
        steps: [
          { kind: 'download', path: 'l.jar', url: jar.url },
          { kind: 'runJar', jar: 'l.jar', timeoutSec: 1 },
        ],
      }),
      '01J5X8ZK3Q9WYE2R7M4T6B8N2D',
    );
    expect(stuck?.status).toBe('failed');
    expect(stuck?.error).toMatchObject({ code: 'E_TIMEOUT' });
    expect(stuck?.error?.details).toMatchObject({ reason: 'RUN_TIMEOUT' });
  }, 30_000);

  it('une empreinte qui ne correspond pas fait échouer l’installation, sans rien laisser', async () => {
    const jar = serve('/server.jar', 'contenu réel');
    const record = await run(
      base({
        steps: [
          {
            kind: 'download',
            path: 'server.jar',
            url: jar.url,
            sha1: 'a'.repeat(40),
            size: jar.size,
          },
        ],
      }),
    );
    expect(record?.status).toBe('failed');
    expect(await exists(serverDir)).toBe(false);
  });

  it('sans aucun JRE, l’installation est refusée en le disant', async () => {
    runtimes = [];
    const jar = serve('/l.jar', 'launcher');
    const record = await run(
      base({
        steps: [
          { kind: 'download', path: 'l.jar', url: jar.url },
          { kind: 'runJar', jar: 'l.jar' },
        ],
      }),
    );
    expect(record?.status).toBe('failed');
    expect(record?.error).toMatchObject({ code: 'E_JAVA_UNAVAILABLE' });
    expect(record?.error?.details).toMatchObject({ reason: 'NO_JAVA' });
  });

  describe('fetchMany (modpacks)', () => {
    const many = (
      list: { path: string; url: string; sha1: string; size: number; mirrors?: string[] }[],
    ) =>
      base({
        loader: 'neoforge',
        steps: [{ kind: 'fetchMany', label: 'Pack', concurrency: 2, files: list }],
      });

    it('pose chaque fichier vérifié, passe au miroir, se présente, et ne laisse aucun .part', async () => {
      const a = serve('/mods/a.jar', 'mod a');
      const b = serve('/cfg/b.toml', 'x = 1');
      const c = serve('/mirror/c.jar', 'mod c');
      const record = await run(
        many([
          { path: 'mods/a.jar', ...a },
          { path: 'config/deep/b.toml', ...b },
          // Source principale absente (404) : le miroir prend le relais.
          { path: 'mods/c.jar', ...c, url: `${origin}/gone/c.jar`, mirrors: [c.url] },
        ]),
      );
      expect(record?.status).toBe('done');
      expect(await readFile(path.join(serverDir, 'mods', 'a.jar'), 'utf8')).toBe('mod a');
      expect(await readFile(path.join(serverDir, 'config', 'deep', 'b.toml'), 'utf8')).toBe(
        'x = 1',
      );
      expect(await readFile(path.join(serverDir, 'mods', 'c.jar'), 'utf8')).toBe('mod c');
      expect(
        (await readdir(path.join(serverDir, 'mods'))).filter((n) => n.endsWith('.part')),
      ).toEqual([]);
      expect(hits.map((h) => h.url)).toEqual(
        expect.arrayContaining(['/mods/a.jar', '/gone/c.jar', '/mirror/c.jar']),
      );
      // Un client identifiable auprès des CDN (docs/services-tiers.md).
      expect(new Set(hits.map((h) => h.ua))).toEqual(new Set([AGENT_USER_AGENT]));
    });

    it('une empreinte fausse fait échouer l’installation entière, sans rien laisser', async () => {
      const a = serve('/mods/a.jar', 'mod a');
      const b = serve('/mods/b.jar', 'mod b');
      const record = await run(
        many([
          { path: 'mods/a.jar', ...a },
          { path: 'mods/b.jar', ...b, sha1: 'b'.repeat(40) },
        ]),
      );
      expect(record?.status).toBe('failed');
      expect(await exists(serverDir)).toBe(false);
      // L'interface affichera la variante « DOWNLOAD_FAILED » avec ces deux noms.
      expect(record?.error).toMatchObject({
        code: 'E_CHECKSUM_MISMATCH',
        details: { reason: 'DOWNLOAD_FAILED', file: 'mods/b.jar', host: new URL(origin).host },
      });
    });

    it('un service qui refuse (503) n’est pas relancé : une requête par source, puis l’échec', async () => {
      const a = serve('/mods/a.jar', 'mod a');
      busy.add('/mods/a.jar');
      busy.add('/mirror/a.jar');
      const record = await run(
        many([{ path: 'mods/a.jar', ...a, mirrors: [`${origin}/mirror/a.jar`] }]),
      );
      expect(record?.status).toBe('failed');
      expect(hits.map((h) => h.url)).toEqual(['/mods/a.jar', '/mirror/a.jar']);
      expect(record?.error?.details).toMatchObject({
        reason: 'DOWNLOAD_FAILED',
        file: 'mods/a.jar',
      });
    });

    it('en réparation, les fichiers déjà bons ne sont pas retéléchargés', async () => {
      const a = serve('/mods/a.jar', 'mod a');
      const b = serve('/mods/b.jar', 'mod b');
      await mkdir(path.join(serverDir, 'mods'), { recursive: true });
      await writeFile(path.join(serverDir, 'mods', 'a.jar'), 'mod a', 'utf8');
      await writeFile(path.join(serverDir, 'mods', 'b.jar'), 'abîmé', 'utf8');
      const record = await run({
        ...many([
          { path: 'mods/a.jar', ...a },
          { path: 'mods/b.jar', ...b },
        ]),
        repair: true,
      });
      expect(record?.status).toBe('done');
      expect(hits.map((h) => h.url)).toEqual(['/mods/b.jar']);
      expect(await readFile(path.join(serverDir, 'mods', 'b.jar'), 'utf8')).toBe('mod b');
    });
  });

  describe('extract (serveur depuis une archive)', () => {
    const SCRIPT = '#!/bin/sh\nNEOFORGE_VERSION=21.1.250\n';

    /** Pose un zip à la racine du répertoire surveillé ; `prefix` = dossier englobant. */
    async function archive(name: string, prefix = '', extra: string[] = []): Promise<string> {
      const zip = buildZip([
        { name: `${prefix}mods/a.jar`, data: Buffer.from('jar-a'), deflate: true },
        { name: `${prefix}config/x.toml`, data: Buffer.from('k = 1') },
        { name: `${prefix}startserver.sh`, data: Buffer.from(SCRIPT), deflate: true },
        { name: `${prefix}.mmo-server.json`, data: Buffer.from('{"serverId":"srv_other"}') },
        ...extra.map((n) => ({ name: n, data: Buffer.from('x') })),
      ]);
      await mkdir(path.join(stateDir, 'servers'), { recursive: true });
      const file = path.join(stateDir, 'servers', name);
      await writeFile(file, zip);
      return file;
    }

    it('liste les zips de la racine du répertoire surveillé, et rien de plus profond', async () => {
      const file = await archive('Pack.zip');
      await mkdir(path.join(stateDir, 'servers', 'sub'), { recursive: true });
      await writeFile(path.join(stateDir, 'servers', 'sub', 'deep.zip'), 'x');
      await writeFile(path.join(stateDir, 'servers', 'notes.txt'), 'x');
      const list = await installer.listArchives();
      expect(list.map((a) => a.name)).toEqual(['Pack.zip']);
      expect(list[0]).toMatchObject({ directoryId: 'dir_1', path: file });
    });

    it('inspecte sans rien déplier : scripts lus, dossier englobant reconnu', async () => {
      const flat = await installer.inspectArchive(await archive('flat.zip'));
      expect(flat.root).toBe('');
      expect(flat.files).toBe(4);
      expect(flat.topLevel).toEqual(expect.arrayContaining(['mods/', 'config/', 'startserver.sh']));
      expect(flat.texts).toEqual([{ name: 'startserver.sh', content: SCRIPT }]);
      const nested = await installer.inspectArchive(await archive('nested.zip', 'Pack-1.0/'));
      expect(nested.root).toBe('Pack-1.0');
      expect(nested.topLevel).toContain('mods/');
      expect(nested.texts[0]?.name).toBe('startserver.sh');
      // Rien n'a été écrit à côté de l'archive.
      expect((await readdir(path.join(stateDir, 'servers'))).sort()).toEqual([
        'flat.zip',
        'nested.zip',
      ]);
    });

    it('déplie dans le dossier du serveur, sans le marqueur de l’archive, et garde le zip', async () => {
      const file = await archive('nested.zip', 'Pack-1.0/');
      const record = await run(
        base({ loader: 'neoforge', steps: [{ kind: 'extract', archive: file, strip: 1 }] }),
      );
      expect(record?.status).toBe('done');
      expect(await readFile(path.join(serverDir, 'mods', 'a.jar'), 'utf8')).toBe('jar-a');
      expect(await readFile(path.join(serverDir, 'startserver.sh'), 'utf8')).toBe(SCRIPT);
      expect(await exists(path.join(serverDir, 'Pack-1.0'))).toBe(false);
      const marker: unknown = JSON.parse(
        await readFile(path.join(serverDir, '.mmo-server.json'), 'utf8'),
      );
      expect(marker).toMatchObject({ serverId: 'srv_new' });
      expect(await exists(file)).toBe(true);
      const phases = events
        .filter((e) => e.type === 'task.progress')
        .map((e) => (e.payload as { phase: string }).phase);
      expect(phases).toContain('extracting');
    });

    it('le marqueur d’une archive n’est jamais posé, même le temps de l’installation', async () => {
      // Réparation + étape suivante en échec : le dossier reste tel que l'extraction l'a laissé.
      const file = await archive('flat.zip');
      await mkdir(serverDir, { recursive: true });
      const record = await run(
        base({
          repair: true,
          steps: [
            { kind: 'extract', archive: file },
            { kind: 'runJar', jar: 'absent.jar' },
          ],
        }),
      );
      expect(record?.status).toBe('failed');
      expect(await exists(path.join(serverDir, 'mods', 'a.jar'))).toBe(true);
      expect(await exists(path.join(serverDir, '.mmo-server.json'))).toBe(false);
    });

    it('une entrée qui sort du dossier (zip-slip) n’est jamais écrite', async () => {
      const file = await archive('slip.zip', '', ['../evil.txt', '/abs.txt']);
      const record = await run(base({ steps: [{ kind: 'extract', archive: file }] }));
      expect(record?.status).toBe('done');
      expect(await exists(path.join(stateDir, 'servers', 'evil.txt'))).toBe(false);
      expect(await exists(path.join(serverDir, 'evil.txt'))).toBe(false);
      expect(await exists(path.join(serverDir, 'mods', 'a.jar'))).toBe(true);
    });

    it('refuse une archive hors d’un répertoire surveillé, absente, ou qui n’est pas un zip', async () => {
      const outside = path.join(stateDir, 'elsewhere.zip');
      await writeFile(outside, buildZip([{ name: 'a.txt', data: Buffer.from('a') }]));
      const step = (file: string) => base({ steps: [{ kind: 'extract', archive: file }] });
      await expect(installer.precheck(step(outside))).rejects.toMatchObject({
        details: { reason: 'ARCHIVE_OUTSIDE' },
      });
      await expect(installer.inspectArchive(outside)).rejects.toMatchObject({
        details: { reason: 'ARCHIVE_OUTSIDE' },
      });
      // Un sous-dossier d'un répertoire surveillé n'est pas sa racine.
      await mkdir(path.join(stateDir, 'servers', 'sub'), { recursive: true });
      const deep = path.join(stateDir, 'servers', 'sub', 'deep.zip');
      await writeFile(deep, 'x');
      await expect(installer.precheck(step(deep))).rejects.toMatchObject({
        details: { reason: 'ARCHIVE_OUTSIDE' },
      });
      const txt = path.join(stateDir, 'servers', 'notes.txt');
      await writeFile(txt, 'x');
      await expect(installer.precheck(step(txt))).rejects.toMatchObject({
        details: { reason: 'ARCHIVE_OUTSIDE' },
      });
      await expect(
        installer.precheck(step(path.join(stateDir, 'servers', 'ghost.zip'))),
      ).rejects.toMatchObject({ details: { reason: 'ARCHIVE_MISSING' } });
      const fake = path.join(stateDir, 'servers', 'fake.zip');
      await writeFile(fake, Buffer.alloc(4096, 7));
      await expect(installer.inspectArchive(fake)).rejects.toMatchObject({
        details: { reason: 'ZIP_UNREADABLE' },
      });
      const record = await run(step(fake));
      expect(record?.status).toBe('failed');
      expect(record?.error).toMatchObject({ details: { reason: 'ZIP_UNREADABLE' } });
      // Le dossier créé pour l'installation est défait ; l'archive, elle, reste.
      expect(await exists(serverDir)).toBe(false);
      expect(await exists(fake)).toBe(true);
    });

    it('l’agent annonce la capacité', () => {
      expect(AGENT_CAPABILITIES).toContain('install-extract');
    });
  });

  describe('précheck', () => {
    it('refuse un dossier peuplé, tolère le seul marqueur, et laisse passer une réparation', async () => {
      await mkdir(serverDir, { recursive: true });
      await writeFile(path.join(serverDir, 'world.zip'), 'précieux', 'utf8');
      await expect(installer.precheck(base())).rejects.toMatchObject({
        code: 'E_CONFLICT',
        details: { reason: 'PATH_NOT_EMPTY' },
      });
      // Réparer, c'est justement écrire dans un dossier peuplé.
      await expect(installer.precheck(base({ repair: true }))).resolves.toBeUndefined();
    });

    it('un dossier absent ou réduit au marqueur est vide', async () => {
      await expect(installer.precheck(base())).resolves.toBeUndefined();
      await mkdir(serverDir, { recursive: true });
      await writeFile(path.join(serverDir, '.mmo-server.json'), '{}', 'utf8');
      await expect(installer.precheck(base())).resolves.toBeUndefined();
    });

    it('refuse le dossier de l’agent, et l’EULA déguisée en étape', async () => {
      await expect(
        installer.precheck(base({ path: path.join(stateDir, 'agent-home', 'srv') })),
      ).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });
      await expect(
        installer.precheck(
          base({
            steps: [{ kind: 'writeText', path: 'eula.txt', content: 'eula=true', ifAbsent: false }],
          }),
        ),
      ).rejects.toMatchObject({ details: { reason: 'EULA_STEP' } });
    });
  });

  it('en mode réparer, un échec ne supprime pas le dossier existant', async () => {
    await mkdir(serverDir, { recursive: true });
    await writeFile(path.join(serverDir, 'world.zip'), 'précieux', 'utf8');
    await writeFile(fakeInstaller, 'process.exit(1);', 'utf8');
    const jar = serve('/l.jar', 'launcher');
    const record = await run(
      base({
        repair: true,
        steps: [
          { kind: 'download', path: 'l.jar', url: jar.url },
          { kind: 'runJar', jar: 'l.jar' },
        ],
      }),
    );
    expect(record?.status).toBe('failed');
    expect(await readFile(path.join(serverDir, 'world.zip'), 'utf8')).toBe('précieux');
  });

  it('n’écrase pas ce qu’un installeur vient de produire quand l’étape le demande', async () => {
    const a = serve('/a.txt', 'depuis le panel');
    await mkdir(serverDir, { recursive: true });
    const record = await run(
      base({
        steps: [
          { kind: 'download', path: 'a.txt', url: a.url },
          { kind: 'writeText', path: 'a.txt', content: 'écrasé', ifAbsent: true },
          { kind: 'writeText', path: 'b.txt', content: 'créé', ifAbsent: true },
        ],
      }),
    );
    expect(record?.status).toBe('done');
    expect(await readFile(path.join(serverDir, 'a.txt'), 'utf8')).toBe('depuis le panel');
    expect(await readFile(path.join(serverDir, 'b.txt'), 'utf8')).toBe('créé');
  });

  it('la progression passe par des phases, sans jamais relayer la sortie ligne à ligne', async () => {
    await writeFile(
      fakeInstaller,
      "for (let i = 0; i < 300; i++) console.log('Considering library ' + i);",
      'utf8',
    );
    const jar = serve('/l.jar', 'launcher');
    await run(
      base({
        steps: [
          { kind: 'download', path: 'l.jar', url: jar.url },
          { kind: 'runJar', jar: 'l.jar' },
        ],
      }),
    );
    const phases = events
      .filter((e) => e.type === 'task.progress')
      .map((e) => (e.payload as { phase: string }).phase);
    expect(new Set(phases)).toEqual(
      new Set(['preparing', 'downloading', 'running', 'detecting', 'done']),
    );
    // 300 lignes de sortie ne font pas 300 messages : le runner borne la cadence.
    expect(phases.filter((p) => p === 'running').length).toBeLessThan(20);
  });
});

async function exists(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined)) !== undefined;
}
