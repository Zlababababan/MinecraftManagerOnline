/**
 * Lot 4 — restauration partielle côté panel : `GET …/backups/:id/browse` relaie `backup.browse`
 * tel quel ; `POST …/restore-paths` crée la task (ligne `pre_restore` seulement en place avec
 * sécurité), refuse une seconde task, audite ; un agent N-1 (sans les types) donne un 501 lisible,
 * la task est close en échec et aucune ligne de sauvegarde ne reste « en cours ».
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RequestPayload, ResponsePayload } from '@mmo/protocol';

import {
  connectFakeAgent,
  createTestPanel,
  helloPayload,
  pairPayload,
  setupAdmin,
  type FakeAgent,
  type TestPanel,
} from '../test/helpers.js';

const BROWSE: ResponsePayload<'backup.browse'> = {
  entries: [
    { path: 'world', kind: 'dir', size: 107, files: 2, modifiedAt: 1_787_330_455_000 },
    { path: 'world/region', kind: 'dir', size: 100, files: 1 },
    { path: 'world/level.dat', kind: 'file', size: 7, modifiedAt: 1_787_330_455_000 },
    { path: 'world/region/r.0.0.mca', kind: 'file', size: 100 },
  ],
  totalFiles: 2,
  totalBytes: 107,
  truncated: false,
};

function detected(path: string, name: string) {
  return {
    path,
    name,
    loader: { value: 'vanilla' as const, confidence: 'high' as const, source: 'jar_name' },
    mcVersion: { value: '1.20.1', confidence: 'high' as const, source: 'jar_manifest' },
    maxRamMb: { value: 2048, confidence: 'medium' as const, source: 'run_script' },
    gamePort: 25565,
    eulaAccepted: true,
    launch: { kind: 'jar' as const, jar: 'server.jar' },
    javaRequirement: { majorVersion: 17, strict: false, source: 'table' as const },
    confidence: 'high' as const,
    evidence: [],
  };
}

interface TaskJson {
  id: string;
  kind: string;
  status: string;
  refId: string | null;
}

describe('restauration partielle — routes du panel', () => {
  let panel: TestPanel;
  let admin: string;
  const agents: FakeAgent[] = [];

  beforeEach(async () => {
    panel = await createTestPanel();
    await panel.listen();
    admin = await setupAdmin(panel);
  });
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close().catch(() => undefined);
    await panel.close();
  });

  /** Machine appairée, agent authentifié (N ou N-1), un serveur adopté et une archive connue. */
  async function onlineServer(withHandlers: boolean): Promise<{
    machineId: string;
    serverId: string;
    backupId: string;
    received: {
      browse: RequestPayload<'backup.browse'>[];
      restore: RequestPayload<'backup.restorePaths'>[];
    };
  }> {
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Tour' },
      headers: { cookie: admin },
    });
    const { machine, pairing } = res.json<{
      machine: { id: string };
      pairing: { code: string };
    }>();
    const pairer = await connectFakeAgent(panel.wsUrl);
    const { secret } = await pairer.peer.request('pair.request', pairPayload(pairing.code));
    await pairer.close();

    const a = await connectFakeAgent(panel.wsUrl);
    agents.push(a);
    a.peer.handle('agent.configure', () => ({ applied: true as const }));
    const received = {
      browse: [] as RequestPayload<'backup.browse'>[],
      restore: [] as RequestPayload<'backup.restorePaths'>[],
    };
    if (withHandlers) {
      a.peer.handle('backup.browse', (req) => {
        received.browse.push(req);
        return BROWSE;
      });
      a.peer.handle('backup.restorePaths', (req) => {
        received.restore.push(req);
        return { taskId: req.taskId };
      });
    }
    await a.peer.request(
      'auth.hello',
      helloPayload(machine.id, secret, {
        capabilities: withHandlers
          ? ['rcon', 'tasks', 'backups', 'partial-restore']
          : ['rcon', 'tasks', 'backups'],
      }),
    );
    const { server } = await panel.ctx.servers.adoptDetected(
      machine.id,
      detected('/srv/survie', 'Survie'),
      undefined,
    );
    if (server === undefined) throw new Error('server not adopted');
    const backup = panel.ctx.backups.applyManifest(
      {
        backupId: 'bk_1',
        serverId: server.id,
        kind: 'manual',
        createdAt: 1_787_330_500_000,
        codec: 'gzip',
        archivePath: `/srv/backups/${server.id}/bk_1.tar.gz`,
        sizeBytes: 1234,
        sha256: 'a'.repeat(64),
        files: 2,
        bytesRaw: 107,
        hot: false,
      },
      machine.id,
    );
    return { machineId: machine.id, serverId: server.id, backupId: backup.id, received };
  }

  const restorePaths = (serverId: string, backupId: string, payload: Record<string, unknown>) =>
    panel.app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/backups/${backupId}/restore-paths`,
      payload,
      headers: { cookie: admin },
    });

  it('relaie le parcours de l’archive tel quel (lecture seule)', async () => {
    const { serverId, backupId, received } = await onlineServer(true);
    const res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/backups/${backupId}/browse`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(BROWSE);
    expect(received.browse).toHaveLength(1);
    expect(received.browse[0]).toMatchObject({ serverId, backupId });
    expect(received.browse[0]?.archivePath).toContain('bk_1.tar.gz');
  });

  it('crée la task : côte à côte sans ligne de sécurité, en place avec, une seule à la fois, audit', async () => {
    const { serverId, backupId, received } = await onlineServer(true);
    let res = await restorePaths(serverId, backupId, {
      paths: ['world/region', 'world/region/r.0.0.mca'],
    });
    expect(res.statusCode).toBe(200);
    const task1 = res.json<{ task: TaskJson }>().task;
    expect(task1).toMatchObject({
      kind: 'backup.restorePaths',
      status: 'running',
      refId: backupId,
    });
    expect(received.restore[0]).toMatchObject({
      taskId: task1.id,
      serverId,
      backupId,
      paths: ['world/region', 'world/region/r.0.0.mca'],
      mode: 'side_by_side',
      safetyBackup: false,
      restartAfter: false,
    });
    expect(panel.ctx.backups.list(serverId).filter((b) => b.kind === 'pre_restore')).toHaveLength(
      0,
    );

    // Une seconde demande pendant la première : E_BUSY (503).
    res = await restorePaths(serverId, backupId, { paths: ['world'] });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('E_BUSY');

    // La première se termine (comme l'agent le dirait) ; en place, avec sécurité et relance.
    panel.ctx.tasks.complete(task1.id, {
      backupId,
      mode: 'side_by_side',
      paths: ['world/region'],
      destination: 'restored-20260902-101530',
      files: 1,
      bytes: 100,
      restarted: false,
      wasRunning: true,
    });
    res = await restorePaths(serverId, backupId, {
      paths: ['world'],
      mode: 'in_place',
      safetyBackup: true,
      restartAfter: true,
    });
    expect(res.statusCode).toBe(200);
    const task2 = res.json<{ task: TaskJson }>().task;
    expect(received.restore[1]).toMatchObject({
      taskId: task2.id,
      mode: 'in_place',
      safetyBackup: true,
      restartAfter: true,
      paths: ['world'],
    });
    const safety = panel.ctx.backups.list(serverId).find((b) => b.kind === 'pre_restore');
    expect(safety).toMatchObject({
      status: 'running',
      taskId: task2.id,
      id: received.restore[1]?.safetyBackupId,
    });
    const audit = panel.ctx.audit.list().filter((a) => a.action === 'backup.restorePaths');
    expect(audit).toHaveLength(2);
    expect(
      audit.some(
        (a) =>
          a.targetId === serverId &&
          JSON.stringify(a.details).includes('"mode":"in_place"') &&
          JSON.stringify(a.details).includes('"pathCount":1'),
      ),
    ).toBe(true);
  });

  it('agent N-1 : 501 E_UNSUPPORTED_TYPE sur les deux routes, task close en échec, sécurité non laissée en cours', async () => {
    const { serverId, backupId } = await onlineServer(false);
    let res = await panel.app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/backups/${backupId}/browse`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json<{ code: string }>().code).toBe('E_UNSUPPORTED_TYPE');

    res = await restorePaths(serverId, backupId, { paths: ['world'], mode: 'in_place' });
    expect(res.statusCode).toBe(501);
    expect(res.json<{ code: string }>().code).toBe('E_UNSUPPORTED_TYPE');
    const tasks = panel.ctx.tasks.list({ serverId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'backup.restorePaths', status: 'failed' });
    expect(panel.ctx.backups.list(serverId).find((b) => b.kind === 'pre_restore')).toMatchObject({
      status: 'failed',
    });

    // Corps refusés par le schéma avant tout appel à l'agent.
    for (const payload of [
      { paths: [] },
      { paths: ['../x'] },
      { paths: ['world'], mode: 'nope' },
    ]) {
      res = await restorePaths(serverId, backupId, payload);
      expect(res.statusCode).toBe(400);
    }
  });
});
