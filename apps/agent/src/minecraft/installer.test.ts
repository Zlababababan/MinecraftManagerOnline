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

import { ForbiddenRoots } from '../files/forbidden.js';
import { Logger } from '../log.js';
import { TaskJournal, TaskRunner } from '../tasks/runner.js';
import { freePort, tmpDir } from '../test/helpers.js';
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
    server = http.createServer((req, res) => {
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
