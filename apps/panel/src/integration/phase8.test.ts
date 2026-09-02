/**
 * Phase 8 avec panel + agent **réels** in-process : backup manuel (task → table `backups`,
 * diffusion `task.update`/`backup.update`), téléchargement de l'archive et d'un fichier via les
 * transferts binaires, upload, restauration, politiques poussées à l'agent, backup planifié exécuté
 * **agent seul** (panel injoignable) puis synchronisé à la reconnexion, planificateur du panel
 * (`start`, `announce`), `stalled` → réconciliation, `VACUUM INTO` du panel.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BackupBrowseResponse, BackupDto, ServerDto, TaskDto } from '@mmo/protocol/client';

import { Agent } from '../../../agent/src/agent.js';
import { runMaintenance } from '../app.js';
import { Logger } from '../../../agent/src/log.js';
import {
  connectClient,
  createTestPanel,
  freePort,
  setupAdmin,
  sleep,
  tmpDir,
  waitFor,
  type TestPanel,
} from '../test/helpers.js';

const FAKE_SERVER = path.resolve(import.meta.dirname, '../../../agent/test/fake-java-server.mjs');
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface Msg {
  type: string;
  [k: string]: unknown;
}

describe('phase 8 — panel ↔ agent réels', () => {
  let panel: TestPanel;
  let admin: string;
  let stateDir: string;
  let serversRoot: string;
  let dataDir: string;
  let cleanups: (() => Promise<void>)[] = [];
  let agent: Agent | undefined;
  let machineId: string;
  let server: ServerDto;
  let dir: string;
  let pairCode: string;

  beforeEach(async () => {
    const d = await tmpDir('mmo-p8-data-');
    dataDir = d.dir;
    panel = await createTestPanel({
      now: () => Date.now(),
      config: { heartbeatIntervalSec: 1, offlineAfterMs: 10_000, dataDir },
      schedulerTickMs: 0,
      transferReconnectWaitMs: 5000,
    });
    await panel.listen();
    admin = await setupAdmin(panel);
    const s = await tmpDir('mmo-p8-state-');
    const r = await tmpDir('mmo-p8-servers-');
    stateDir = s.dir;
    serversRoot = r.dir;
    cleanups = [s.cleanup, r.cleanup, d.cleanup];

    dir = path.join(serversRoot, 'Survie');
    await mkdir(path.join(dir, 'logs'), { recursive: true });
    await mkdir(path.join(dir, 'world', 'region'), { recursive: true });
    await mkdir(path.join(dir, 'mods'), { recursive: true });
    await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
    await writeFile(
      path.join(dir, 'server.properties'),
      `server-port=${String(await freePort())}\n`,
    );
    await writeFile(path.join(dir, 'server.jar'), '');
    await writeFile(path.join(dir, 'world', 'region', 'r.0.0.mca'), randomBytes(200_000));
    await writeFile(
      path.join(dir, 'logs', 'latest.log'),
      '[10:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.1\n',
    );

    let res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Tour' },
      headers: { cookie: admin },
    });
    const { machine, pairing } = res.json<{ machine: { id: string }; pairing: { code: string } }>();
    machineId = machine.id;
    pairCode = pairing.code;
    await bootAgent();
    await panel.app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/directories`,
      payload: { path: serversRoot },
      headers: { cookie: admin },
    });
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/scan`,
      payload: {},
      headers: { cookie: admin },
    });
    server = res.json<{ servers: ServerDto[] }>().servers[0]!;
    await waitFor(() => agent!.store.get().servers[server.id] !== undefined, 10_000);
    // Recette 1.0 : tout serveur détecté reçoit une politique par défaut (quotidienne, keep 7,
    // si en marche). Vérifiée ici, puis retirée : la suite teste les politiques explicites.
    const seeded = panel.ctx.backups.listPolicies(server.id);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ cron: '0 4 * * *', keepLast: 7, onlyIfRunning: 1 });
    panel.ctx.backups.deletePolicy(seeded[0]!.id);
  });
  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
    await panel.close();
    for (const c of cleanups) await c();
  });

  async function bootAgent(): Promise<void> {
    const rconFrom = await freePort();
    agent = new Agent({
      stateDir,
      panelUrl: `${panel.wsUrl}/ws/agent`,
      pairCode,
      logger: new Logger('agent', { stderr: false }),
      scanIntervalMs: 0,
      trashPurgeIntervalMs: 0,
      metricsIntervalMs: 0,
      backupSchedulerTickMs: 0,
      // Lot 4 : passes déclenchées à la main (`runPass`), toute archive relue à chaque passe.
      backupVerifierTickMs: 0,
      backupVerifier: { recheckAfterMs: 0 },
      saveSettleMs: 200,
      restrictPermissions: false,
      backoff: { baseMs: 50, maxMs: 200 },
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
        rconProbeIntervalMs: 200,
        exitPollMs: 100,
      },
    });
    await agent.start();
    await waitFor(() => panel.ctx.registry.isConnected(machineId), 10_000);
  }

  const api = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    panel.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: { cookie: admin },
    });

  async function waitTask(taskId: string, timeoutMs = 30_000): Promise<TaskDto> {
    await waitFor(() => {
      const t = panel.ctx.tasks.get(taskId);
      return (
        t !== undefined &&
        t.status !== 'pending' &&
        t.status !== 'running' &&
        t.status !== 'stalled'
      );
    }, timeoutMs);
    return panel.ctx.tasks.toDto(panel.ctx.tasks.require(taskId));
  }

  it('backup manuel → table + WS, téléchargement vérifié, restauration, suppression', async () => {
    const client = await connectClient(panel.wsUrl, admin);
    const msgs = client.messages as Msg[];
    await api('POST', `/api/servers/${server.id}/start`);
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'running', 15_000);

    let res = await api('POST', `/api/servers/${server.id}/backups`, { comment: 'avant modpack' });
    expect(res.statusCode).toBe(200);
    const created = res.json<{ task: TaskDto; backup: BackupDto }>();
    expect(created.task).toMatchObject({
      kind: 'backup.create',
      status: 'running',
      refId: created.backup.id,
    });
    expect(created.backup).toMatchObject({
      status: 'running',
      kind: 'manual',
      comment: 'avant modpack',
    });
    // Une seconde demande pendant la première est refusée (E_BUSY).
    res = await api('POST', `/api/servers/${server.id}/backups`, {});
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('E_BUSY');

    const task = await waitTask(created.task.id);
    expect(task.status).toBe('done');
    expect(task.progress).toBe(100);
    const backup = panel.ctx.backups.toDto(panel.ctx.backups.require(created.backup.id));
    expect(backup).toMatchObject({ status: 'success', hot: true, taskId: created.task.id });
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(backup.archivePath).toContain(server.id);
    // Diffusion temps réel : progression puis issue, backup.update success.
    await waitFor(() =>
      msgs.some((m) => m.type === 'backup.update' && (m.backup as BackupDto).status === 'success'),
    );
    const updates = msgs.filter((m) => m.type === 'task.update').map((m) => m.task as TaskDto);
    expect(updates.some((t) => t.status === 'running' && t.phase === 'archiving')).toBe(true);
    expect(updates.at(-1)?.status).toBe('done');
    expect(panel.ctx.events.list({ serverId: server.id, type: 'task.completed' })).toHaveLength(1);
    // L'agent a été acquitté : la task a quitté son journal.
    await waitFor(() => agent!.tasks.journal.get(created.task.id) === undefined);

    res = await api('GET', `/api/servers/${server.id}/backups`);
    expect(res.json<{ backups: BackupDto[] }>().backups.map((b) => b.id)).toEqual([backup.id]);

    // Téléchargement de l'archive via le transfert binaire : taille et sha256 du manifeste.
    res = await api('GET', `/api/servers/${server.id}/backups/${backup.id}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(backup.sizeBytes));
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(sha256(res.rawPayload)).toBe(backup.sha256);

    // Téléchargement d'un fichier du serveur.
    const region = await readFile(path.join(dir, 'world', 'region', 'r.0.0.mca'));
    res = await api('GET', `/api/servers/${server.id}/files/download?path=world/region/r.0.0.mca`);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(region)).toBe(true);
    expect(panel.ctx.transfers.activeCount).toBe(0);

    // Upload d'un fichier (corps binaire brut).
    const jar = randomBytes(300_000);
    res = await panel.app.inject({
      method: 'PUT',
      url: `/api/servers/${server.id}/files/upload?path=mods/new.jar&size=${String(jar.byteLength)}`,
      payload: jar,
      headers: { cookie: admin, 'content-type': 'application/octet-stream' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ sha256: string; size: number }>()).toEqual({
      sha256: sha256(jar),
      size: jar.byteLength,
    });
    expect((await readFile(path.join(dir, 'mods', 'new.jar'))).equals(jar)).toBe(true);
    expect(panel.ctx.events.list({ serverId: server.id, type: 'server.fileChanged' })).toHaveLength(
      1,
    );

    // Restauration 1 clic : le monde modifié revient, backup de sécurité enregistré, serveur relancé.
    await writeFile(path.join(dir, 'world', 'region', 'r.0.0.mca'), randomBytes(10));
    res = await api('POST', `/api/servers/${server.id}/backups/${backup.id}/restore`, {
      restartAfter: true,
    });
    expect(res.statusCode).toBe(200);
    const restoreTask = await waitTask(res.json<{ task: TaskDto }>().task.id, 40_000);
    expect(restoreTask.status).toBe('done');
    expect(restoreTask.result).toMatchObject({
      backupId: backup.id,
      restarted: true,
      wasRunning: true,
    });
    expect((await readFile(path.join(dir, 'world', 'region', 'r.0.0.mca'))).equals(region)).toBe(
      true,
    );
    const all = panel.ctx.backups.list(server.id).map((b) => panel.ctx.backups.toDto(b));
    const safety = all.find((b) => b.kind === 'pre_restore');
    expect(safety).toMatchObject({ status: 'success', taskId: restoreTask.id });
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'running', 15_000);

    // Suppression : disque + table.
    res = await api('DELETE', `/api/servers/${server.id}/backups/${safety!.id}`);
    expect(res.json<{ deleted: boolean }>().deleted).toBe(true);
    expect(panel.ctx.backups.require(safety!.id).status).toBe('deleted');
    client.close();
  });

  it('politique poussée à l’agent ; backup planifié exécuté sans panel puis synchronisé ; rotation', async () => {
    let res = await api('POST', `/api/servers/${server.id}/backup-policies`, {
      cron: '* * * * *',
      keepLast: 1,
    });
    expect(res.statusCode).toBe(200);
    const policy = res.json<{ policy: { id: string; nextRunAt: number } }>().policy;
    expect(policy.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    await waitFor(() => agent!.store.get().backupSchedules.length === 1, 5000);
    expect(agent!.store.get().backupSchedules[0]).toMatchObject({ id: policy.id, keep: 1 });
    res = await api('POST', `/api/servers/${server.id}/backup-policies`, { cron: 'pas valide' });
    expect(res.statusCode).toBe(400);

    // Panel injoignable : l'agent est arrêté… mais son planificateur local tourne dans la vraie vie
    // sans panel. On le rejoue ici : agent à l'arrêt, tick en mode autonome via une instance neuve
    // non connectée (panel fermé pour lui), puis reconnexion.
    await agent!.stop();
    panel.ctx.registry.closeAll();
    // URL de panel injoignable (port 1) : l'instance reste hors ligne quoi qu'il arrive, le
    // résultat est journalisé dans l'état et rejoué par l'agent suivant.
    const offline = new Agent({
      stateDir,
      panelUrl: 'ws://127.0.0.1:1/ws/agent',
      backoff: { baseMs: 50, maxMs: 100 },
      logger: new Logger('agent-offline', { stderr: false }),
      scanIntervalMs: 0,
      trashPurgeIntervalMs: 0,
      metricsIntervalMs: 0,
      backupSchedulerTickMs: 0,
      manager: {
        javaResolver: () =>
          Promise.resolve({
            majorVersion: 17,
            vendor: 'fake',
            path: process.execPath,
            managed: false,
          }),
        totalRamMb: () => 16_384,
      },
    });
    await offline.start();
    const started = await offline.backupScheduler.tick();
    expect(started).toHaveLength(1);
    await offline.tasks.wait(started[0]!);
    expect(offline.tasks.journal.get(started[0]!)?.status).toBe('done');
    await offline.stop();
    expect(panel.ctx.tasks.get(started[0]!)).toBeUndefined();

    // Reconnexion : le résultat rejoué crée la task et la ligne backup (kind scheduled).
    await bootAgent();
    await waitFor(() => panel.ctx.tasks.get(started[0]!)?.status === 'done', 10_000);
    const scheduled = panel.ctx.backups.list(server.id).map((b) => panel.ctx.backups.toDto(b));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      kind: 'scheduled',
      policyId: policy.id,
      status: 'success',
      hot: false,
    });

    // Seconde occurrence forcée → rotation (keep 1) → backup.rotated → ancienne ligne `deleted`.
    await agent!.store.update((s) => {
      s.backupScheduleRuns = {};
    });
    const second = await agent!.backupScheduler.tick();
    expect(second).toHaveLength(1);
    await waitTask(second[0]!);
    await waitFor(() => panel.ctx.backups.require(scheduled[0]!.id).status === 'deleted', 10_000);
    expect(panel.ctx.backups.list(server.id).filter((b) => b.status === 'success')).toHaveLength(1);
    expect(panel.ctx.events.list({ serverId: server.id, type: 'backup.rotated' })).toHaveLength(1);

    // Preuve d'exécution : la politique porte désormais l'issue de sa dernière occurrence.
    // Sans ces colonnes, une politique morte affichait exactement la même chose qu'une saine.
    const ran = panel.ctx.backups.getPolicy(policy.id);
    expect(ran?.lastStatus).toBe('success');
    expect(ran?.lastRunAt).toBeGreaterThan(0);
    expect(ran?.lastBackupId).toBeTruthy();
    expect(ran?.overdueSince).toBeNull();

    // Retard : on recule la dernière exécution bien au-delà de la tolérance de 2 h. La maintenance
    // publie UN événement et pose le marqueur ; un second passage ne réalerte pas.
    panel.ctx.backups.recordPolicyRun(policy.id, {
      status: 'success',
      at: Date.now() - 48 * 3_600_000,
      backupId: 'bk_ancien',
    });
    runMaintenance(panel.ctx);
    runMaintenance(panel.ctx);
    const overdue = panel.ctx.events.list({ serverId: server.id, type: 'backup.overdue' });
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.severity).toBe('warning');
    expect(panel.ctx.backups.getPolicy(policy.id)?.overdueSince).toBeGreaterThan(0);

    // Une occurrence « ignorée » prouve elle aussi que le planning tourne : elle lève le retard.
    panel.ctx.backups.recordPolicyRun(policy.id, {
      status: 'skipped',
      at: Date.now(),
      reason: 'server_stopped',
    });
    const cleared = panel.ctx.backups.getPolicy(policy.id);
    expect(cleared?.overdueSince).toBeNull();
    expect(cleared?.lastStatus).toBe('skipped');
    runMaintenance(panel.ctx);
    expect(panel.ctx.events.list({ serverId: server.id, type: 'backup.overdue' })).toHaveLength(1);

    // Suppression de la politique : l'agent n'a plus de planning.
    res = await api('DELETE', `/api/servers/${server.id}/backup-policies/${policy.id}`);
    expect(res.statusCode).toBe(200);
    await waitFor(() => agent!.store.get().backupSchedules.length === 0, 5000);
  });

  it('lot 4 : vérification des archives — manifeste réinscrit, archive altérée → corrompue une seule fois, rattrapage par backup.list', async () => {
    const res = await api('POST', `/api/servers/${server.id}/backups`, { comment: 'à vérifier' });
    expect(res.statusCode).toBe(200);
    const created = res.json<{ task: TaskDto; backup: BackupDto }>();
    expect((await waitTask(created.task.id)).status).toBe('done');
    const fresh = panel.ctx.backups.toDto(panel.ctx.backups.require(created.backup.id));
    expect(fresh).toMatchObject({ status: 'success', verifiedAt: null, verifyStatus: null });
    const archivePath = fresh.archivePath!;
    const manifestFile = path.join(path.dirname(archivePath), `${created.backup.id}.json`);

    // Première passe : archive saine → verdict dans le manifeste ET dans la table (backup.verified).
    let pass = await agent!.backupVerifier.runPass();
    expect(pass).toMatchObject({ verified: 1, corrupted: 0, busy: 0 });
    await waitFor(() => panel.ctx.backups.require(created.backup.id).verifyStatus === 'ok', 10_000);
    const ok = panel.ctx.backups.toDto(panel.ctx.backups.require(created.backup.id));
    expect(ok.verifiedAt).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(manifestFile, 'utf8'))).toMatchObject({
      verifyStatus: 'ok',
      verifiedAt: ok.verifiedAt,
    });
    expect(panel.ctx.events.list({ serverId: server.id, type: 'backup.corrupted' })).toHaveLength(
      0,
    );

    // Archive altérée sur le disque : la passe suivante la déclare corrompue, UN événement,
    // notification qui nomme le serveur et le fichier.
    await appendFile(archivePath, Buffer.from('octets en trop'));
    pass = await agent!.backupVerifier.runPass();
    expect(pass).toMatchObject({ verified: 0, corrupted: 1 });
    await waitFor(
      () => panel.ctx.backups.require(created.backup.id).verifyStatus === 'corrupted',
      10_000,
    );
    let corrupted = panel.ctx.events.list({ serverId: server.id, type: 'backup.corrupted' });
    expect(corrupted).toHaveLength(1);
    expect(corrupted[0]).toMatchObject({ severity: 'error', machineId });
    expect(corrupted[0]?.payload).toMatchObject({ backupId: created.backup.id, path: archivePath });
    const text = panel.ctx.notifications.render(corrupted[0]!, 'fr');
    expect(text?.title).toBe('Sauvegarde corrompue : Survie');
    expect(text?.body).toContain(created.backup.id);

    // Une archive corrompue n'est plus relue, et le panel ne republie pas.
    pass = await agent!.backupVerifier.runPass();
    expect(pass).toMatchObject({ verified: 0, corrupted: 0 });
    expect(panel.ctx.events.list({ serverId: server.id, type: 'backup.corrupted' })).toHaveLength(
      1,
    );

    // Restaurer quand même : refusé avant de toucher au serveur (E_CHECKSUM_MISMATCH). Cette
    // relecture est un second verdict « corrompue » (backup.verified) : la date de vérification
    // avance, l'événement n'est PAS republié — une archive n'est déclarée corrompue qu'une fois.
    const firstVerdictAt = panel.ctx.backups.require(created.backup.id).verifiedAt!;
    await sleep(5);
    const restoreRes = await api(
      'POST',
      `/api/servers/${server.id}/backups/${created.backup.id}/restore`,
      { safetyBackup: false },
    );
    expect(restoreRes.statusCode, restoreRes.body).toBe(200);
    const restoreTask = await waitTask(restoreRes.json<{ task: TaskDto }>().task.id);
    expect(restoreTask.status).toBe('failed');
    expect(JSON.stringify(restoreTask.error)).toContain('E_CHECKSUM_MISMATCH');
    await waitFor(
      () => panel.ctx.backups.require(created.backup.id).verifiedAt! > firstVerdictAt,
      10_000,
    );
    expect(panel.ctx.backups.require(created.backup.id).verifyStatus).toBe('corrupted');
    expect(panel.ctx.events.list({ serverId: server.id, type: 'backup.corrupted' })).toHaveLength(
      1,
    );

    // Reconnexion : `backup.list` relit le manifeste — même verdict, rien de nouveau.
    await agent!.stop();
    await bootAgent();
    await sleep(500);
    expect(panel.ctx.backups.require(created.backup.id).verifyStatus).toBe('corrupted');
    expect(panel.ctx.events.list({ serverId: server.id, type: 'backup.corrupted' })).toHaveLength(
      1,
    );

    // Verdict perdu côté panel (backup.verified est non critique) : le manifeste le rétablit à la
    // reconnexion suivante, et c'est alors la première fois que le panel l'apprend → événement.
    panel.ctx.sqlite
      .prepare('UPDATE backups SET verified_at = NULL, verify_status = NULL WHERE id = ?')
      .run(created.backup.id);
    await agent!.stop();
    await bootAgent();
    await waitFor(
      () => panel.ctx.backups.require(created.backup.id).verifyStatus === 'corrupted',
      15_000,
    );
    corrupted = panel.ctx.events.list({ serverId: server.id, type: 'backup.corrupted' });
    expect(corrupted).toHaveLength(2);
    expect(panel.ctx.backups.require(created.backup.id).verifiedAt).toBeGreaterThan(0);
  });

  it('lot 4 : restauration partielle — parcours de l’archive, côte à côte sans arrêt, en place avec sécurité, refus', async () => {
    await api('POST', `/api/servers/${server.id}/start`);
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'running', 15_000);
    await writeFile(path.join(dir, 'mods', 'a.jar'), 'jar-a');
    let res = await api('POST', `/api/servers/${server.id}/backups`, {});
    const created = res.json<{ task: TaskDto; backup: BackupDto }>();
    expect((await waitTask(created.task.id)).status).toBe('done');
    const backup = created.backup;
    const region = await readFile(path.join(dir, 'world', 'region', 'r.0.0.mca'));

    // Parcours relayé tel quel : dossiers agrégés, fichiers listés.
    res = await api('GET', `/api/servers/${server.id}/backups/${backup.id}/browse`);
    expect(res.statusCode).toBe(200);
    const browsed = res.json<BackupBrowseResponse>();
    expect(browsed.entries.find((e) => e.path === 'world')).toMatchObject({ kind: 'dir' });
    expect(browsed.entries.find((e) => e.path === 'mods/a.jar')).toMatchObject({
      kind: 'file',
      size: 5,
    });
    expect(browsed.truncated).toBe(false);

    // Côte à côte (défaut) : le serveur tourne toujours, rien n'est remplacé, pas de sécurité.
    await writeFile(path.join(dir, 'mods', 'a.jar'), 'jar-a-2');
    res = await api('POST', `/api/servers/${server.id}/backups/${backup.id}/restore-paths`, {
      paths: ['mods'],
    });
    expect(res.statusCode).toBe(200);
    let task = await waitTask(res.json<{ task: TaskDto }>().task.id);
    expect(task.status).toBe('done');
    expect(task.result).toMatchObject({
      mode: 'side_by_side',
      paths: ['mods'],
      files: 1,
      restarted: false,
    });
    const destination = (task.result as { destination: string }).destination;
    expect(destination).toMatch(/^restored-\d{8}-\d{6}$/);
    expect(await readFile(path.join(dir, destination, 'mods', 'a.jar'), 'utf8')).toBe('jar-a');
    expect(await readFile(path.join(dir, 'mods', 'a.jar'), 'utf8')).toBe('jar-a-2');
    expect(panel.ctx.servers.require(server.id).runState).toBe('running');
    expect(panel.ctx.backups.list(server.id).filter((b) => b.kind === 'pre_restore')).toHaveLength(
      0,
    );

    // En place : sécurité enregistrée, dossier remplacé, serveur arrêté puis relancé.
    await writeFile(path.join(dir, 'world', 'region', 'r.0.0.mca'), randomBytes(10));
    res = await api('POST', `/api/servers/${server.id}/backups/${backup.id}/restore-paths`, {
      paths: ['world/region'],
      mode: 'in_place',
      restartAfter: true,
    });
    expect(res.statusCode).toBe(200);
    task = await waitTask(res.json<{ task: TaskDto }>().task.id, 40_000);
    expect(task.status).toBe('done');
    expect(task.result).toMatchObject({
      mode: 'in_place',
      paths: ['world/region'],
      restarted: true,
      wasRunning: true,
    });
    expect((await readFile(path.join(dir, 'world', 'region', 'r.0.0.mca'))).equals(region)).toBe(
      true,
    );
    const safety = panel.ctx.backups
      .list(server.id)
      .map((b) => panel.ctx.backups.toDto(b))
      .find((b) => b.kind === 'pre_restore');
    expect(safety).toMatchObject({
      status: 'success',
      taskId: task.id,
      comment: `before partial restore of ${backup.id}`,
    });
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'running', 15_000);
    expect(
      panel.ctx.events
        .list({ serverId: server.id, type: 'task.completed' })
        .some((e) => JSON.stringify(e.payload).includes('"kind":"backup.restorePaths"')),
    ).toBe(true);
    expect(
      panel.ctx.audit
        .list()
        .some((a) => a.action === 'backup.restorePaths' && a.targetId === server.id),
    ).toBe(true);

    // Chemin réservé : 400 immédiat, aucune task ni ligne de sauvegarde laissée en cours.
    const before = panel.ctx.tasks.list({ serverId: server.id }).length;
    res = await api('POST', `/api/servers/${server.id}/backups/${backup.id}/restore-paths`, {
      paths: ['logs/latest.log'],
      mode: 'in_place',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string; details: { reason?: string } }>()).toMatchObject({
      code: 'E_INVALID_PAYLOAD',
      details: { reason: 'RESERVED_PATH' },
    });
    const after = panel.ctx.tasks.list({ serverId: server.id });
    expect(after).toHaveLength(before + 1);
    expect(after.find((t) => t.status === 'running' || t.status === 'pending')).toBeUndefined();
    expect(panel.ctx.backups.list(server.id).find((b) => b.status === 'running')).toBeUndefined();
  });

  it('planificateur du panel : start programmé, annonce, avertissement avant stop, CRUD', async () => {
    let res = await api('POST', `/api/servers/${server.id}/schedules`, {
      action: 'start',
      cron: '*/5 * * * *',
    });
    expect(res.statusCode).toBe(200);
    const startSchedule = res.json<{ schedule: { id: string; nextRunAt: number } }>().schedule;
    expect(startSchedule.nextRunAt).toBeGreaterThan(Date.now());
    res = await api('POST', `/api/servers/${server.id}/schedules`, {
      action: 'command',
      cron: '* * * * *',
    });
    expect(res.statusCode).toBe(400); // commande requise

    // Échéance forcée dans le passé → le tick démarre le serveur et journalise l'exécution.
    panel.ctx.db.run(
      (await import('drizzle-orm'))
        .sql`UPDATE scheduled_tasks SET next_run_at = ${Date.now() - 1000} WHERE id = ${startSchedule.id}`,
    );
    expect(await panel.ctx.scheduler.tick()).toEqual([startSchedule.id]);
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'running', 15_000);
    const after = panel.ctx.scheduler.toDto(panel.ctx.scheduler.require(startSchedule.id));
    expect(after.lastStatus).toBe('ok');
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    expect(panel.ctx.events.list({ serverId: server.id, type: 'schedule.run' })).toHaveLength(1);

    // Stop programmé avec avertissement 1 min avant : à T-60 s le `say` part, à T le stop.
    res = await api('POST', `/api/servers/${server.id}/schedules`, {
      action: 'stop',
      cron: '0 4 * * *',
      payload: { warnMinutes: [1], message: 'Arrêt dans {minutes} min' },
    });
    const stopSchedule = res.json<{ schedule: { id: string } }>().schedule;
    const due = Date.now() + 60_000 - 5000; // dans 55 s : la fenêtre d'avertissement 1 min est ouverte
    panel.ctx.db.run(
      (await import('drizzle-orm'))
        .sql`UPDATE scheduled_tasks SET next_run_at = ${due} WHERE id = ${stopSchedule.id}`,
    );
    expect(await panel.ctx.scheduler.tick()).toEqual([]);
    await sleep(300);
    const log = await readFile(path.join(dir, 'logs', 'latest.log'), 'utf8').catch(() => '');
    const proc = agent!.manager.get(server.id)!;
    const lines = proc.buffer
      .since(0)
      .lines.map((l) => l.text)
      .join('\n');
    expect(lines + log).toContain('Arrêt dans 1 min');
    // Pas de doublon au tick suivant.
    expect(await panel.ctx.scheduler.tick()).toEqual([]);
    expect((lines.match(/Arrêt dans 1 min/g) ?? []).length).toBe(1);

    res = await api('PUT', `/api/servers/${server.id}/schedules/${stopSchedule.id}`, {
      enabled: false,
    });
    expect(
      res.json<{ schedule: { enabled: boolean; nextRunAt: number | null } }>().schedule,
    ).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    res = await api('GET', '/api/schedules');
    expect(res.json<{ schedules: unknown[] }>().schedules).toHaveLength(2);
    res = await api('DELETE', `/api/servers/${server.id}/schedules/${stopSchedule.id}`);
    expect(res.statusCode).toBe(200);
    expect(panel.ctx.scheduler.list(server.id)).toHaveLength(1);
  });

  it('planificateur v2 : multi-horaires, exécution unique, occurrence manquée', async () => {
    // Validation : cron/runAt mutuellement exclusifs, runAt passé et expression invalide refusés.
    let res = await api('POST', `/api/servers/${server.id}/schedules`, {
      action: 'start',
      cron: '0 8 * * *',
      runAt: Date.now() + 3_600_000,
    });
    expect(res.statusCode).toBe(400);
    res = await api('POST', `/api/servers/${server.id}/schedules`, { action: 'start' });
    expect(res.statusCode).toBe(400);
    res = await api('POST', `/api/servers/${server.id}/schedules`, {
      action: 'start',
      runAt: Date.now() - 1000,
    });
    expect(res.statusCode).toBe(400);
    res = await api('POST', `/api/servers/${server.id}/schedules`, {
      action: 'start',
      cron: '0 8 * * *\npas du cron',
    });
    expect(res.statusCode).toBe(400);

    // Multi-horaires : une expression par ligne, prochaine échéance = minimum des trois.
    res = await api('POST', `/api/servers/${server.id}/schedules`, {
      action: 'start',
      cron: '0 8 * * *\n30 12 * * *\n0 20 * * *',
    });
    expect(res.statusCode).toBe(200);
    interface Sched {
      id: string;
      cron: string | null;
      runAt: number | null;
      enabled: boolean;
      nextRunAt: number | null;
      lastStatus: string | null;
    }
    const multi = res.json<{ schedule: Sched }>().schedule;
    expect(multi.cron).toBe('0 8 * * *\n30 12 * * *\n0 20 * * *');
    expect(multi.runAt).toBeNull();
    expect(multi.nextRunAt).toBeGreaterThan(Date.now() - 60_000);
    const nd = new Date(multi.nextRunAt ?? 0);
    expect(['8:0', '12:30', '20:0']).toContain(
      `${String(nd.getHours())}:${String(nd.getMinutes())}`,
    );

    // Exécution unique : nextRunAt = runAt, cron null ; échéance forcée à l'instant → exécutée
    // (le serveur démarre) puis désactivée sans réarmement.
    const runAt = Date.now() + 3_600_000;
    res = await api('POST', `/api/servers/${server.id}/schedules`, { action: 'start', runAt });
    expect(res.statusCode).toBe(200);
    const once = res.json<{ schedule: Sched }>().schedule;
    expect(once.cron).toBeNull();
    expect(once.runAt).toBe(runAt);
    expect(once.nextRunAt).toBe(runAt);
    const { sql } = await import('drizzle-orm');
    panel.ctx.db.run(
      sql`UPDATE scheduled_tasks SET run_at = ${Date.now() - 1000}, next_run_at = ${Date.now() - 1000} WHERE id = ${once.id}`,
    );
    expect(await panel.ctx.scheduler.tick()).toEqual([once.id]);
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'running', 15_000);
    const done = panel.ctx.scheduler.toDto(panel.ctx.scheduler.require(once.id));
    expect(done.lastStatus).toBe('ok');
    expect(done.enabled).toBe(false);
    expect(done.nextRunAt).toBeNull();
    expect(await panel.ctx.scheduler.tick()).toEqual([]);

    // Réarmement : fournir un nouveau runAt à l'update réactive la tâche.
    const runAt2 = Date.now() + 7_200_000;
    res = await api('PUT', `/api/servers/${server.id}/schedules/${once.id}`, { runAt: runAt2 });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ schedule: Sched }>().schedule).toMatchObject({
      enabled: true,
      runAt: runAt2,
      nextRunAt: runAt2,
    });

    // Occurrence manquée (retard > tolérance) : jamais exécutée, `missed` définitif, événement
    // d'avertissement (→ notification schedule.failed).
    panel.ctx.db.run(
      sql`UPDATE scheduled_tasks SET run_at = ${Date.now() - 11 * 60_000}, next_run_at = ${Date.now() - 11 * 60_000} WHERE id = ${once.id}`,
    );
    expect(await panel.ctx.scheduler.tick()).toEqual([]);
    const missed = panel.ctx.scheduler.toDto(panel.ctx.scheduler.require(once.id));
    expect(missed.lastStatus).toBe('missed');
    expect(missed.enabled).toBe(false);
    expect(missed.nextRunAt).toBeNull();
    const warned = panel.ctx.events
      .list({ serverId: server.id, type: 'schedule.run' })
      .filter((e) => e.severity === 'warning')
      .map((e) => e.payload as { scheduleId?: string; status?: string });
    expect(warned.some((p) => p.scheduleId === once.id && p.status === 'missed')).toBe(true);
    // Et re-tick : une tâche manquée reste manquée.
    expect(await panel.ctx.scheduler.tick()).toEqual([]);
    expect(panel.ctx.scheduler.toDto(panel.ctx.scheduler.require(once.id)).lastStatus).toBe(
      'missed',
    );
  });

  it('agent perdu pendant une task → stalled, puis réconciliation à la reconnexion ; VACUUM INTO', async () => {
    // Task fantôme côté panel (ordre jamais parvenu à l'agent) : inconnue de l'agent → E_INTERRUPTED.
    panel.ctx.tasks.create({
      id: '01J5X8ZK3Q9WYE2R7M4T6B8N9Z',
      kind: 'backup.create',
      machineId,
      serverId: server.id,
    });
    panel.ctx.tasks.markRunning('01J5X8ZK3Q9WYE2R7M4T6B8N9Z');
    panel.ctx.registry.require(machineId).close(4000, 'test');
    await waitFor(() => !panel.ctx.registry.isConnected(machineId));
    expect(panel.ctx.tasks.require('01J5X8ZK3Q9WYE2R7M4T6B8N9Z').status).toBe('stalled');
    await waitFor(() => panel.ctx.registry.isConnected(machineId), 10_000);
    await waitFor(
      () => panel.ctx.tasks.require('01J5X8ZK3Q9WYE2R7M4T6B8N9Z').status === 'failed',
      10_000,
    );
    const ghost = panel.ctx.tasks.toDto(panel.ctx.tasks.require('01J5X8ZK3Q9WYE2R7M4T6B8N9Z'));
    expect(ghost.error?.code).toBe('E_INTERRUPTED');

    // Sauvegarde du panel lui-même.
    let res = await api('POST', '/api/admin/backups');
    expect(res.statusCode).toBe(200);
    const { backup } = res.json<{ backup: { file: string; sizeBytes: number } }>();
    // Lot 4 : une archive (base + tls/ + manifeste), plus une copie .db nue.
    expect(backup.file).toMatch(/^mmo-panel-.*\.tar\.gz$/);
    const copy = path.join(dataDir, 'backups', 'panel', backup.file);
    expect((await stat(copy)).size).toBe(backup.sizeBytes);
    expect(backup.sizeBytes).toBeGreaterThan(0);
    res = await api('GET', '/api/admin/backups');
    expect(res.json<{ backups: { file: string }[] }>().backups.map((b) => b.file)).toEqual([
      backup.file,
    ]);
    expect(await readdir(path.join(dataDir, 'backups', 'panel'))).toEqual([backup.file]);
  });
});
