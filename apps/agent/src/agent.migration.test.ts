/**
 * Phase 9 — migration agent → agent de bout en bout (deux agents in-process, faux panel) :
 * `migration.export` (serveur en marche arrêté puis backup `pre_migration`), `transfer.serve`
 * (listener one-shot, `Range`), `migration.precheck` (dossier, port, Java, disque), `migration.import`
 * en **direct** puis en **relais** (source directe injoignable → URL relais HTTP avec reprise),
 * `migration.finalize` (renommage `.migrated-<date>`, marqueur retiré, purge différée), rejeu
 * idempotent de l'import, annulation.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  backupManifestSchema,
  migrationExportResultSchema,
  migrationImportResultSchema,
  ulid,
  type ParsedEventPayload,
} from '@mmo/protocol';

import { Agent } from './agent.js';
import { Logger } from './log.js';
import {
  FAKE_SERVER,
  createFakePanel,
  freePort,
  tmpDir,
  waitFor,
  type FakePanel,
  type PanelPeer,
} from './test/helpers.js';

const logger = new Logger('test', { stderr: false });

interface Captured {
  completed: ParsedEventPayload<'task.completed'>[];
  failed: ParsedEventPayload<'task.failed'>[];
  progress: ParsedEventPayload<'task.progress'>[];
  states: ParsedEventPayload<'server.stateChanged'>[];
}

function panelBehaviour(cap: Captured) {
  return (peer: PanelPeer) => {
    peer.handle('auth.hello', () => ({
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalSec: 1,
      wantFullSync: true,
      subscriptions: [],
      compression: 'gzip' as const,
    }));
    peer.handle('sync.state', () => ({}));
    const ack = (id: string | undefined) => {
      if (id !== undefined)
        void peer.request('event.ack', { eventIds: [id] }).catch(() => undefined);
    };
    peer.on('task.progress', (p) => {
      cap.progress.push(p);
    });
    peer.on('task.completed', (p, ctx) => {
      cap.completed.push(p);
      ack(ctx.id);
    });
    peer.on('task.failed', (p, ctx) => {
      cap.failed.push(p);
      ack(ctx.id);
    });
    peer.on('server.stateChanged', (p, ctx) => {
      cap.states.push(p);
      ack(ctx.id);
    });
    peer.on('server.detected', (_p, ctx) => {
      ack(ctx.id);
    });
    peer.on('server.removed', (_p, ctx) => {
      ack(ctx.id);
    });
    peer.on('server.updated', (_p, ctx) => {
      ack(ctx.id);
    });
  };
}

describe('phase 9 : migration agent → agent', () => {
  let cleanups: (() => Promise<void>)[] = [];
  let panel: FakePanel;
  let source: Agent | undefined;
  let target: Agent | undefined;
  let sourcePeer: PanelPeer;
  let targetPeer: PanelPeer;
  let cap: Captured;
  let sourceDir: string;
  let targetRoot: string;
  let gamePort: number;

  beforeEach(async () => {
    cleanups = [];
    cap = { completed: [], failed: [], progress: [], states: [] };
    panel = await createFakePanel(panelBehaviour(cap));
    const s = await tmpDir('mmo-mig-src-');
    const t = await tmpDir('mmo-mig-dst-');
    const ss = await tmpDir('mmo-mig-sstate-');
    const ts = await tmpDir('mmo-mig-tstate-');
    cleanups.push(s.cleanup, t.cleanup, ss.cleanup, ts.cleanup);
    targetRoot = t.dir;
    sourceDir = path.join(s.dir, 'Survie');
    gamePort = await freePort();
    await mkdir(path.join(sourceDir, 'world', 'region'), { recursive: true });
    await mkdir(path.join(sourceDir, 'logs'), { recursive: true });
    await writeFile(path.join(sourceDir, 'eula.txt'), 'eula=true\n');
    await writeFile(
      path.join(sourceDir, 'server.properties'),
      `server-port=${String(gamePort)}\nmotd=Survie\n`,
    );
    await writeFile(path.join(sourceDir, 'server.jar'), '');
    await writeFile(path.join(sourceDir, 'world', 'region', 'r.0.0.mca'), randomBytes(400_000));
    await writeFile(path.join(sourceDir, 'logs', 'latest.log'), 'old log\n');
    source = await bootAgent(ss.dir, 'agt_src');
    sourcePeer = panel.peers[panel.peers.length - 1]!;
    target = await bootAgent(ts.dir, 'agt_dst');
    targetPeer = panel.peers[panel.peers.length - 1]!;
    await sourcePeer.request('agent.configure', { servers: [serverConfig(sourceDir)] });
    await targetPeer.request('agent.configure', { servers: [] });
  });
  afterEach(async () => {
    await source?.stop();
    await target?.stop();
    await panel.close();
    for (const c of cleanups) await c();
  });

  function serverConfig(dir: string) {
    return {
      serverId: 'srv_1',
      path: dir,
      name: 'Survie',
      maxRamMb: 1024,
      mcVersion: '1.20.1',
      loader: 'forge' as const,
      launch: { kind: 'jar' as const, jar: 'server.jar' },
      javaMajor: 17,
    };
  }

  async function bootAgent(stateDir: string, agentId: string): Promise<Agent> {
    const rconFrom = await freePort();
    const agent = new Agent({
      stateDir,
      panelUrl: panel.url,
      logger,
      scanIntervalMs: 0,
      trashPurgeIntervalMs: 0,
      restrictPermissions: false,
      backoff: { baseMs: 50, maxMs: 200 },
      metricsIntervalMs: 0,
      backupSchedulerTickMs: 0,
      saveSettleMs: 200,
      serveAddresses: () => ['127.0.0.1'],
      manager: {
        commandBuilder: (ctx) => ({
          file: process.execPath,
          args: [FAKE_SERVER, '--done-after', '50'],
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
        totalRamMb: () => 16_384,
        rconPortRange: [rconFrom, 65000],
        rconProbeIntervalMs: 100,
        exitPollMs: 100,
      },
    });
    await agent.store.update((s) => {
      s.agentId = agentId;
      s.agentSecret = 'b'.repeat(64);
    });
    const next = panel.nextPeer();
    await agent.start();
    await next;
    return agent;
  }

  async function waitTask(taskId: string): Promise<ParsedEventPayload<'task.completed'>> {
    await waitFor(
      () =>
        cap.completed.some((c) => c.taskId === taskId) ||
        cap.failed.some((f) => f.taskId === taskId),
      30_000,
    );
    const failed = cap.failed.find((f) => f.taskId === taskId);
    if (failed) throw new Error(`task failed: ${JSON.stringify(failed.error)}`);
    return cap.completed.find((c) => c.taskId === taskId)!;
  }

  async function exportServer(): Promise<ReturnType<typeof migrationExportResultSchema.parse>> {
    const taskId = ulid();
    await sourcePeer.request('migration.export', {
      taskId,
      serverId: 'srv_1',
      migrationId: 'mig_1',
      backupId: 'bk_mig_1',
      announce: 'migration',
    });
    const done = await waitTask(taskId);
    return migrationExportResultSchema.parse(done.result);
  }

  it('direct : export (serveur en marche) → serve → precheck → import → finalize', async () => {
    await sourcePeer.request('server.start', { serverId: 'srv_1' });
    await waitFor(() => cap.states.some((s) => s.state === 'running'), 15_000);

    const manifest = await exportServer();
    expect(manifest.kind).toBe('pre_migration');
    expect(manifest.wasRunning).toBe(true);
    expect(source!.manager.get('srv_1')?.isRunning).toBe(false);
    expect(cap.progress.some((p) => p.phase === 'stopping')).toBe(true);

    const served = await sourcePeer.request('transfer.serve', {
      serverId: 'srv_1',
      backupId: 'bk_mig_1',
      token: 'a'.repeat(32),
      ttlSec: 60,
    });
    expect(served.urls.length).toBe(1);
    expect(served.urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a{32}$/);
    expect(served.sha256).toBe(manifest.sha256);
    expect(source!.migration.activeServes).toBe(1);

    // Jeton inconnu → 404 ; `Range` servi en 206.
    const bad = await fetch(served.urls[0]!.replace(/a{32}$/, 'b'.repeat(32)));
    expect(bad.status).toBe(404);
    const ranged = await fetch(served.urls[0]!, { headers: { Range: 'bytes=10-19' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 10-19/${String(manifest.sizeBytes)}`);
    expect((await ranged.arrayBuffer()).byteLength).toBe(10);

    const targetPath = path.join(targetRoot, 'Survie');
    const pre = await targetPeer.request('migration.precheck', {
      serverId: 'srv_1',
      path: targetPath,
      gamePort,
      javaMajor: 17,
      requiredBytes: manifest.bytesRaw * 2,
    });
    expect(pre.path.ok).toBe(true);
    expect(pre.port.ok).toBe(true);
    expect(pre.disk.ok).toBe(true);
    // Pas de vrai JRE 17 géré sur la machine de test ⇒ soit présent (système), soit installable.
    expect(pre.java.ok || pre.java.installable === true).toBe(true);

    const taskId = ulid();
    await targetPeer.request('migration.import', {
      taskId,
      migrationId: 'mig_1',
      config: serverConfig(targetPath),
      manifest: backupManifestSchema.parse(manifest),
      sources: [{ url: served.urls[0]!, kind: 'direct' }],
      startAfter: false,
    });
    const done = await waitTask(taskId);
    const result = migrationImportResultSchema.parse(done.result);
    expect(result.source).toBe('direct');
    expect(result.path).toBe(targetPath);
    expect(result.files).toBeGreaterThan(0);
    const marker = JSON.parse(
      await readFile(path.join(targetPath, '.mmo-server.json'), 'utf8'),
    ) as { serverId: string };
    expect(marker.serverId).toBe('srv_1');
    const region = await readFile(path.join(targetPath, 'world', 'region', 'r.0.0.mca'));
    expect(
      region.equals(await readFile(path.join(sourceDir, 'world', 'region', 'r.0.0.mca'))),
    ).toBe(true);
    // `logs/` est exclu des archives : absent sur la cible.
    await expect(stat(path.join(targetPath, 'logs'))).rejects.toThrow();
    expect(target!.store.getServer('srv_1')?.config.path).toBe(targetPath);
    // Staging nettoyé, listener fermé après le transfert complet.
    await waitFor(() => source!.migration.activeServes === 0, 5_000);

    // Rejeu du même import (même taskId) : idempotent.
    const again = await targetPeer.request('migration.import', {
      taskId,
      migrationId: 'mig_1',
      config: serverConfig(targetPath),
      manifest: backupManifestSchema.parse(manifest),
      sources: [{ url: served.urls[0]!, kind: 'direct' }],
    });
    expect(again.taskId).toBe(taskId);

    // Le serveur démarre sur la cible.
    const start = await targetPeer.request('server.start', { serverId: 'srv_1' });
    expect(start.pid).toBeGreaterThan(0);
    await waitFor(() => target!.manager.get('srv_1')?.state === 'running', 15_000);
    await targetPeer.request('server.stop', { serverId: 'srv_1' });

    // Finalisation côté source : renommage, marqueur retiré, purge planifiée, serveur oublié.
    // Phase 12 : comme le vrai panel, la source a déjà reçu une configuration sans ce serveur ;
    // le chemin reste renommable parce qu'il a été exporté pour cette migration (et pour elle seule).
    await sourcePeer.request('agent.configure', { servers: [] });
    await expect(
      sourcePeer.request('migration.finalize', {
        serverId: 'srv_1',
        migrationId: 'mig_other',
        path: sourceDir,
        action: 'rename',
      }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    const fin = await sourcePeer.request('migration.finalize', {
      serverId: 'srv_1',
      migrationId: 'mig_1',
      path: sourceDir,
      action: 'rename',
    });
    expect(fin.renamed).toBe(true);
    expect(fin.path).toMatch(/Survie\.migrated-\d{8}-\d{4}$/);
    await expect(stat(sourceDir)).rejects.toThrow();
    expect((await readdir(fin.path)).includes('.mmo-server.json')).toBe(false);
    expect(source!.store.get().migratedDirs[0]?.path).toBe(fin.path);
    expect(source!.store.getServer('srv_1')).toBeUndefined();
    // Pas encore purgé (7 j).
    expect(await source!.migration.purgeMigrated()).toBe(0);
  });

  it('relais : source directe injoignable → URL relais (Range) ; annulation ; dossier non vide refusé', async () => {
    const manifest = await exportServer();
    // Relais simulé : serveur HTTP servant l'archive avec `Range` (comme le panel).
    const archive = manifest.archivePath;
    const relay = http.createServer((req, res) => {
      void stat(archive).then((st) => {
        const m = /^bytes=(\d+)-/.exec(req.headers.range ?? '');
        const start = m ? Number(m[1]) : 0;
        res.writeHead(m ? 206 : 200, {
          'Content-Length': String(st.size - start),
          ...(m
            ? {
                'Content-Range': `bytes ${String(start)}-${String(st.size - 1)}/${String(st.size)}`,
              }
            : {}),
        });
        createReadStream(archive, { start }).pipe(res);
      });
    });
    const relayPort = await freePort();
    await new Promise<void>((r) => {
      relay.listen(relayPort, '127.0.0.1', r);
    });
    cleanups.push(
      () =>
        new Promise((r) => {
          relay.close(() => {
            r();
          });
        }),
    );
    const deadPort = await freePort();

    const targetPath = path.join(targetRoot, 'Survie');
    const taskId = ulid();
    await targetPeer.request('migration.import', {
      taskId,
      migrationId: 'mig_1',
      config: serverConfig(targetPath),
      manifest: backupManifestSchema.parse(manifest),
      sources: [
        { url: `http://127.0.0.1:${String(deadPort)}/${'c'.repeat(32)}`, kind: 'direct' },
        { url: `http://127.0.0.1:${String(relayPort)}/relay`, kind: 'relay' },
      ],
      connectTimeoutMs: 1000,
    });
    const done = await waitTask(taskId);
    const result = migrationImportResultSchema.parse(done.result);
    expect(result.source).toBe('relay');

    // Dossier cible non vide (un autre serveur) : refusé avant tout téléchargement.
    const other = path.join(targetRoot, 'Autre');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'server.jar'), '');
    const refused = ulid();
    await targetPeer.request('migration.import', {
      taskId: refused,
      migrationId: 'mig_2',
      config: { ...serverConfig(other), serverId: 'srv_2' },
      manifest: backupManifestSchema.parse(manifest),
      sources: [{ url: `http://127.0.0.1:${String(relayPort)}/relay`, kind: 'relay' }],
    });
    await waitFor(() => cap.failed.some((f) => f.taskId === refused), 10_000);
    expect(cap.failed.find((f) => f.taskId === refused)?.error.code).toBe('E_PRECHECK_FAILED');
    expect((await readdir(other)).includes('server.jar')).toBe(true);

    // Annulation pendant le téléchargement (source directe lente : jamais de réponse).
    const slow = http.createServer(() => undefined);
    const slowPort = await freePort();
    await new Promise<void>((r) => {
      slow.listen(slowPort, '127.0.0.1', r);
    });
    cleanups.push(
      () =>
        new Promise((r) => {
          slow.close(() => {
            r();
          });
        }),
    );
    const cancelled = ulid();
    const cancelledPath = path.join(targetRoot, 'Annule');
    await targetPeer.request('migration.import', {
      taskId: cancelled,
      migrationId: 'mig_3',
      config: { ...serverConfig(cancelledPath), serverId: 'srv_3' },
      manifest: backupManifestSchema.parse(manifest),
      sources: [{ url: `http://127.0.0.1:${String(slowPort)}/x`, kind: 'direct' }],
      connectTimeoutMs: 30_000,
    });
    await waitFor(() => cap.progress.some((p) => p.taskId === cancelled), 5_000);
    const c = await targetPeer.request('task.cancel', { taskId: cancelled });
    expect(c.cancelled).toBe(true);
    await waitFor(() => cap.failed.some((f) => f.taskId === cancelled), 10_000);
    expect(cap.failed.find((f) => f.taskId === cancelled)?.cancelled).toBe(true);
    await expect(stat(cancelledPath)).rejects.toThrow();
    await expect(stat(path.join(target!.store.dir, 'migrations', 'mig_3'))).rejects.toThrow();
  });
});
