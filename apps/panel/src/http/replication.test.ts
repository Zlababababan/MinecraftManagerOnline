/**
 * Lot 4 — réplication hors-site côté panel, avec deux faux agents : réglage (machine différente et
 * connue), copie automatique après une sauvegarde réussie (sources = listener direct de la source
 * puis relais panel, `keep` de la destination), issue de la task (copie saine ; copies rotées →
 * `deleted` ; échec → `failed`), rapatriement (la fiche redevient saine sur la machine du serveur),
 * suppression de l'original qui emporte ses copies, agent sans la capacité → 501 lisible,
 * réconciliation et rattrapage à la reconnexion de la destination.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ulid,
  type BackupManifest,
  type BackupReceiveResult,
  type RequestPayload,
} from '@mmo/protocol';
import type { BackupDto, BackupReplicaDto, ReplicationDto } from '@mmo/protocol/client';

import {
  connectFakeAgent,
  createTestPanel,
  helloPayload,
  pairPayload,
  setupAdmin,
  waitFor,
  type FakeAgent,
  type TestPanel,
} from '../test/helpers.js';

interface Machine {
  id: string;
  agent: FakeAgent;
  received: {
    create: RequestPayload<'backup.create'>[];
    receive: RequestPayload<'backup.receive'>[];
    serve: RequestPayload<'transfer.serve'>[];
    deleted: RequestPayload<'backup.delete'>[];
  };
  /** Ce que `backup.list` répond (copies présentes sur son disque). */
  manifests: BackupManifest[];
}

interface BackupsJson {
  backups: BackupDto[];
  replication: ReplicationDto | null;
  replicas: BackupReplicaDto[];
}

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

const SHA = 'a'.repeat(64);

describe('réplication hors-site — routes et service du panel', () => {
  let panel: TestPanel;
  let admin: string;
  const agents: FakeAgent[] = [];

  beforeEach(async () => {
    panel = await createTestPanel({ migrationTtlMs: 60_000 });
    await panel.listen();
    admin = await setupAdmin(panel);
  });
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close().catch(() => undefined);
    await panel.close();
  });

  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    panel.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      headers: { cookie: admin },
    });

  /** Machine appairée, agent authentifié ; `replication` dans les capacités = handler `backup.receive`. */
  async function online(name: string, capabilities: string[]): Promise<Machine> {
    const res = await api('POST', '/api/machines', { name });
    const { machine, pairing } = res.json<{ machine: { id: string }; pairing: { code: string } }>();
    const pairer = await connectFakeAgent(panel.wsUrl);
    const { secret } = await pairer.peer.request('pair.request', pairPayload(pairing.code));
    await pairer.close();
    const a = await connectFakeAgent(panel.wsUrl);
    agents.push(a);
    const m: Machine = {
      id: machine.id,
      agent: a,
      received: { create: [], receive: [], serve: [], deleted: [] },
      manifests: [],
    };
    a.peer.handle('agent.configure', () => ({ applied: true as const }));
    a.peer.handle('event.ack', () => ({}));
    a.peer.handle('task.ackResult', () => ({}));
    a.peer.handle('task.list', () => ({ tasks: [] }));
    a.peer.handle('backup.list', () => ({ backups: m.manifests }));
    a.peer.handle('backup.create', (req) => {
      m.received.create.push(req);
      return { taskId: req.taskId, backupId: req.backupId ?? 'bk_x' };
    });
    a.peer.handle('backup.delete', (req) => {
      m.received.deleted.push(req);
      return { deleted: true };
    });
    a.peer.handle('transfer.serve', (req) => {
      m.received.serve.push(req);
      return {
        urls: [`http://127.0.0.1:1/${req.token}`],
        size: 1234,
        sha256: SHA,
        expiresAt: Date.now() + 60_000,
      };
    });
    if (capabilities.includes('replication')) {
      a.peer.handle('backup.receive', (req) => {
        m.received.receive.push(req);
        return { taskId: req.taskId };
      });
    }
    await a.peer.request('auth.hello', helloPayload(machine.id, secret, { capabilities }));
    return m;
  }

  const CAPS = ['rcon', 'tasks', 'backups', 'transfers', 'migration', 'replication'];

  async function adopt(machineId: string): Promise<string> {
    const { server } = await panel.ctx.servers.adoptDetected(
      machineId,
      detected('/srv/survie', 'Survie'),
      undefined,
    );
    if (server === undefined) throw new Error('server not adopted');
    return server.id;
  }

  /** Une sauvegarde manuelle lancée par l'API puis terminée par le faux agent source. */
  async function backupOn(source: Machine, serverId: string, backupId?: string): Promise<string> {
    const res = await api('POST', `/api/servers/${serverId}/backups`, { comment: 'nuit' });
    expect(res.statusCode, res.body).toBe(200);
    const { task, backup } = res.json<{ task: { id: string }; backup: { id: string } }>();
    const id = backupId ?? backup.id;
    const req = source.received.create.find((r) => r.taskId === task.id);
    expect(req).toBeDefined();
    source.agent.peer.emit('task.completed', {
      eventId: ulid(),
      taskId: task.id,
      kind: 'backup.create',
      serverId,
      startedAt: Date.now() - 50,
      finishedAt: Date.now(),
      result: {
        backupId: backup.id,
        serverId,
        kind: 'manual',
        createdAt: Date.now(),
        codec: 'gzip',
        archivePath: `/tour/backups/${serverId}/${backup.id}.tar.gz`,
        sizeBytes: 1234,
        sha256: SHA,
        files: 2,
        bytesRaw: 107,
        hot: false,
        comment: 'nuit',
        durationMs: 5,
      },
    });
    await waitFor(() => panel.ctx.backups.get(backup.id)?.status === 'success', 5_000);
    return id;
  }

  const finishReceive = (
    holder: Machine,
    req: RequestPayload<'backup.receive'>,
    extra: Partial<BackupReceiveResult> = {},
  ) => {
    holder.agent.peer.emit('task.completed', {
      eventId: ulid(),
      taskId: req.taskId,
      kind: 'backup.receive',
      serverId: req.serverId,
      startedAt: Date.now() - 10,
      finishedAt: Date.now(),
      result: {
        backupId: req.backupId,
        serverId: req.serverId,
        archivePath: `/pi/backups/${req.serverId}/${req.backupId}.tar.gz`,
        sizeBytes: req.manifest.sizeBytes,
        sha256: req.manifest.sha256,
        source: 'direct',
        durationMs: 10,
        rotated: [],
        ...extra,
      } satisfies BackupReceiveResult,
    });
  };

  const replicasOf = (serverId: string) => panel.ctx.replication.replicas(serverId, true);
  const waitReceive = (holder: Machine, count: number) =>
    waitFor(() => holder.received.receive.length >= count, 5_000);

  it('réglage : machine du serveur refusée, inconnue 404, réglage lu avec les sauvegardes', async () => {
    const tour = await online('Tour', CAPS);
    const pi = await online('Pi', CAPS);
    const serverId = await adopt(tour.id);
    const put = (body: Record<string, unknown>) =>
      api('PUT', `/api/servers/${serverId}/replication`, body);
    let res = await put({ machineId: tour.id });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ details: { reason: string } }>().details.reason).toBe('SAME_MACHINE');
    expect((await put({ machineId: 'm_nope' })).statusCode).toBe(404);
    res = await put({ machineId: pi.id, keepLast: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ replication: ReplicationDto }>().replication).toMatchObject({
      serverId,
      machineId: pi.id,
      keepLast: 2,
      enabled: true,
    });
    const listed = (await api('GET', `/api/servers/${serverId}/backups`)).json<BackupsJson>();
    expect(listed.replication).toMatchObject({ machineId: pi.id, keepLast: 2 });
    expect(listed.replicas).toEqual([]);
    res = await put({ machineId: null });
    expect(res.json<{ replication: null }>().replication).toBeNull();
    expect(JSON.stringify(panel.ctx.audit.list())).toContain('backup.replication');
  });

  it('copie automatique après une sauvegarde : sources direct + relais, keep, copie saine, rotation → deleted', async () => {
    const tour = await online('Tour', CAPS);
    const pi = await online('Pi', CAPS);
    const serverId = await adopt(tour.id);
    expect(
      (await api('PUT', `/api/servers/${serverId}/replication`, { machineId: pi.id, keepLast: 2 }))
        .statusCode,
    ).toBe(200);

    const bk1 = await backupOn(tour, serverId);
    await waitReceive(pi, 1);
    const req = pi.received.receive[0];
    expect(req).toMatchObject({ serverId, backupId: bk1, keep: 2 });
    expect(req?.manifest).toMatchObject({
      backupId: bk1,
      sizeBytes: 1234,
      sha256: SHA,
      comment: 'nuit',
    });
    expect(req?.sources.map((s) => s.kind)).toEqual(['direct', 'relay']);
    expect(req?.sources[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:1\//);
    expect(req?.sources[1]?.url).toMatch(/^\/api\/relay\/[0-9a-f]{32}$/);
    expect(tour.received.serve).toHaveLength(1);
    expect(tour.received.serve[0]).toMatchObject({ serverId, backupId: bk1 });
    expect(panel.ctx.relayTokens.size).toBe(1);
    let copies = replicasOf(serverId);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ backupId: bk1, machineId: pi.id, status: 'running' });
    // La même archive ne part pas deux fois vers la même machine.
    expect(
      (await api('POST', `/api/servers/${serverId}/backups/${bk1}/replicate`, {})).statusCode,
    ).toBe(409);

    if (req === undefined) throw new Error('unreachable');
    finishReceive(pi, req);
    await waitFor(() => replicasOf(serverId)[0]?.status === 'success', 5_000);
    copies = replicasOf(serverId);
    expect(copies[0]).toMatchObject({
      status: 'success',
      archivePath: `/pi/backups/${serverId}/${bk1}.tar.gz`,
      sizeBytes: 1234,
      sha256: SHA,
    });
    expect(panel.ctx.relayTokens.size).toBe(0);
    expect(
      panel.ctx.events
        .list({ type: 'task.completed' })
        .some((e) => (e.payload as { kind?: string }).kind === 'backup.receive'),
    ).toBe(true);

    // Seconde archive : la destination a roté la première (`keep: 2` n'est pas le sujet — c'est
    // le résultat de l'agent qui fait foi) → sa copie passe `deleted`.
    const bk2 = await backupOn(tour, serverId);
    await waitReceive(pi, 2);
    const req2 = pi.received.receive[1];
    if (req2 === undefined) throw new Error('unreachable');
    finishReceive(pi, req2, { rotated: [bk1] });
    await waitFor(
      () => replicasOf(serverId).some((c) => c.backupId === bk2 && c.status === 'success'),
      5_000,
    );
    copies = replicasOf(serverId);
    expect(copies.find((c) => c.backupId === bk1)?.status).toBe('deleted');
    const listed = (await api('GET', `/api/servers/${serverId}/backups`)).json<BackupsJson>();
    expect(listed.replicas.map((c) => c.backupId)).toEqual([bk2]);
  });

  it('rapatriement : l’original disparu redevient sain sur sa machine ; supprimer l’original emporte la copie', async () => {
    const tour = await online('Tour', CAPS);
    const pi = await online('Pi', CAPS);
    const serverId = await adopt(tour.id);
    await api('PUT', `/api/servers/${serverId}/replication`, { machineId: pi.id });
    const bk = await backupOn(tour, serverId);
    await waitReceive(pi, 1);
    const req = pi.received.receive[0];
    if (req === undefined) throw new Error('unreachable');
    finishReceive(pi, req);
    await waitFor(() => replicasOf(serverId)[0]?.status === 'success', 5_000);
    const replica = replicasOf(serverId)[0];
    if (replica === undefined) throw new Error('unreachable');

    // L'archive disparaît de la Tour (rotation, disque) : la fiche reste listée grâce à la copie.
    panel.ctx.backups.markDeleted([bk]);
    let listed = (await api('GET', `/api/servers/${serverId}/backups`)).json<BackupsJson>();
    expect(listed.backups.find((b) => b.id === bk)?.status).toBe('deleted');
    // Pas de rapatriement possible depuis la machine du serveur elle-même.
    const pull = await api(
      'POST',
      `/api/servers/${serverId}/backups/${bk}/replicas/${replica.id}/pull`,
      {},
    );
    expect(pull.statusCode, pull.body).toBe(202);
    await waitReceive(tour, 1);
    const back = tour.received.receive[0];
    if (back === undefined) throw new Error('unreachable');
    expect(back).toMatchObject({ serverId, backupId: bk });
    expect(back.sources.map((s) => s.kind)).toEqual(['direct', 'relay']);
    expect(pi.received.serve).toHaveLength(1);
    expect(back.manifest.archivePath).toBe(replica.archivePath);
    finishReceive(tour, back, { archivePath: `/tour/backups/${serverId}/${bk}.tar.gz` });
    await waitFor(() => panel.ctx.backups.get(bk)?.status === 'success', 5_000);
    expect(panel.ctx.backups.get(bk)).toMatchObject({
      machineId: tour.id,
      archivePath: `/tour/backups/${serverId}/${bk}.tar.gz`,
      sha256: SHA,
    });
    expect(JSON.stringify(panel.ctx.audit.list())).toContain('backup.pullBack');

    // Suppression explicite de l'original : la copie part avec (agent Pi joignable).
    const del = await api('DELETE', `/api/servers/${serverId}/backups/${bk}`);
    expect(del.statusCode).toBe(200);
    expect(pi.received.deleted).toHaveLength(1);
    expect(pi.received.deleted[0]).toMatchObject({
      serverId,
      backupId: bk,
      archivePath: replica.archivePath,
    });
    expect(replicasOf(serverId)[0]?.status).toBe('deleted');
    listed = (await api('GET', `/api/servers/${serverId}/backups`)).json<BackupsJson>();
    expect(listed.backups.find((b) => b.id === bk)).toBeUndefined();
  });

  it('agent sans la capacité → 501 et copie failed ; task échouée → failed ; réconciliation et rattrapage', async () => {
    const tour = await online('Tour', CAPS);
    const old = await online('Vieux', ['rcon', 'tasks', 'backups']);
    const pi = await online('Pi', CAPS);
    const serverId = await adopt(tour.id);
    const bk = await backupOn(tour, serverId);

    // N-1 : `backup.receive` inconnu → E_UNSUPPORTED_TYPE relayé en 501, fiche de copie en échec.
    let res = await api('POST', `/api/servers/${serverId}/backups/${bk}/replicate`, {
      machineId: old.id,
    });
    expect(res.statusCode).toBe(501);
    expect(replicasOf(serverId)[0]).toMatchObject({ machineId: old.id, status: 'failed' });

    // Destination saine : la task échoue chez elle → copie `failed` avec le message.
    res = await api('POST', `/api/servers/${serverId}/backups/${bk}/replicate`, {
      machineId: pi.id,
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitReceive(pi, 1);
    const req = pi.received.receive[0];
    if (req === undefined) throw new Error('unreachable');
    pi.agent.peer.emit('task.failed', {
      eventId: ulid(),
      taskId: req.taskId,
      kind: 'backup.receive',
      serverId,
      startedAt: Date.now() - 10,
      finishedAt: Date.now(),
      error: { code: 'E_UNREACHABLE', message: 'no route to Tour', retryable: false },
    });
    await waitFor(
      () => replicasOf(serverId).some((c) => c.machineId === pi.id && c.status === 'failed'),
      5_000,
    );
    expect(replicasOf(serverId).find((c) => c.machineId === pi.id)?.error).toContain('no route');

    // Rattrapage : réglage posé → la dernière archive sans copie saine part tout de suite.
    res = await api('PUT', `/api/servers/${serverId}/replication`, {
      machineId: pi.id,
      keepLast: 3,
    });
    expect(res.statusCode).toBe(200);
    await waitReceive(pi, 2);
    const req2 = pi.received.receive[1];
    if (req2 === undefined) throw new Error('unreachable');
    expect(req2).toMatchObject({ backupId: bk, keep: 3 });
    finishReceive(pi, req2);
    await waitFor(
      () => replicasOf(serverId).some((c) => c.machineId === pi.id && c.status === 'success'),
      5_000,
    );

    // Réconciliation : la copie n'est plus sur le disque du Pi → deleted ; revenue (base perdue) → réinsérée.
    pi.manifests = [];
    await panel.ctx.replication.reconcile(pi.id);
    expect(
      replicasOf(serverId).filter((c) => c.machineId === pi.id && c.status === 'success'),
    ).toHaveLength(0);
    pi.manifests = [
      {
        backupId: bk,
        serverId,
        kind: 'manual',
        createdAt: Date.now(),
        codec: 'gzip',
        archivePath: `/pi/backups/${serverId}/${bk}.tar.gz`,
        sizeBytes: 1234,
        sha256: SHA,
        files: 2,
        bytesRaw: 107,
        hot: false,
      },
    ];
    await panel.ctx.replication.reconcile(pi.id);
    expect(
      replicasOf(serverId).filter((c) => c.machineId === pi.id && c.status === 'success'),
    ).toHaveLength(1);
    // Rattrapage à la reconnexion : rien à faire, la copie est saine.
    await panel.ctx.replication.catchUp(pi.id);
    expect(pi.received.receive).toHaveLength(2);
  });
});
