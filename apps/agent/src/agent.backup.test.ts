/**
 * Phase 8 de bout en bout (faux panel + fake Java server) : backup à chaud (save-off / save-all
 * flush / save-on), manifeste sha256, restauration refusée sur archive altérée puis réussie avec
 * backup de sécurité, backup planifié exécuté **panel éteint** puis synchronisé à la reconnexion,
 * rotation → `backup.rotated`, transferts binaires avec coupure/reprise (download et upload),
 * `fs.fetch`, annulation, reprise au boot (`E_INTERRUPTED`). Lot 4 : marqueur de destination déposé
 * à la configuration, sauvegarde planifiée refusée (`task.failed`) quand il manque, rien d'écrit.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  TransferReceiver,
  TransferSender,
  decodeFrame,
  transferIdFromBytes,
  ulid,
  type BackupManifest,
  type BackupRestorePathsResult,
  type ParsedEventPayload,
} from '@mmo/protocol';
import { chunkCodec, sha256Hasher } from '@mmo/shared/node';

import { Agent } from './agent.js';
import { Logger } from './log.js';
import {
  FAKE_SERVER,
  createFakePanel,
  freePort,
  sleep,
  tmpDir,
  waitFor,
  type FakePanel,
  type PanelPeer,
} from './test/helpers.js';

const logger = new Logger('test', { stderr: false });
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface Captured {
  progress: ParsedEventPayload<'task.progress'>[];
  completed: ParsedEventPayload<'task.completed'>[];
  failed: ParsedEventPayload<'task.failed'>[];
  rotated: ParsedEventPayload<'backup.rotated'>[];
  states: ParsedEventPayload<'server.stateChanged'>[];
  frames: { transferId: string; offset: number; data: Uint8Array }[];
  acks: { transferId: string; offset: number }[];
  /** Récepteur de download côté panel (reprise à travers les sessions). */
  receiver?: TransferReceiver;
  /** Émetteur d'upload côté panel. */
  sender?: TransferSender;
  doneRequests: { transferId: string; size: number; sha256: string }[];
}

function panelBehaviour(cap: Captured) {
  return (peer: PanelPeer) => {
    peer.handle('auth.hello', () => ({
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalSec: 1,
      wantFullSync: true,
      subscriptions: [],
      compression: 'zstd' as const,
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
    peer.on('backup.rotated', (p, ctx) => {
      cap.rotated.push(p);
      ack(ctx.id);
    });
    peer.on('server.stateChanged', (p, ctx) => {
      cap.states.push(p);
      ack(ctx.id);
    });
    peer.on('fs.transfer.ack', (p) => {
      cap.acks.push(p);
      cap.sender?.onAck(p.offset);
    });
    peer.onBinary((data) => {
      const frame = decodeFrame(data);
      if (!frame) return;
      cap.frames.push(frame);
      cap.receiver?.onFrame(frame);
    });
    peer.handle('fs.transfer.done', async (p) => {
      cap.doneRequests.push(p);
      if (!cap.receiver) throw new Error('no receiver');
      await cap.receiver.finish(p.size, p.sha256);
      return { verified: true as const };
    });
  };
}

describe('phase 8 : tasks, backups, transferts de bout en bout', () => {
  let stateDir: string;
  let cleanupState: () => Promise<void>;
  let serversRoot: string;
  let cleanupServers: () => Promise<void>;
  let panel: FakePanel;
  let agent: Agent | undefined;
  let cap: Captured;
  let serverDir: string;

  beforeEach(async () => {
    ({ dir: stateDir, cleanup: cleanupState } = await tmpDir('mmo-bk-state-'));
    ({ dir: serversRoot, cleanup: cleanupServers } = await tmpDir('mmo-bk-servers-'));
    cap = {
      progress: [],
      completed: [],
      failed: [],
      rotated: [],
      states: [],
      frames: [],
      acks: [],
      doneRequests: [],
    };
    panel = await createFakePanel(panelBehaviour(cap));
    serverDir = path.join(serversRoot, 'Survie');
    await mkdir(path.join(serverDir, 'world', 'region'), { recursive: true });
    await mkdir(path.join(serverDir, 'logs'), { recursive: true });
    await mkdir(path.join(serverDir, 'mods'), { recursive: true });
    await writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');
    await writeFile(
      path.join(serverDir, 'server.properties'),
      `server-port=${String(await freePort())}\nmotd=Survie\n`,
    );
    await writeFile(path.join(serverDir, 'server.jar'), '');
    await writeFile(path.join(serverDir, 'world', 'region', 'r.0.0.mca'), randomBytes(300_000));
    await writeFile(path.join(serverDir, 'logs', 'latest.log'), 'old log\n');
  });
  afterEach(async () => {
    await agent?.stop();
    await panel.close();
    await cleanupState();
    await cleanupServers();
  });

  async function bootAgent(
    options: {
      fetchImpl?: typeof fetch;
      transferLimits?: { maxFetchBytes?: number; maxUploadBytes?: number };
    } = {},
  ): Promise<PanelPeer> {
    const rconFrom = await freePort();
    agent = new Agent({
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
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.transferLimits === undefined ? {} : { transferLimits: options.transferLimits }),
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
        rconPortRange: [Math.min(rconFrom, 64_000), 65_000],
        rconProbeIntervalMs: 100,
        exitPollMs: 100,
      },
    });
    await agent.store.update((s) => {
      s.agentId = 'agt_1';
      s.agentSecret = 'b'.repeat(64);
    });
    await agent.start();
    return panel.peers.length > 0 ? panel.peers[panel.peers.length - 1]! : panel.nextPeer();
  }

  function configure(peer: PanelPeer, extra: Record<string, unknown> = {}) {
    return peer.request('agent.configure', {
      servers: [
        {
          serverId: 'srv_1',
          path: serverDir,
          name: 'Survie',
          maxRamMb: 1024,
          mcVersion: '1.20.1',
          loader: 'forge',
          launch: { kind: 'jar', jar: 'server.jar' },
        },
      ],
      ...extra,
    });
  }

  async function waitState(state: string): Promise<void> {
    await waitFor(() => cap.states.some((s) => s.state === state), 15_000);
  }

  it('backup à chaud : save-off → save-all flush → archive → save-on, manifeste sha256, progression, listage', async () => {
    const peer = await bootAgent();
    await configure(peer);
    await peer.request('server.start', { serverId: 'srv_1' });
    await waitState('running');

    const taskId = ulid();
    const res = await peer.request('backup.create', {
      taskId,
      serverId: 'srv_1',
      backupId: 'bk_manual_1',
      kind: 'manual',
      comment: 'test',
    });
    expect(res).toEqual({ taskId, backupId: 'bk_manual_1' });
    // Rejeu de la même requête (autre id d'enveloppe) : idempotent, même backupId.
    expect(await peer.request('backup.create', { taskId, serverId: 'srv_1' })).toEqual(res);

    await waitFor(() => cap.completed.some((c) => c.taskId === taskId), 20_000);
    const done = cap.completed.find((c) => c.taskId === taskId)!;
    expect(done.kind).toBe('backup.create');
    const manifest = done.result as BackupManifest & { durationMs: number };
    expect(manifest).toMatchObject({
      backupId: 'bk_manual_1',
      serverId: 'srv_1',
      kind: 'manual',
      hot: true,
      serverName: 'Survie',
      loader: 'forge',
      comment: 'test',
    });
    expect(['zstd', 'gzip']).toContain(manifest.codec);
    expect(manifest.files).toBeGreaterThanOrEqual(4);

    // Le fake server a reçu les commandes de sauvegarde dans l'ordre, et level.dat a été écrit avant l'archive.
    const saveLog = await readFile(path.join(serverDir, 'world', 'save-log.txt'), 'utf8');
    expect(saveLog.trim().split('\n')).toEqual(['save-off', 'save-all flush', 'save-on']);

    // Archive et manifeste présents ; sha256 + taille exacts.
    const archive = await readFile(manifest.archivePath);
    expect(archive.byteLength).toBe(manifest.sizeBytes);
    expect(sha256(archive)).toBe(manifest.sha256);
    expect(manifest.archivePath.startsWith(path.join(stateDir, 'backups', 'srv_1'))).toBe(true);
    const sidecar = JSON.parse(
      await readFile(path.join(path.dirname(manifest.archivePath), 'bk_manual_1.json'), 'utf8'),
    ) as BackupManifest;
    expect(sidecar.sha256).toBe(manifest.sha256);

    // Progression : phases attendues dans l'ordre.
    const phases = [
      ...new Set(cap.progress.filter((p) => p.taskId === taskId).map((p) => p.phase)),
    ];
    expect(phases.slice(0, 2)).toEqual(['preparing', 'saving']);
    expect(phases).toContain('archiving');
    expect(phases.at(-1)).toBe('finalizing');

    const list = await peer.request('backup.list', { serverId: 'srv_1' });
    expect(list.backups.map((b) => b.backupId)).toEqual(['bk_manual_1']);
    expect(await peer.request('task.list', {})).toMatchObject({
      tasks: [{ taskId, kind: 'backup.create', status: 'done' }],
    });
    await peer.request('task.ackResult', { taskId });
    expect((await peer.request('task.list', {})).tasks).toEqual([]);
  });

  it('restauration : refusée si l’archive ne correspond plus au manifeste, réussie (checksum + backup de sécurité + relance) sinon', async () => {
    const peer = await bootAgent();
    await configure(peer);
    await peer.request('server.start', { serverId: 'srv_1' });
    await waitState('running');
    const original = await readFile(path.join(serverDir, 'world', 'region', 'r.0.0.mca'));

    const createId = ulid();
    await peer.request('backup.create', { taskId: createId, serverId: 'srv_1', backupId: 'bk_1' });
    await waitFor(() => cap.completed.some((c) => c.taskId === createId), 20_000);
    const manifest = cap.completed.find((c) => c.taskId === createId)!.result as BackupManifest;

    // Altération d'un octet de l'archive → E_CHECKSUM_MISMATCH, rien n'est touché.
    const bytes = await readFile(manifest.archivePath);
    const tampered = Buffer.from(bytes);
    const mid = Math.floor(tampered.byteLength / 2);
    tampered[mid] = (tampered[mid] ?? 0) ^ 0xff;
    await writeFile(manifest.archivePath, tampered);
    const badId = ulid();
    await peer.request('backup.restore', { taskId: badId, serverId: 'srv_1', backupId: 'bk_1' });
    await waitFor(() => cap.failed.some((f) => f.taskId === badId), 20_000);
    expect(cap.failed.find((f) => f.taskId === badId)?.error.code).toBe('E_CHECKSUM_MISMATCH');
    expect(cap.states.filter((s) => s.state === 'stopped')).toHaveLength(0);
    await writeFile(manifest.archivePath, bytes);

    // Le monde change après le backup ; la restauration doit ramener l'original.
    await writeFile(path.join(serverDir, 'world', 'region', 'r.0.0.mca'), randomBytes(1000));
    await writeFile(path.join(serverDir, 'world', 'new-file.dat'), 'after backup');
    const restoreId = ulid();
    await peer.request('backup.restore', {
      taskId: restoreId,
      serverId: 'srv_1',
      backupId: 'bk_1',
      safetyBackupId: 'bk_safety',
      restartAfter: true,
    });
    await waitFor(() => cap.completed.some((c) => c.taskId === restoreId), 30_000);
    const result = cap.completed.find((c) => c.taskId === restoreId)!.result as {
      backupId: string;
      safetyBackup?: BackupManifest;
      restarted: boolean;
      wasRunning: boolean;
      files: number;
    };
    expect(result).toMatchObject({ backupId: 'bk_1', restarted: true, wasRunning: true });
    expect(result.safetyBackup).toMatchObject({ backupId: 'bk_safety', kind: 'pre_restore' });
    const restored = await readFile(path.join(serverDir, 'world', 'region', 'r.0.0.mca'));
    expect(restored.equals(original)).toBe(true);
    await expect(stat(path.join(serverDir, 'world', 'new-file.dat'))).rejects.toThrow();
    // Les exclusions (logs) survivent à la restauration ; le serveur a été arrêté puis relancé.
    expect(await readFile(path.join(serverDir, 'logs', 'latest.log'), 'utf8')).toContain('old log');
    expect(cap.states.map((s) => s.state)).toContain('stopped');
    await waitState('running');
    const phases = [
      ...new Set(cap.progress.filter((p) => p.taskId === restoreId).map((p) => p.phase)),
    ];
    expect(phases).toEqual([
      'verifying',
      'stopping',
      'safety_backup',
      'preparing',
      'inventory',
      'archiving',
      'finalizing',
      'clearing',
      'extracting',
      'restarting',
    ]);
    const list = await peer.request('backup.list', { serverId: 'srv_1' });
    expect(list.backups.map((b) => b.kind).sort()).toEqual(['manual', 'pre_restore']);
    expect(
      await peer.request('backup.delete', { serverId: 'srv_1', backupId: 'bk_safety' }),
    ).toEqual({ deleted: true });
    expect((await peer.request('backup.list', { serverId: 'srv_1' })).backups).toHaveLength(1);
  });

  it('backup planifié exécuté panel éteint, synchronisé à la reconnexion ; rotation → backup.rotated', async () => {
    const peer = await bootAgent();
    await configure(peer, {
      backupSchedules: [{ id: 'pol_1', serverId: 'srv_1', cron: '* * * * *', keep: 1 }],
    });
    expect(agent!.store.get().backupSchedules).toHaveLength(1);

    // Panel « éteint » : connexions coupées et refusées.
    panel.pause();
    await waitFor(() => !agent!.isConnected, 5000);
    const started = await agent!.backupScheduler.tick();
    expect(started).toHaveLength(1);
    // Même minute : pas de seconde exécution.
    expect(await agent!.backupScheduler.tick()).toEqual([]);
    await agent!.tasks.wait(started[0]!);
    const journal = agent!.tasks.journal.get(started[0]!);
    expect(journal?.status).toBe('done');
    expect(cap.completed).toHaveLength(0);

    // Reconnexion : le résultat (événement critique) est rejoué.
    panel.resume();
    await waitFor(() => cap.completed.length === 1, 10_000);
    expect(cap.completed[0]).toMatchObject({
      taskId: started[0],
      kind: 'backup.create',
      serverId: 'srv_1',
    });
    expect(cap.completed[0]?.result).toMatchObject({
      kind: 'scheduled',
      policyId: 'pol_1',
      hot: false,
    });
    const newPeer = panel.peers[panel.peers.length - 1]!;
    expect(newPeer).not.toBe(peer);
    expect((await newPeer.request('backup.list', { serverId: 'srv_1' })).backups).toHaveLength(1);

    // Occurrence suivante forcée (on oublie la dernière exécution) : keep = 1 → l'ancienne est tournée.
    await agent!.store.update((s) => {
      s.backupScheduleRuns = {};
    });
    const second = await agent!.backupScheduler.tick();
    expect(second).toHaveLength(1);
    await agent!.tasks.wait(second[0]!);
    await waitFor(() => cap.rotated.length === 1, 10_000);
    expect(cap.rotated[0]).toMatchObject({ serverId: 'srv_1', policyId: 'pol_1' });
    expect(cap.rotated[0]?.deleted).toHaveLength(1);
    expect(cap.rotated[0]?.deleted[0]?.backupId).toBe(
      (cap.completed[0]?.result as BackupManifest).backupId,
    );
    const remaining = (await newPeer.request('backup.list', { serverId: 'srv_1' })).backups;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.backupId).not.toBe((cap.completed[0]?.result as BackupManifest).backupId);
  });

  it('lot 4 : marqueur déposé à la configuration d’une destination explicite ; absent au moment du planning → task.failed sans rien écrire ; remis → sauvegarde', async () => {
    const peer = await bootAgent();
    const { dir: dest, cleanup } = await tmpDir('mmo-bk-dest-');
    try {
      const schedules = [{ id: 'pol_1', serverId: 'srv_1', cron: '* * * * *' }];
      await configure(peer, { backupDestination: dest, backupSchedules: schedules });
      const marker = path.join(dest, '.mmo-backups.json');
      const written = JSON.parse(await readFile(marker, 'utf8')) as { agentVersion?: unknown };
      expect(typeof written.agentVersion).toBe('string');
      expect(agent!.store.get().markedDestinations).toEqual([path.resolve(dest)]);

      // « Volume démonté » : le marqueur n'est plus là. Une configuration identique (chaque
      // reconnexion du panel en envoie une) ne le recrée pas — sinon la garde se réarmerait toute
      // seule sur le mauvais disque.
      await rm(marker);
      await configure(peer, { backupDestination: dest, backupSchedules: schedules });
      expect(await stat(marker).catch(() => undefined)).toBeUndefined();

      const started = await agent!.backupScheduler.tick();
      expect(started).toHaveLength(1);
      await agent!.tasks.wait(started[0]!);
      await waitFor(() => cap.failed.length === 1, 10_000);
      expect(cap.failed[0]).toMatchObject({ taskId: started[0], kind: 'backup.create' });
      expect(cap.failed[0]?.error).toMatchObject({ code: 'E_IO', retryable: false });
      expect(cap.failed[0]?.error.details).toMatchObject({
        reason: 'DESTINATION_UNMARKED',
        path: path.resolve(dest),
      });
      // Rien n'a été écrit sous la destination : ni dossier du serveur, ni `.part`.
      expect(await readdir(dest)).toEqual([]);

      // Marqueur remis à la main (un fichier vide suffit) : l'occurrence suivante passe.
      await writeFile(marker, '');
      await agent!.store.update((s) => {
        s.backupScheduleRuns = {};
      });
      const second = await agent!.backupScheduler.tick();
      expect(second).toHaveLength(1);
      await agent!.tasks.wait(second[0]!);
      await waitFor(() => cap.completed.length === 1, 10_000);
      const manifest = cap.completed[0]?.result as BackupManifest;
      expect(manifest.policyId).toBe('pol_1');
      expect(manifest.archivePath.startsWith(path.join(path.resolve(dest), 'srv_1'))).toBe(true);
      expect(await stat(manifest.archivePath).then((s) => s.isFile())).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('lot 4 : restauration partielle — parcours sans extraction, côte à côte sans arrêt, gardes, en place avec sécurité', async () => {
    const peer = await bootAgent();
    await configure(peer);
    await writeFile(path.join(serverDir, 'mods', 'a.jar'), 'jar-a');
    await peer.request('server.start', { serverId: 'srv_1' });
    await waitState('running');
    const original = await readFile(path.join(serverDir, 'world', 'region', 'r.0.0.mca'));
    const createId = ulid();
    await peer.request('backup.create', { taskId: createId, serverId: 'srv_1', backupId: 'bk_p' });
    await waitFor(() => cap.completed.some((c) => c.taskId === createId), 20_000);

    // Parcours : dossiers agrégés (dossiers d'abord), fichiers listés, exclusions absentes.
    const browsed = await peer.request('backup.browse', { serverId: 'srv_1', backupId: 'bk_p' });
    const byPath = new Map(browsed.entries.map((e) => [e.path, e]));
    expect(byPath.get('world/region/r.0.0.mca')).toMatchObject({
      kind: 'file',
      size: original.byteLength,
    });
    expect(byPath.get('world/region')).toMatchObject({
      kind: 'dir',
      files: 1,
      size: original.byteLength,
    });
    expect(byPath.get('world')?.files).toBeGreaterThanOrEqual(2);
    expect(byPath.get('mods/a.jar')).toMatchObject({ kind: 'file', size: 5 });
    expect(byPath.has('logs')).toBe(false);
    expect(byPath.has('.mmo-server.json')).toBe(false);
    expect(browsed.truncated).toBe(false);
    expect(browsed.totalFiles).toBe(browsed.entries.filter((e) => e.kind === 'file').length);
    const lastDir = browsed.entries.map((e) => e.kind).lastIndexOf('dir');
    expect(browsed.entries.findIndex((e) => e.kind === 'file')).toBeGreaterThan(lastDir);

    // Chemin réservé ou hors jail : refusé à la requête, avant toute task.
    await expect(
      peer.request('backup.restorePaths', {
        taskId: ulid(),
        serverId: 'srv_1',
        backupId: 'bk_p',
        paths: ['logs/latest.log'],
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });

    // Côte à côte (défaut) : le serveur n'est pas arrêté, rien n'est remplacé.
    await writeFile(path.join(serverDir, 'mods', 'a.jar'), 'jar-a-modified');
    const sideId = ulid();
    await peer.request('backup.restorePaths', {
      taskId: sideId,
      serverId: 'srv_1',
      backupId: 'bk_p',
      paths: ['world/region', 'mods/a.jar', 'mods'],
    });
    await waitFor(() => cap.completed.some((c) => c.taskId === sideId), 30_000);
    const side = cap.completed.find((c) => c.taskId === sideId)!
      .result as unknown as BackupRestorePathsResult;
    expect(side).toMatchObject({
      backupId: 'bk_p',
      mode: 'side_by_side',
      paths: ['mods', 'world/region'],
      files: 2,
      restarted: false,
      wasRunning: true,
    });
    expect(side.destination).toMatch(/^restored-\d{8}-\d{6}$/);
    const restoredDir = path.join(serverDir, side.destination!);
    expect(
      (await readFile(path.join(restoredDir, 'world', 'region', 'r.0.0.mca'))).equals(original),
    ).toBe(true);
    expect(await readFile(path.join(restoredDir, 'mods', 'a.jar'), 'utf8')).toBe('jar-a');
    await expect(stat(path.join(restoredDir, 'world', 'level.dat'))).rejects.toThrow();
    expect(await readFile(path.join(serverDir, 'mods', 'a.jar'), 'utf8')).toBe('jar-a-modified');
    expect(cap.states.filter((s) => s.state === 'stopped')).toHaveLength(0);
    expect([
      ...new Set(cap.progress.filter((p) => p.taskId === sideId).map((p) => p.phase)),
    ]).toEqual(['verifying', 'listing', 'preparing', 'extracting']);

    // Une nouvelle sauvegarde n'archive pas le dossier restauré.
    const create2 = ulid();
    await peer.request('backup.create', { taskId: create2, serverId: 'srv_1', backupId: 'bk_p2' });
    await waitFor(() => cap.completed.some((c) => c.taskId === create2), 20_000);
    const browsed2 = await peer.request('backup.browse', { serverId: 'srv_1', backupId: 'bk_p2' });
    expect(browsed2.entries.some((e) => e.path.startsWith('restored-'))).toBe(false);

    // Chemin absent de l'archive : refusé AVANT tout arrêt, rien n'est touché.
    await writeFile(path.join(serverDir, 'world', 'region', 'r.0.0.mca'), randomBytes(500));
    const missingId = ulid();
    await peer.request('backup.restorePaths', {
      taskId: missingId,
      serverId: 'srv_1',
      backupId: 'bk_p',
      paths: ['world/nope.dat', 'world/region'],
      mode: 'in_place',
    });
    await waitFor(() => cap.failed.some((f) => f.taskId === missingId), 20_000);
    const missingErr = cap.failed.find((f) => f.taskId === missingId)!.error;
    expect(missingErr.code).toBe('E_NOT_FOUND');
    expect(missingErr.details).toMatchObject({
      reason: 'PATHS_NOT_IN_ARCHIVE',
      paths: ['world/nope.dat'],
    });
    expect(cap.states.filter((s) => s.state === 'stopped')).toHaveLength(0);
    expect((await readFile(path.join(serverDir, 'world', 'region', 'r.0.0.mca'))).byteLength).toBe(
      500,
    );

    // Archive altérée : E_CHECKSUM_MISMATCH avant la liste, aucun dossier `restored-` créé.
    const m2 = cap.completed.find((c) => c.taskId === create2)!.result as BackupManifest;
    const bytes2 = await readFile(m2.archivePath);
    const tampered = Buffer.from(bytes2);
    const mid2 = Math.floor(tampered.byteLength / 2);
    tampered[mid2] = (tampered[mid2] ?? 0) ^ 0xff;
    await writeFile(m2.archivePath, tampered);
    const badId = ulid();
    await peer.request('backup.restorePaths', {
      taskId: badId,
      serverId: 'srv_1',
      backupId: 'bk_p2',
      paths: ['mods'],
    });
    await waitFor(() => cap.failed.some((f) => f.taskId === badId), 20_000);
    expect(cap.failed.find((f) => f.taskId === badId)?.error.code).toBe('E_CHECKSUM_MISMATCH');
    expect((await readdir(serverDir)).filter((n) => n.startsWith('restored-'))).toEqual([
      side.destination,
    ]);

    // En place : un seul dossier remplacé (voisins intacts), sécurité, arrêt puis relance.
    await writeFile(path.join(serverDir, 'world', 'region', 'r.1.0.mca'), 'extra');
    await writeFile(path.join(serverDir, 'mods', 'b.jar'), 'jar-b');
    const inId = ulid();
    await peer.request('backup.restorePaths', {
      taskId: inId,
      serverId: 'srv_1',
      backupId: 'bk_p',
      paths: ['world/region'],
      mode: 'in_place',
      safetyBackupId: 'bk_psafe',
      restartAfter: true,
    });
    await waitFor(() => cap.completed.some((c) => c.taskId === inId), 40_000);
    const inPlace = cap.completed.find((c) => c.taskId === inId)!
      .result as unknown as BackupRestorePathsResult;
    expect(inPlace).toMatchObject({
      mode: 'in_place',
      paths: ['world/region'],
      files: 1,
      restarted: true,
      wasRunning: true,
    });
    expect(inPlace.destination).toBeUndefined();
    expect(inPlace.safetyBackup).toMatchObject({ backupId: 'bk_psafe', kind: 'pre_restore' });
    expect(
      (await readFile(path.join(serverDir, 'world', 'region', 'r.0.0.mca'))).equals(original),
    ).toBe(true);
    await expect(stat(path.join(serverDir, 'world', 'region', 'r.1.0.mca'))).rejects.toThrow();
    expect(await readFile(path.join(serverDir, 'mods', 'b.jar'), 'utf8')).toBe('jar-b');
    expect(await readFile(path.join(serverDir, 'mods', 'a.jar'), 'utf8')).toBe('jar-a-modified');
    expect(await readFile(path.join(restoredDir, 'mods', 'a.jar'), 'utf8')).toBe('jar-a');
    expect(cap.states.map((s) => s.state)).toContain('stopped');
    await waitState('running');
    expect([...new Set(cap.progress.filter((p) => p.taskId === inId).map((p) => p.phase))]).toEqual(
      [
        'verifying',
        'listing',
        'stopping',
        'safety_backup',
        'preparing',
        'inventory',
        'archiving',
        'finalizing',
        'clearing',
        'extracting',
        'restarting',
      ],
    );
    // La sauvegarde de sécurité n'a pas emporté le dossier restauré côte à côte.
    const safe = await peer.request('backup.browse', { serverId: 'srv_1', backupId: 'bk_psafe' });
    expect(safe.entries.some((e) => e.path.startsWith('restored-'))).toBe(false);
    expect(safe.entries.some((e) => e.path === 'mods/b.jar')).toBe(true);
  });

  it('download avec coupure puis reprise par offset ; sha256 vérifié de bout en bout', async () => {
    const peer = await bootAgent();
    await configure(peer);
    // Assez gros pour que la coupure (après 2 chunks) laisse toujours des chunks en route : sur un
    // runner rapide, 5 chunks arrivaient entièrement avant que la fermeture des sockets prenne effet.
    const data = randomBytes(40 * 256 * 1024 + 123);
    await writeFile(path.join(serverDir, 'world', 'big.bin'), data);
    const transferId = transferIdFromBytes(randomBytes(16));
    const received: Uint8Array[] = [];
    let receivedBytes = 0;
    let dropped = false;
    const first = await peer.request('fs.download.start', {
      transferId,
      serverId: 'srv_1',
      path: 'world/big.bin',
      chunkSize: 256 * 1024,
      compression: 'zstd',
    });
    // zstd si le runtime de test l'offre (Node ≥ 22.15), sinon gzip : négocié, jamais présumé.
    expect(first).toMatchObject({ size: data.byteLength, chunkSize: 262_144 });
    expect(['zstd', 'gzip']).toContain(first.compression);
    cap.receiver = new TransferReceiver({
      transferId,
      codec: chunkCodec(first.compression),
      hash: sha256Hasher,
      write: (chunk) => {
        received.push(Uint8Array.from(chunk));
        receivedBytes += chunk.byteLength;
        // Coupure après 2 chunks : la session tombe, l'agent abandonne, le panel reprendra.
        if (!dropped && receivedBytes >= 2 * 256 * 1024) {
          dropped = true;
          panel.dropAll();
          return;
        }
        const current = panel.peers[panel.peers.length - 1]!;
        if (!current.isClosed)
          current.emit('fs.transfer.ack', { transferId, offset: receivedBytes });
      },
      sendAck: () => undefined,
    });

    await waitFor(() => dropped, 10_000);
    const resumed = await panel.nextPeer();
    await waitFor(() => agent!.isConnected, 10_000);
    // Les frames arrivées pendant la coupure sont ignorées côté panel (offset déjà dépassé ou égal).
    const offset = receivedBytes;
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(data.byteLength);
    // Le récepteur est réutilisé : il continue d'acquitter sur le nouveau pair.
    const second = await resumed.request('fs.download.start', {
      transferId,
      serverId: 'srv_1',
      path: 'world/big.bin',
      offset,
      chunkSize: 256 * 1024,
      compression: first.compression,
    });
    expect(second.size).toBe(data.byteLength);
    await waitFor(() => cap.doneRequests.length === 1, 15_000);
    expect(cap.doneRequests[0]).toEqual({
      transferId,
      size: data.byteLength,
      sha256: sha256(data),
    });
    expect(Buffer.concat(received).equals(data)).toBe(true);
    // Le nettoyage du transfert suit le `done` de façon asynchrone : attendre, pas asserter à sec.
    await waitFor(() => agent!.transfers.activeCount === 0, 5000);
  });

  it('upload avec coupure, reprise depuis la taille du .part, vérification et renommage', async () => {
    const peer = await bootAgent();
    await configure(peer);
    const data = randomBytes(7 * 128 * 1024 + 77);
    const transferId = transferIdFromBytes(randomBytes(16));
    const start = await peer.request('fs.upload.start', {
      transferId,
      serverId: 'srv_1',
      path: 'mods/new-mod.jar',
      size: data.byteLength,
      chunkSize: 128 * 1024,
      compression: 'none',
    });
    expect(start).toEqual({ offset: 0, chunkSize: 131_072, compression: 'none' });

    let sentFrames = 0;
    const sender = new TransferSender({
      transferId,
      chunkSize: 128 * 1024,
      windowChunks: 2,
      codec: chunkCodec('none'),
      hash: sha256Hasher,
      sendFrame: (frame) => {
        sentFrames++;
        if (sentFrames === 4) {
          // Coupure réseau pendant l'émission.
          panel.dropAll();
          throw new Error('socket closed');
        }
        peer.sendBinary(frame);
      },
    });
    cap.sender = sender;
    const run = sender.run(
      (async function* () {
        for (let i = 0; i < data.byteLength; i += 100_000) {
          await sleep(1);
          yield data.subarray(i, Math.min(i + 100_000, data.byteLength));
        }
      })(),
    );
    await waitFor(() => !sender.isAttached, 10_000);
    const resumed = await panel.nextPeer();
    await waitFor(() => agent!.isConnected, 10_000);
    const again = await resumed.request('fs.upload.start', {
      transferId,
      serverId: 'srv_1',
      path: 'mods/new-mod.jar',
      size: data.byteLength,
      chunkSize: 128 * 1024,
      compression: 'none',
    });
    expect(again.offset).toBeGreaterThan(0);
    expect(again.offset % 131_072).toBe(0);
    expect(again.offset).toBeGreaterThanOrEqual(sender.ackedOffset);
    sender.resume(again.offset, (frame) => {
      resumed.sendBinary(frame);
    });
    const { size } = await run;
    expect(size).toBe(data.byteLength);
    await expect(
      resumed.request('fs.transfer.done', { transferId, size, sha256: sender.sha256 }),
    ).resolves.toEqual({ verified: true });
    const written = await readFile(path.join(serverDir, 'mods', 'new-mod.jar'));
    expect(written.equals(data)).toBe(true);
    await expect(
      stat(path.join(serverDir, 'mods', `new-mod.jar.${transferId}.part`)),
    ).rejects.toThrow();
    // Sans `overwrite`, un second envoi vers le même fichier est refusé.
    await expect(
      resumed.request('fs.upload.start', {
        transferId: transferIdFromBytes(randomBytes(16)),
        serverId: 'srv_1',
        path: 'mods/new-mod.jar',
        size: 10,
      }),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' });
  });

  it('fs.fetch télécharge une URL dans le dossier (sha256 vérifié) ; annulation coopérative ; jail', async () => {
    const payload = randomBytes(200_000);
    let hang = false;
    const server = http.createServer((req, res) => {
      if (req.url === '/hang') {
        hang = true;
        res.writeHead(200, { 'content-length': '1000000' });
        res.write(Buffer.alloc(1000));
        return; // ne termine jamais
      }
      res.writeHead(200, { 'content-length': String(payload.byteLength) });
      res.end(payload);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    try {
      const peer = await bootAgent();
      await configure(peer);
      const taskId = ulid();
      await peer.request('fs.fetch', {
        taskId,
        serverId: 'srv_1',
        path: 'mods/spark-forge.jar',
        url: `http://127.0.0.1:${String(port)}/spark.jar`,
        sha256: sha256(payload),
      });
      await waitFor(() => cap.completed.some((c) => c.taskId === taskId), 10_000);
      expect(cap.completed.find((c) => c.taskId === taskId)?.result).toEqual({
        path: 'mods/spark-forge.jar',
        size: payload.byteLength,
        sha256: sha256(payload),
        // Le sha1 remonte aussi : c'est l'empreinte des catalogues de mods.
        sha1: createHash('sha1').update(payload).digest('hex'),
      });
      expect(
        (await readFile(path.join(serverDir, 'mods', 'spark-forge.jar'))).equals(payload),
      ).toBe(true);

      // Mauvais sha256 → E_CHECKSUM_MISMATCH, rien n'est écrit.
      const badId = ulid();
      await peer.request('fs.fetch', {
        taskId: badId,
        serverId: 'srv_1',
        path: 'mods/bad.jar',
        url: `http://127.0.0.1:${String(port)}/spark.jar`,
        sha256: 'f'.repeat(64),
      });
      await waitFor(() => cap.failed.some((c) => c.taskId === badId), 10_000);
      expect(cap.failed.find((c) => c.taskId === badId)?.error.code).toBe('E_CHECKSUM_MISMATCH');
      await expect(stat(path.join(serverDir, 'mods', 'bad.jar'))).rejects.toThrow();

      // Annulation pendant un téléchargement qui ne finit pas : task.failed cancelled, .part nettoyé.
      const hangId = ulid();
      await peer.request('fs.fetch', {
        taskId: hangId,
        serverId: 'srv_1',
        path: 'mods/hang.jar',
        url: `http://127.0.0.1:${String(port)}/hang`,
      });
      await waitFor(() => hang, 5000);
      await sleep(100);
      expect(await peer.request('task.cancel', { taskId: hangId })).toEqual({
        cancelled: true,
        status: 'running',
      });
      await waitFor(() => cap.failed.some((c) => c.taskId === hangId), 10_000);
      expect(cap.failed.find((c) => c.taskId === hangId)).toMatchObject({
        cancelled: true,
        error: { code: 'E_CANCELLED' },
      });
      await expect(stat(path.join(serverDir, 'mods', `hang.jar.${hangId}.part`))).rejects.toThrow();
      expect(await peer.request('task.cancel', { taskId: hangId })).toEqual({
        cancelled: false,
        status: 'cancelled',
      });

      // Chemin hors jail refusé par le schéma.
      await expect(
        peer.request('fs.fetch', {
          taskId: ulid(),
          serverId: 'srv_1',
          path: '../evil.jar',
          url: `http://127.0.0.1:${String(port)}/spark.jar`,
        }),
      ).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('fs.fetch reprend un téléchargement coupé au lieu de tout recommencer, et refuse au-delà du plafond', async () => {
    const payload = randomBytes(300_000);
    const half = 150_000;
    const requests: { range: string | undefined }[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === '/huge') {
        // Taille annoncée au-delà du plafond de 8 Gio : refus AVANT d'écrire quoi que ce soit.
        res.writeHead(200, { 'content-length': '9999999999' });
        res.end(Buffer.alloc(10));
        return;
      }
      const range = req.headers.range;
      requests.push({ range: typeof range === 'string' ? range : undefined });
      if (range === undefined) {
        // Première tentative : on annonce la taille complète puis on coupe à mi-chemin.
        res.writeHead(200, { 'content-length': String(payload.byteLength) });
        res.write(payload.subarray(0, half));
        setTimeout(() => {
          res.destroy();
        }, 20);
        return;
      }
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      res.writeHead(206, {
        'content-length': String(payload.byteLength - start),
        'content-range': `bytes ${String(start)}-${String(payload.byteLength - 1)}/${String(payload.byteLength)}`,
      });
      res.end(payload.subarray(start));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    try {
      const peer = await bootAgent();
      await configure(peer);

      const taskId = ulid();
      await peer.request('fs.fetch', {
        taskId,
        serverId: 'srv_1',
        path: 'mods/big.jar',
        url: `http://127.0.0.1:${String(port)}/big.jar`,
        sha256: sha256(payload),
      });
      await waitFor(() => cap.completed.some((c) => c.taskId === taskId), 20_000);

      // Le fichier est complet et juste…
      expect((await readFile(path.join(serverDir, 'mods', 'big.jar'))).equals(payload)).toBe(true);
      // …et il a fallu DEUX requêtes, la seconde reprenant à l'octet où la première s'est arrêtée.
      expect(requests).toHaveLength(2);
      expect(requests[0]?.range).toBeUndefined();
      expect(requests[1]?.range).toBe(`bytes=${String(half)}-`);

      // Plafond : une taille annoncée trop grande échoue sans rien écrire.
      const hugeId = ulid();
      await peer.request('fs.fetch', {
        taskId: hugeId,
        serverId: 'srv_1',
        path: 'mods/huge.jar',
        url: `http://127.0.0.1:${String(port)}/huge`,
      });
      await waitFor(() => cap.failed.some((c) => c.taskId === hugeId), 10_000);
      expect(cap.failed.find((c) => c.taskId === hugeId)?.error.code).toBe('E_TOO_LARGE');
      await expect(stat(path.join(serverDir, 'mods', 'huge.jar'))).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('phase 12 : fs.fetch et upload bornés (E_TOO_LARGE), schéma d’URL restreint à http(s)', async () => {
    const payload = randomBytes(50_000);
    const server = http.createServer((req, res) => {
      if (req.url === '/nolength') {
        // Pas de content-length : la borne doit jouer sur le flux réel.
        res.writeHead(200);
        res.end(payload);
        return;
      }
      res.writeHead(200, { 'content-length': String(payload.byteLength) });
      res.end(payload);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    try {
      const peer = await bootAgent({
        transferLimits: { maxFetchBytes: 10_000, maxUploadBytes: 20_000 },
      });
      await configure(peer);
      // content-length > plafond : refusé avant d'écrire quoi que ce soit.
      const byHeader = ulid();
      await peer.request('fs.fetch', {
        taskId: byHeader,
        serverId: 'srv_1',
        path: 'mods/big.jar',
        url: `http://127.0.0.1:${String(port)}/big.jar`,
      });
      await waitFor(() => cap.failed.some((c) => c.taskId === byHeader), 10_000);
      expect(cap.failed.find((c) => c.taskId === byHeader)?.error.code).toBe('E_TOO_LARGE');
      // Sans content-length : coupé pendant le flux, .part nettoyé.
      const byStream = ulid();
      await peer.request('fs.fetch', {
        taskId: byStream,
        serverId: 'srv_1',
        path: 'mods/big2.jar',
        url: `http://127.0.0.1:${String(port)}/nolength`,
      });
      await waitFor(() => cap.failed.some((c) => c.taskId === byStream), 10_000);
      expect(cap.failed.find((c) => c.taskId === byStream)?.error.code).toBe('E_TOO_LARGE');
      await expect(stat(path.join(serverDir, 'mods', 'big2.jar'))).rejects.toThrow();
      expect(
        (await readdir(path.join(serverDir, 'mods'))).filter((f) => f.endsWith('.part')),
      ).toEqual([]);
      // Taille annoncée > plafond et schéma non http(s) : tasks échouées sans rien télécharger.
      const declared = ulid();
      await peer.request('fs.fetch', {
        taskId: declared,
        serverId: 'srv_1',
        path: 'mods/declared.jar',
        url: `http://127.0.0.1:${String(port)}/x.jar`,
        size: 10_001,
      });
      const fileUrl = ulid();
      await peer.request('fs.fetch', {
        taskId: fileUrl,
        serverId: 'srv_1',
        path: 'mods/file.jar',
        url: 'file:///etc/passwd',
      });
      await waitFor(
        () => [declared, fileUrl].every((id) => cap.failed.some((c) => c.taskId === id)),
        10_000,
      );
      expect(cap.failed.find((c) => c.taskId === declared)?.error.code).toBe('E_TOO_LARGE');
      expect(cap.failed.find((c) => c.taskId === fileUrl)?.error.code).toBe('E_INVALID_PAYLOAD');
      // Upload : taille déclarée > plafond.
      await expect(
        peer.request('fs.upload.start', {
          transferId: transferIdFromBytes(randomBytes(16)),
          serverId: 'srv_1',
          path: 'mods/up.jar',
          size: 20_001,
        }),
      ).rejects.toMatchObject({ code: 'E_TOO_LARGE' });
      // Upload : flux plus long que la taille déclarée → refusé à la finalisation.
      const data = randomBytes(3000);
      const transferId = transferIdFromBytes(randomBytes(16));
      await peer.request('fs.upload.start', {
        transferId,
        serverId: 'srv_1',
        path: 'mods/liar.jar',
        size: 1000,
        chunkSize: 1024,
        compression: 'none',
      });
      const sender = new TransferSender({
        transferId,
        chunkSize: 1024,
        windowChunks: 8,
        codec: chunkCodec('none'),
        hash: sha256Hasher,
        sendFrame: (frame) => {
          peer.sendBinary(frame);
        },
      });
      cap.sender = sender;
      const run = sender.run(
        (async function* () {
          await sleep(1);
          yield data;
        })(),
      );
      await Promise.race([run, sleep(500)]).catch(() => undefined);
      await expect(
        peer.request('fs.transfer.done', { transferId, size: 3000, sha256: sender.sha256 }),
      ).rejects.toMatchObject({ code: 'E_TOO_LARGE' });
      await expect(stat(path.join(serverDir, 'mods', 'liar.jar'))).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('au boot, une task laissée en cours est interrompue (E_INTERRUPTED) et ses artefacts nettoyés', async () => {
    const partial = path.join(serversRoot, 'partial.tar.zst.part');
    await writeFile(partial, 'partial');
    const taskId = ulid();
    await writeFile(
      path.join(stateDir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: {
          [taskId]: {
            taskId,
            kind: 'backup.create',
            serverId: 'srv_1',
            status: 'running',
            phase: 'archiving',
            startedAt: Date.now() - 1000,
            updatedAt: Date.now() - 500,
            artifacts: [partial],
            acked: false,
          },
        },
      }),
    );
    const peer = await bootAgent();
    await waitFor(() => cap.failed.length === 1, 10_000);
    expect(cap.failed[0]).toMatchObject({
      taskId,
      kind: 'backup.create',
      error: { code: 'E_INTERRUPTED', retryable: true },
      cancelled: false,
    });
    await expect(stat(partial)).rejects.toThrow();
    expect((await peer.request('task.list', {})).tasks[0]).toMatchObject({
      taskId,
      status: 'failed',
    });
    // Le heartbeat reflète l'absence de task active.
    await waitFor(() => agent!.isConnected, 5000);
  });
});
