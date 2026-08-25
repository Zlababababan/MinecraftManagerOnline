import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, ulid } from '@mmo/protocol';

import {
  connectClient,
  connectFakeAgent,
  createTestPanel,
  helloPayload,
  pairPayload,
  setupAdmin,
  waitFor,
  type FakeAgent,
  type TestPanel,
} from '../test/helpers.js';

describe('/ws/agent — appairage, authentification, session', () => {
  let panel: TestPanel;
  let admin: string;
  const agents: FakeAgent[] = [];

  async function newMachine(name = 'PC'): Promise<{ machineId: string; code: string }> {
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name },
      headers: { cookie: admin },
    });
    const body = res.json<{ machine: { id: string }; pairing: { code: string } }>();
    return { machineId: body.machine.id, code: body.pairing.code };
  }

  async function agent(): Promise<FakeAgent> {
    const a = await connectFakeAgent(panel.wsUrl);
    agents.push(a);
    return a;
  }

  /** Appairage complet : retourne `{ agentId, secret }` (connexion d'appairage fermée). */
  async function pair(code: string) {
    const a = await agent();
    const res = await a.peer.request('pair.request', pairPayload(code));
    await a.close();
    return res;
  }

  beforeEach(async () => {
    panel = await createTestPanel({ config: { offlineAfterMs: 400, heartbeatIntervalSec: 1 } });
    await panel.listen();
    admin = await setupAdmin(panel);
  });
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close().catch(() => undefined);
    await panel.close();
  });

  it('appairage : code invalide, 5 essais, TTL 15 min, usage unique, secret haché', async () => {
    const { machineId, code } = await newMachine();
    const a = await agent();
    await expect(
      a.peer.request('pair.request', pairPayload('MMOP-0000-0000')),
    ).rejects.toMatchObject({
      code: 'E_PAIRING_CODE_INVALID',
    });
    // Toute requête hors appairage/auth est refusée avant authentification.
    await expect(a.peer.request('sync.state', { servers: [] })).rejects.toMatchObject({
      code: 'E_AUTH',
    });

    // Code accepté quelle que soit la casse/les tirets.
    const ok = await a.peer.request(
      'pair.request',
      pairPayload(code.toLowerCase().replace(/-/g, '')),
    );
    expect(ok.agentId).toBe(machineId);
    expect(ok.secret).toMatch(/^[0-9a-f]{64}$/);
    const machine = panel.ctx.machines.require(machineId);
    expect(machine.agentTokenHash).toHaveLength(64);
    expect(machine.agentTokenHash).not.toBe(ok.secret);
    expect(machine.status).toBe('offline');
    expect(machine).toMatchObject({
      os: 'linux',
      arch: 'x64',
      hostname: 'test-host',
      agentVersion: '0.3.0',
    });

    // Usage unique.
    await expect(a.peer.request('pair.request', pairPayload(code))).rejects.toMatchObject({
      code: 'E_PAIRING_CODE_INVALID',
    });
    await a.close();

    // 5 essais ratés depuis une adresse la bloquent 10 min (le code en attente n'est plus brûlé).
    const second = await newMachine('PC2');
    const b = await agent();
    for (let i = 0; i < 5; i++) {
      await expect(
        b.peer.request('pair.request', pairPayload('MMOP-XXXX-YYYY')),
      ).rejects.toMatchObject({
        code: 'E_PAIRING_CODE_INVALID',
      });
    }
    await expect(b.peer.request('pair.request', pairPayload(second.code))).rejects.toMatchObject({
      code: 'E_PAIRING_CODE_INVALID',
      message: expect.stringContaining('too many pairing attempts') as string,
    });
    // Fenêtre écoulée : le même code (non brûlé) est accepté.
    panel.clock.advance(10 * 60_000 + 1);
    const okSecond = await b.peer.request('pair.request', pairPayload(second.code));
    expect(okSecond.agentId).toBe(second.machineId);

    // TTL : un code régénéré expire après 15 min.
    const regen = await panel.app.inject({
      method: 'POST',
      url: `/api/machines/${second.machineId}/pairing-codes`,
      headers: { cookie: admin },
    });
    const freshCode = regen.json<{ pairing: { code: string } }>().pairing.code;
    panel.clock.advance(15 * 60_000 + 1);
    await expect(b.peer.request('pair.request', pairPayload(freshCode))).rejects.toMatchObject({
      code: 'E_PAIRING_CODE_INVALID',
    });
    expect(panel.ctx.events.list({ type: 'machine.paired' })).toHaveLength(2);
  });

  it('auth.hello : secret invalide, machine désactivée, négociation N/N-1, auth.ok, une session par machine', async () => {
    const { machineId, code } = await newMachine();
    const { secret } = await pair(code);

    const a = await agent();
    await expect(
      a.peer.request('auth.hello', helloPayload(machineId, 'f'.repeat(64))),
    ).rejects.toMatchObject({
      code: 'E_AUTH',
    });
    await expect(a.peer.request('auth.hello', helloPayload('ghost', secret))).rejects.toMatchObject(
      {
        code: 'E_AUTH',
      },
    );
    await expect(
      a.peer.request(
        'auth.hello',
        helloPayload(machineId, secret, { protoMin: 99, protoMax: 100 }),
      ),
    ).rejects.toMatchObject({
      code: 'E_UNSUPPORTED_VERSION',
      details: { reason: 'agent_too_new' },
    });
    await expect(
      a.peer.request('auth.hello', helloPayload(machineId, secret, { protoMin: 0, protoMax: 0 })),
    ).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });

    // Un agent plus récent (N+1 annonçant encore N) négocie N ; le panel choisit zstd.
    const ok = await a.peer.request(
      'auth.hello',
      helloPayload(machineId, secret, {
        protoMin: PROTOCOL_VERSION,
        protoMax: PROTOCOL_VERSION + 1,
      }),
    );
    expect(ok).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalSec: 1,
      wantFullSync: true,
      compression: 'zstd',
    });
    expect(panel.ctx.machines.require(machineId).status).toBe('online');
    expect(panel.ctx.registry.isConnected(machineId)).toBe(true);
    const health = await panel.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json<{ agentsConnected: number }>().agentsConnected).toBe(1);

    // Seconde session pour la même machine : l'ancienne est fermée (agent redémarré).
    const b = await agent();
    await b.peer.request(
      'auth.hello',
      helloPayload(machineId, secret, { compression: ['none', 'gzip'] }),
    );
    expect(await a.closed).toContain('4000');
    expect(panel.ctx.registry.all()).toHaveLength(1);
    expect(panel.ctx.machines.require(machineId).status).toBe('online');

    // Machine désactivée : session fermée, auth refusée.
    await panel.app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      payload: { disabled: true },
      headers: { cookie: admin },
    });
    expect(await b.closed).toContain('4003');
    const c = await agent();
    await expect(
      c.peer.request('auth.hello', helloPayload(machineId, secret)),
    ).rejects.toMatchObject({
      code: 'E_AUTH',
    });
  });

  it('heartbeat : offline après 40 s (ici 400 ms) sans battement, événements agent.online/offline', async () => {
    const { machineId, code } = await newMachine();
    const { secret } = await pair(code);
    const a = await agent();
    await a.peer.request('auth.hello', helloPayload(machineId, secret));
    a.peer.emit('agent.heartbeat', {
      ts: panel.clock.now(),
      activeServers: 0,
      activeTasks: 0,
      cpuPct: 12,
    });
    await waitFor(() => panel.ctx.registry.get(machineId)?.heartbeat?.cpuPct === 12);
    const dto = await panel.app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}`,
      headers: { cookie: admin },
    });
    expect(
      dto.json<{ machine: { connected: boolean; heartbeat: { cpuPct: number } } }>().machine,
    ).toMatchObject({
      connected: true,
      heartbeat: { cpuPct: 12 },
    });

    panel.clock.advance(1000); // > offlineAfterMs (horloge pilotée)
    expect(await a.closed).toContain('4002');
    await waitFor(() => panel.ctx.machines.require(machineId).status === 'offline');
    const types = panel.ctx.events.list({ machineId }).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['agent.online', 'agent.offline', 'machine.paired']),
    );
  });

  it('sync.state : réconciliation (états, sessions joueurs orphelines, desired running relancé), config poussée', async () => {
    const { machineId, code } = await newMachine();
    const { secret } = await pair(code);
    const ts = panel.clock.now();
    // Deux serveurs connus : A « running » en base mais arrêté chez l'agent ; B arrêté en base mais
    // en marche (détaché) chez l'agent ; C souhaité running et arrêté partout → relance.
    const a = await panel.ctx.servers.adoptDetected(machineId, detected('/srv/a', 'A'), undefined);
    const b = await panel.ctx.servers.adoptDetected(machineId, detected('/srv/b', 'B'), undefined);
    const c = await panel.ctx.servers.adoptDetected(machineId, detected('/srv/c', 'C'), undefined);
    const [A, B, C] = [a.server!, b.server!, c.server!];
    panel.ctx.servers.applyStateChanged(
      { eventId: ulid(ts), serverId: A.id, ts, state: 'running', pid: 111 },
      machineId,
    );
    panel.ctx.servers.applyPlayerEvent(
      { eventId: ulid(ts), serverId: A.id, ts, kind: 'join', name: 'Alice', online: 1 },
      machineId,
    );
    expect(panel.ctx.servers.onlinePlayers(A.id)).toHaveLength(1);
    panel.ctx.servers.setDesiredState(C.id, 'running');

    const ag = await agent();
    const configs: unknown[] = [];
    const starts: string[] = [];
    ag.peer.handle('agent.configure', (cfg) => {
      configs.push(cfg);
      return { applied: true };
    });
    ag.peer.handle('server.start', ({ serverId }) => {
      starts.push(serverId);
      return { alreadyRunning: false, pid: 4242 };
    });
    await ag.peer.request('auth.hello', helloPayload(machineId, secret));
    await ag.peer.request('sync.state', {
      servers: [
        { serverId: A.id, path: '/srv/a', runState: 'stopped', attachMode: 'attached' },
        {
          serverId: B.id,
          path: '/srv/b',
          runState: 'running',
          attachMode: 'detached',
          pid: 222,
          startedAt: ts - 5000,
        },
        { path: '/srv/c', runState: 'stopped', attachMode: 'attached' },
        {
          serverId: 'unknown-to-panel',
          path: '/srv/x',
          runState: 'running',
          attachMode: 'detached',
        },
      ],
      seqs: { [`console:${B.id}`]: 120 },
    });
    expect(panel.ctx.servers.require(A.id)).toMatchObject({ runState: 'stopped', pid: null });
    expect(panel.ctx.servers.onlinePlayers(A.id)).toEqual([]);
    expect(panel.ctx.servers.require(B.id)).toMatchObject({
      runState: 'running',
      attachMode: 'detached',
      pid: 222,
      startedAt: ts - 5000,
    });
    await waitFor(() => configs.length === 1 && starts.length === 1);
    expect(starts).toEqual([C.id]);
    const cfg = configs[0] as {
      servers: { serverId: string; path: string; maxRamMb: number; launch?: unknown }[];
      desiredStates: Record<string, string>;
      restoreOnBoot: boolean;
      watchedDirectories: unknown[];
    };
    expect(cfg.servers.map((s) => s.serverId).sort()).toEqual([A.id, B.id, C.id].sort());
    expect(cfg.servers.find((s) => s.serverId === A.id)).toMatchObject({
      path: '/srv/a',
      maxRamMb: 2048,
      launch: { kind: 'jar', jar: 'server.jar' },
    });
    expect(cfg.desiredStates).toEqual({ [A.id]: 'stopped', [B.id]: 'stopped', [C.id]: 'running' });
    expect(cfg.restoreOnBoot).toBe(true);
    const reconciled = panel.ctx.events
      .list({ type: 'server.stateChanged' })
      .filter((e) => (e.payload as { reconciled?: boolean }).reconciled === true);
    expect(reconciled.map((e) => e.serverId).sort()).toEqual([A.id, B.id].sort());
  });

  it('adoption : deux adoptions concurrentes du même chemin → un seul serveur, jamais d’erreur SQLite', async () => {
    // Course réelle (scan périodique vs « Ajouter un dossier serveur ») : les deux appels passent
    // le findByPath d'entrée avant le premier INSERT (suspension sur java.resolve), le second
    // doit retomber sur le serveur adopté par le premier au lieu de fuir en E_INTERNAL.
    const { machineId, code } = await newMachine();
    await pair(code);
    const [a, b] = await Promise.all([
      panel.ctx.servers.adoptDetected(machineId, detected('/srv/course', 'Course'), undefined),
      panel.ctx.servers.adoptDetected(machineId, detected('/srv/course', 'Course'), undefined),
    ]);
    expect(a.server).toBeDefined();
    expect(b.server).toBeDefined();
    expect(a.server!.id).toBe(b.server!.id);
    expect([a, b].filter((r) => r.created)).toHaveLength(1);
    expect(panel.ctx.servers.list().filter((s) => s.path === '/srv/course')).toHaveLength(1);
  });

  it('événements critiques : dédup par eventId, event.ack batché, rejeu après redémarrage reconnu', async () => {
    const { machineId, code } = await newMachine();
    const { secret } = await pair(code);
    const r = await panel.ctx.servers.adoptDetected(machineId, detected('/srv/a', 'A'), undefined);
    const serverId = r.server!.id;
    const ag = await agent();
    ag.peer.handle('agent.configure', () => ({ applied: true }));
    const acked: string[] = [];
    ag.peer.handle('event.ack', ({ eventIds }) => {
      acked.push(...eventIds);
      return {};
    });
    await ag.peer.request('auth.hello', helloPayload(machineId, secret));
    await ag.peer.request('sync.state', { servers: [] });

    const ts = panel.clock.now();
    const id1 = ulid(ts);
    const payload = { eventId: id1, serverId, ts, state: 'starting' as const, pid: 99 };
    ag.peer.emit('server.stateChanged', payload, { id: id1 });
    ag.peer.emit('server.stateChanged', payload, { id: id1 }); // rejeu
    const id2 = ulid(ts + 1);
    ag.peer.emit(
      'server.stateChanged',
      { ...payload, eventId: id2, state: 'running' },
      { id: id2 },
    );
    await waitFor(() => acked.length === 3);
    expect(acked.sort()).toEqual([id1, id1, id2].sort());
    expect(panel.ctx.events.list({ type: 'server.stateChanged', serverId })).toHaveLength(2);
    expect(panel.ctx.servers.require(serverId)).toMatchObject({ runState: 'running', pid: 99 });
    expect(panel.ctx.processed.has(id1)).toBe(true);

    // Crash : exitReason, sessions joueurs clôturées, événement `error`.
    const id3 = ulid(ts + 2);
    ag.peer.emit(
      'player.event',
      { eventId: ulid(ts), serverId, ts, kind: 'join', name: 'Bob', uuid: 'u-bob', online: 1 },
      { id: ulid(ts + 5) },
    );
    await waitFor(() => panel.ctx.servers.onlinePlayers(serverId).length === 1);
    ag.peer.emit(
      'server.stateChanged',
      {
        eventId: id3,
        serverId,
        ts: ts + 2,
        state: 'crashed',
        previous: 'running',
        exitReason: 'crash',
        exitCode: 1,
      },
      { id: id3 },
    );
    await waitFor(() => panel.ctx.servers.require(serverId).runState === 'crashed');
    expect(panel.ctx.servers.require(serverId)).toMatchObject({
      lastExitReason: 'crash',
      pid: null,
      stoppedAt: ts + 2,
    });
    expect(panel.ctx.servers.onlinePlayers(serverId)).toEqual([]);
    expect(panel.ctx.events.list({ serverId }).find((e) => e.severity === 'error')?.type).toBe(
      'server.stateChanged',
    );
  });

  it('rotation du secret : ancien secret accepté 24 h, puis refusé ; révocation = machine supprimée', async () => {
    const { machineId, code } = await newMachine();
    const { secret } = await pair(code);
    const ag = await agent();
    ag.peer.handle('agent.configure', () => ({ applied: true }));
    let rotated: { newSecret: string; graceUntil: number } | undefined;
    ag.peer.handle('agent.rotateSecret', (p) => {
      rotated = p;
      return {};
    });
    await ag.peer.request('auth.hello', helloPayload(machineId, secret));
    const res = await panel.app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/rotate-secret`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(rotated?.newSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated?.graceUntil).toBe(panel.clock.now() + 24 * 3_600_000);

    const b = await agent();
    await b.peer.request('auth.hello', helloPayload(machineId, secret)); // ancien secret, en grâce
    const c = await agent();
    await c.peer.request('auth.hello', helloPayload(machineId, rotated!.newSecret));
    panel.clock.advance(24 * 3_600_000 + 1);
    const d = await agent();
    await expect(
      d.peer.request('auth.hello', helloPayload(machineId, secret)),
    ).rejects.toMatchObject({ code: 'E_AUTH' });
    await d.peer.request('auth.hello', helloPayload(machineId, rotated!.newSecret));

    await panel.app.inject({
      method: 'DELETE',
      url: `/api/machines/${machineId}`,
      headers: { cookie: admin },
    });
    expect(await d.closed).toContain('4003');
    const e = await agent();
    await expect(
      e.peer.request('auth.hello', helloPayload(machineId, rotated!.newSecret)),
    ).rejects.toMatchObject({
      code: 'E_AUTH',
    });
  });

  it('détection : adoption automatique (ID panel), marqueur inconnu conservé, conflit explicite copy/migrate', async () => {
    const { machineId, code } = await newMachine();
    const { secret } = await pair(code);
    const ag = await agent();
    const configs: { servers: { serverId: string; path: string }[] }[] = [];
    ag.peer.handle('agent.configure', (cfg) => {
      configs.push(cfg as never);
      return { applied: true };
    });
    await ag.peer.request('auth.hello', helloPayload(machineId, secret));
    await ag.peer.request('sync.state', { servers: [] });
    await waitFor(() => configs.length === 1);

    const ts = panel.clock.now();
    ag.peer.emit(
      'server.detected',
      { eventId: ulid(ts), ts, directoryId: 'd1', server: detected('/srv/new', 'New') },
      { id: ulid(ts) },
    );
    ag.peer.emit(
      'server.detected',
      {
        eventId: ulid(ts),
        ts,
        server: {
          ...detected('/srv/restored', 'Restored'),
          markerServerId: '01RESTOREDFROMBACKUP0000000',
        },
      },
      { id: ulid(ts + 1) },
    );
    await waitFor(() => panel.ctx.servers.list().length === 2);
    const fresh = panel.ctx.servers.findByPath(machineId, '/srv/new')!;
    expect(fresh.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(fresh).toMatchObject({
      name: 'New',
      loader: 'vanilla',
      mcVersion: '1.20.1',
      maxRamMb: 2048,
      provisioning: 'ready',
      javaMajorRequired: 17,
      detected: 1,
    });
    expect(panel.ctx.servers.get('01RESTOREDFROMBACKUP0000000')).toMatchObject({
      path: '/srv/restored',
    });
    await waitFor(() => configs.length >= 2);
    expect(
      configs
        .at(-1)!
        .servers.map((s) => s.path)
        .sort(),
    ).toEqual(['/srv/new', '/srv/restored']);

    // Même marqueur réapparaissant ailleurs (copie) → conflit, pas d'adoption.
    ag.peer.emit(
      'server.detected',
      {
        eventId: ulid(ts),
        ts,
        server: { ...detected('/srv/new-copy', 'New copy'), markerServerId: fresh.id },
      },
      { id: ulid(ts + 2) },
    );
    await waitFor(() => panel.ctx.servers.listConflicts().length === 1);
    expect(panel.ctx.servers.list()).toHaveLength(2);
    let res = await panel.app.inject({
      method: 'GET',
      url: '/api/servers/conflicts',
      headers: { cookie: admin },
    });
    const conflict = res.json<{
      conflicts: { key: string; serverId: string; found: { path: string } }[];
    }>().conflicts[0]!;
    expect(conflict).toMatchObject({ serverId: fresh.id, found: { path: '/srv/new-copy' } });
    expect(panel.ctx.events.list({ type: 'server.conflict' })).toHaveLength(1);

    res = await panel.app.inject({
      method: 'POST',
      url: '/api/servers/conflicts/resolve',
      payload: { key: conflict.key, resolution: 'copy' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    const copy = res.json<{ server: { id: string; path: string } }>().server;
    expect(copy.id).not.toBe(fresh.id);
    expect(copy.path).toBe('/srv/new-copy');
    expect(panel.ctx.servers.listConflicts()).toEqual([]);

    // Migration : l'ID suit le dossier.
    ag.peer.emit(
      'server.detected',
      {
        eventId: ulid(ts),
        ts,
        server: { ...detected('/srv/moved', 'Moved'), markerServerId: fresh.id },
      },
      { id: ulid(ts + 3) },
    );
    await waitFor(() => panel.ctx.servers.listConflicts().length === 1);
    res = await panel.app.inject({
      method: 'POST',
      url: '/api/servers/conflicts/resolve',
      payload: { key: panel.ctx.servers.listConflicts()[0]!.key, resolution: 'migrate' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(panel.ctx.servers.require(fresh.id).path).toBe('/srv/moved');

    // Disparition du dossier.
    ag.peer.emit(
      'server.removed',
      { eventId: ulid(ts), ts, path: '/srv/moved', serverId: fresh.id },
      { id: ulid(ts + 4) },
    );
    await waitFor(() => panel.ctx.servers.require(fresh.id).detected === 0);
  });

  it('/ws/client : cookie requis, hello, événements diffusés, abonnement console avec rattrapage agent', async () => {
    await expect(connectClient(panel.wsUrl, 'mmo_session=bogus')).rejects.toThrow(/401/);
    const client = await connectClient(panel.wsUrl, admin);
    await waitFor(() => client.messages.length === 1);
    expect(client.messages[0]).toMatchObject({ type: 'hello', user: { username: 'admin' } });

    const { machineId, code } = await newMachine();
    const { secret } = await pair(code);
    const r = await panel.ctx.servers.adoptDetected(machineId, detected('/srv/a', 'A'), undefined);
    const serverId = r.server!.id;
    const ag = await agent();
    ag.peer.handle('agent.configure', () => ({ applied: true }));
    const subs: { serverId: string; sinceSeq?: number | undefined }[] = [];
    ag.peer.handle('console.subscribe', (p) => {
      subs.push(p);
      return {
        lines: [
          { seq: 1, ts: 1, level: 'INFO', text: 'one' },
          { seq: 2, ts: 2, level: 'INFO', text: 'two' },
        ],
        truncated: false,
        latestSeq: 2,
      };
    });
    const unsubs: string[] = [];
    ag.peer.handle('console.unsubscribe', ({ serverId: s }) => {
      unsubs.push(s);
      return {};
    });
    await ag.peer.request('auth.hello', helloPayload(machineId, secret));
    await waitFor(() => client.messages.some((m) => (m as { type: string }).type === 'event'));

    client.send({ type: 'subscribe', channels: [`console:${serverId}`] });
    await waitFor(() =>
      client.messages.some((m) => (m as { type: string }).type === 'console.snapshot'),
    );
    expect(subs).toEqual([{ serverId, sinceSeq: 0 }]);
    expect(client.messages.at(-1)).toMatchObject({
      type: 'console.snapshot',
      serverId,
      latestSeq: 2,
      lines: [{ seq: 1 }, { seq: 2 }],
    });

    ag.peer.emit('console.lines', {
      serverId,
      lines: [
        { seq: 2, ts: 2, level: 'INFO', text: 'dup' },
        { seq: 3, ts: 3, level: 'WARN', text: 'three' },
      ],
    });
    await waitFor(() =>
      client.messages.some((m) => (m as { type: string }).type === 'console.lines'),
    );
    expect(client.messages.at(-1)).toMatchObject({
      type: 'console.lines',
      lines: [{ seq: 3, text: 'three' }],
    });

    // Reconnexion de l'agent : ré-abonnement avec `sinceSeq` = dernier seq connu.
    ag.ws.close(1000, 'restart');
    await ag.closed;
    const ag2 = await agent();
    ag2.peer.handle('agent.configure', () => ({ applied: true }));
    const ok = await ag2.peer.request('auth.hello', helloPayload(machineId, secret));
    expect(ok.subscriptions).toEqual([{ channel: `console:${serverId}`, sinceSeq: 3 }]);

    // Dernier abonné parti → console.unsubscribe.
    client.send({ type: 'unsubscribe', channels: [`console:${serverId}`] });
    ag2.peer.handle('console.unsubscribe', ({ serverId: s }) => {
      unsubs.push(s);
      return {};
    });
    await waitFor(() => unsubs.length === 1);
    client.send({ type: 'ping' });
    await waitFor(() => client.messages.some((m) => (m as { type: string }).type === 'pong'));
    client.close();
  });
});

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
