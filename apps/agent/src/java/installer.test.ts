/**
 * `java.install` : chaîne de sources (404 → source suivante), archive zip (Windows) et tar.gz avec
 * dossier racine aplati, sha256 vérifié, sonde stubée, `.part` repris, `java.remove` limité aux JRE
 * gérés, aucune source valable ⇒ `E_JAVA_UNAVAILABLE` avec le détail des échecs.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createArchive } from '../backup/archive.js';
import { Logger } from '../log.js';
import { JavaRegistry } from '../platform/java.js';
import { TaskJournal, TaskRunner } from '../tasks/runner.js';
import { buildZip, freePort, tmpDir, waitFor } from '../test/helpers.js';
import { JavaInstaller } from './installer.js';

const logger = new Logger('test', { stderr: false });
const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

describe('JavaInstaller', () => {
  let stateDir: string;
  let cleanup: () => Promise<void>;
  let server: http.Server;
  let origin: string;
  let files: Map<string, Buffer>;
  let runner: TaskRunner;
  let installer: JavaInstaller;
  let events: { type: string; payload: unknown }[];

  beforeEach(async () => {
    ({ dir: stateDir, cleanup } = await tmpDir('mmo-java-'));
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
    const journal = new TaskJournal(stateDir);
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
    installer = new JavaInstaller({
      managedDir: path.join(stateDir, 'java'),
      registry: new JavaRegistry(path.join(stateDir, 'java')),
      logger,
      panelOrigin: () => origin,
      probe: async (p) => {
        const st = await stat(p).catch(() => undefined);
        if (!st?.isFile()) return undefined;
        const content = await readFile(p, 'utf8');
        const m = /major=(\d+)/.exec(content);
        return m
          ? { majorVersion: Number(m[1]), fullVersion: `${m[1] ?? ''}.0.1`, vendor: 'temurin' }
          : undefined;
      },
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

  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

  async function run(req: Parameters<JavaInstaller['install']>[0]) {
    const taskId = '01J5X8ZK3Q9WYE2R7M4T6B8N2B';
    await runner.start({ taskId, kind: 'java.install', payload: req }, (ctx) =>
      installer.install(req, ctx).then((r) => ({ ...r })),
    );
    await runner.wait(taskId);
    return runner.journal.get(taskId)!;
  }

  it('404 sur la première source → zip de la seconde (racine aplatie, sha256)', async () => {
    const zip = buildZip([
      { name: 'jdk-17.0.12+7-jre/', data: Buffer.alloc(0) },
      { name: `jdk-17.0.12+7-jre/bin/${EXE}`, data: Buffer.from('#!fake major=17'), deflate: true },
      { name: 'jdk-17.0.12+7-jre/lib/modules', data: Buffer.alloc(5000, 1), deflate: true },
      { name: 'jdk-17.0.12+7-jre/release', data: Buffer.from('JAVA_VERSION="17.0.12"') },
    ]);
    files.set('/zulu.zip', zip);
    const record = await run({
      majorVersion: 17,
      sources: [
        {
          vendor: 'temurin',
          url: `${origin}/missing.zip`,
          archive: 'zip',
          emulated: false,
          relay: false,
        },
        {
          vendor: 'zulu',
          url: `${origin}/zulu.zip`,
          archive: 'zip',
          sha256: sha(zip),
          size: zip.byteLength,
          emulated: false,
          relay: false,
        },
      ],
    });
    if (record.status !== 'done') console.error(JSON.stringify(record.error));
    expect(record.status).toBe('done');
    expect(record.result).toMatchObject({
      sourceIndex: 1,
      vendor: 'zulu',
      emulated: false,
      failures: [{ index: 0, code: 'E_NOT_FOUND' }],
    });
    const runtime = record.result!.runtime as {
      path: string;
      majorVersion: number;
      managed: boolean;
    };
    expect(runtime.majorVersion).toBe(17);
    expect(runtime.managed).toBe(true);
    expect(runtime.path).toBe(path.join(stateDir, 'java', '17-zulu', 'bin', EXE));
    expect((await stat(path.join(stateDir, 'java', '17-zulu', 'lib', 'modules'))).size).toBe(5000);
    // Aucun reste : ni .extract, ni .part.
    await expect(stat(path.join(stateDir, 'java', '17-zulu.extract'))).rejects.toThrow();
    await expect(
      stat(path.join(stateDir, 'java', '.downloads', '17-zulu.zip.part')),
    ).rejects.toThrow();
    expect(events.some((e) => e.type === 'task.completed')).toBe(true);

    // java.remove : géré → supprimé ; hors dossier géré → refusé.
    expect(await installer.remove(runtime.path)).toBe(true);
    await expect(stat(path.join(stateDir, 'java', '17-zulu'))).rejects.toThrow();
    await expect(installer.remove(process.execPath)).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
  });

  it('tar.gz (relais panel, URL relative) avec mode exécutable ; sha256 faux puis bon', async () => {
    const { dir: src, cleanup: c2 } = await tmpDir('mmo-jre-src-');
    try {
      const root = path.join(src, 'jdk-21.0.4+7-jre');
      await mkdir(path.join(root, 'bin'), { recursive: true });
      await writeFile(path.join(root, 'bin', EXE), '#!fake major=21', { mode: 0o755 });
      await writeFile(path.join(root, 'release'), 'JAVA_VERSION="21.0.4"');
      const archive = path.join(src, 'jre.tar.gz');
      await createArchive(src, archive, 'gzip', { exclude: (rel) => rel.endsWith('.tar.gz') });
      const data = await readFile(archive);
      files.set('/api/relay/jre', data);
      const record = await run({
        majorVersion: 21,
        sources: [
          {
            vendor: 'temurin',
            url: '/api/relay/jre',
            archive: 'tar.gz',
            sha256: 'f'.repeat(64),
            emulated: false,
            relay: true,
          },
          {
            vendor: 'temurin',
            url: '/api/relay/jre',
            archive: 'tar.gz',
            sha256: sha(data),
            emulated: true,
            relay: true,
          },
        ],
      });
      expect(record.status).toBe('done');
      expect(record.result).toMatchObject({
        sourceIndex: 1,
        emulated: true,
        failures: [{ index: 0, code: 'E_CHECKSUM_MISMATCH' }],
      });
      const exe = path.join(stateDir, 'java', '21-temurin-x64', 'bin', EXE);
      expect(await readFile(exe, 'utf8')).toBe('#!fake major=21');
      if (process.platform !== 'win32') expect((await stat(exe)).mode & 0o111).not.toBe(0);
    } finally {
      await c2();
    }
  });

  it('aucune source valable ⇒ E_JAVA_UNAVAILABLE avec les échecs', async () => {
    const bad = buildZip([{ name: 'readme.txt', data: Buffer.from('no java here') }]);
    files.set('/bad.zip', bad);
    const record = await run({
      majorVersion: 8,
      sources: [
        {
          vendor: 'temurin',
          url: `${origin}/bad.zip`,
          archive: 'zip',
          emulated: false,
          relay: false,
        },
        {
          vendor: 'zulu',
          url: 'http://127.0.0.1:1/never',
          archive: 'zip',
          emulated: false,
          relay: false,
        },
      ],
    });
    expect(record.status).toBe('failed');
    expect(record.error?.code).toBe('E_JAVA_UNAVAILABLE');
    const failures = (record.error?.details as { failures: { index: number; code: string }[] })
      .failures;
    expect(failures.map((f) => f.code)).toEqual(['E_IO', 'E_UNREACHABLE']);
    await waitFor(() => events.some((e) => e.type === 'task.failed'));
  });
});
