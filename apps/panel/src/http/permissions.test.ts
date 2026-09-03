/**
 * Lot 8 — droits par serveur et par machine, de bout en bout côté panel : réglage des comptes
 * limités (refus admin, plafond du rôle, portées inconnues), rôle effectif jugé par le hook d'auth
 * (404 hors portée, 403 sous le rôle, une machine accordée couvre ses serveurs futurs), listes
 * filtrées (serveurs, machines, tasks, planifications, événements, centre de notifications,
 * actions groupées et de groupe), temps réel (abonnement console refusé, diffusion filtrée,
 * échantillon retaillé, fermeture 4002 quand les portées changent), rétrogradation qui redescend
 * les portées, cascade à la suppression d'un serveur. Un compte non limité garde tout.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ulid } from '@mmo/protocol';
import type { ServerDto, ServerMessage, UserGrantsDto } from '@mmo/protocol/client';

import { servers as serversTable, userMachinePermissions } from '../db/schema.js';
import {
  connectClient,
  createTestPanel,
  createUser,
  login,
  setupAdmin,
  waitFor,
  type TestPanel,
} from '../test/helpers.js';

function detected(path: string, name: string, gamePort: number) {
  return {
    path,
    name,
    loader: { value: 'vanilla' as const, confidence: 'high' as const, source: 'jar_name' },
    mcVersion: { value: '1.20.1', confidence: 'high' as const, source: 'jar_manifest' },
    maxRamMb: { value: 2048, confidence: 'medium' as const, source: 'run_script' },
    gamePort,
    eulaAccepted: true,
    launch: { kind: 'jar' as const, jar: 'server.jar' },
    javaRequirement: { majorVersion: 17, strict: false, source: 'table' as const },
    confidence: 'high' as const,
    evidence: [],
  };
}

interface Body {
  code?: string;
  details?: { reason?: string };
}

describe('lot 8 — droits par serveur et par machine', () => {
  let panel: TestPanel;
  let admin: string;
  let m1: string;
  let m2: string;
  let a: string;
  let b: string;
  let c: string;
  /** Opérateur limité : serveur A (opérateur) + machine M2 entière (opérateur). */
  let ami: string;
  let amiId: string;
  /** Lecteur limité : serveur B seulement. */
  let lecteur: string;
  /** Lecteur NON limité : comportement historique. */
  let reader: string;

  const api = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    cookie: string,
    payload?: unknown,
  ) =>
    panel.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      headers: { cookie },
    });

  async function machine(name: string): Promise<string> {
    const res = await api('POST', '/api/machines', admin, { name });
    expect(res.statusCode).toBe(201);
    return res.json<{ machine: { id: string } }>().machine.id;
  }

  async function server(machineId: string, name: string, port: number): Promise<string> {
    const adopted = await panel.ctx.servers.adoptDetected(
      machineId,
      detected(`/srv/${name}`, name, port),
      undefined,
    );
    return adopted.server!.id;
  }

  async function scopedUser(
    username: string,
    role: 'operator' | 'viewer',
    grants: Partial<UserGrantsDto>,
  ): Promise<{ cookie: string; id: string }> {
    const res = await api('POST', '/api/users', admin, {
      username,
      password: 'correct horse battery',
      role,
      scoped: true,
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ user: { id: string; scoped: boolean } }>().user;
    expect(res.json<{ user: { scoped: boolean } }>().user.scoped).toBe(true);
    const put = await api('PUT', `/api/users/${id}/grants`, admin, grants);
    expect(put.statusCode).toBe(200);
    return { cookie: await login(panel, username, 'correct horse battery'), id };
  }

  beforeEach(async () => {
    panel = await createTestPanel();
    await panel.listen();
    admin = await setupAdmin(panel);
    m1 = await machine('PC');
    m2 = await machine('VM');
    a = await server(m1, 'A', 25_001);
    b = await server(m1, 'B', 25_002);
    c = await server(m2, 'C', 25_003);
    const friend = await scopedUser('ami', 'operator', {
      servers: [{ serverId: a, role: 'operator' }],
      machines: [{ machineId: m2, role: 'operator' }],
    });
    ami = friend.cookie;
    amiId = friend.id;
    lecteur = (
      await scopedUser('lecteur', 'viewer', { servers: [{ serverId: b, role: 'viewer' }] })
    ).cookie;
    reader = await createUser(panel, admin, {
      username: 'reader',
      password: 'reader-pass!!',
      role: 'viewer',
    });
  });
  afterEach(async () => {
    await panel.close();
  });

  it('réglage : admin jamais limité, plafond du rôle, portée inconnue, `me.grants`, audit', async () => {
    // Un administrateur voit tout : ni à la création, ni après coup.
    let res = await api('POST', '/api/users', admin, {
      username: 'chef',
      password: 'correct horse battery',
      role: 'admin',
      scoped: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().details?.reason).toBe('ADMIN_SCOPED');
    res = await api('POST', '/api/users', admin, {
      username: 'chef',
      password: 'correct horse battery',
      role: 'admin',
    });
    const chefId = res.json<{ user: { id: string } }>().user.id;
    res = await api('PATCH', `/api/users/${chefId}`, admin, { scoped: true });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().details?.reason).toBe('ADMIN_SCOPED');
    res = await api('PUT', `/api/users/${chefId}/grants`, admin, { servers: [] });
    expect(res.statusCode).toBe(400);
    // Passer admin un compte limité échoue pareil (l'état résultant est jugé).
    res = await api('PATCH', `/api/users/${amiId}`, admin, { role: 'admin' });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().details?.reason).toBe('ADMIN_SCOPED');

    // Le rôle du compte plafonne les portées.
    const lecteurId = panel.ctx.users.findByUsername('lecteur')!.id;
    res = await api('PUT', `/api/users/${lecteurId}/grants`, admin, {
      servers: [{ serverId: b, role: 'operator' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().details?.reason).toBe('GRANT_ABOVE_ROLE');
    // Portée inconnue : 404, rien d'écrit.
    res = await api('PUT', `/api/users/${lecteurId}/grants`, admin, {
      servers: [{ serverId: 'srv_nope', role: 'viewer' }],
    });
    expect(res.statusCode).toBe(404);
    res = await api('GET', `/api/users/${lecteurId}/grants`, admin);
    expect(res.json<{ grants: UserGrantsDto }>().grants).toEqual({
      servers: [{ serverId: b, role: 'viewer' }],
      machines: [],
    });
    // Les portées ne se lisent ni ne s'écrivent sans être admin.
    expect((await api('GET', `/api/users/${lecteurId}/grants`, ami)).statusCode).toBe(403);

    // `/api/auth/me` : les portées voyagent avec le compte limité, `null` pour les autres.
    const me = await api('GET', '/api/auth/me', ami);
    expect(me.statusCode).toBe(200);
    const meBody = me.json<{ user: { scoped: boolean }; grants: UserGrantsDto | null }>();
    expect(meBody.user.scoped).toBe(true);
    expect(meBody.grants).toEqual({
      servers: [{ serverId: a, role: 'operator' }],
      machines: [{ machineId: m2, role: 'operator' }],
    });
    expect(
      (await api('GET', '/api/auth/me', reader)).json<{ grants: unknown }>().grants,
    ).toBeNull();
    expect((await api('GET', '/api/auth/me', admin)).json<{ grants: unknown }>().grants).toBeNull();

    const audit = panel.ctx.audit.list();
    const grantsAudit = audit.filter((e) => e.action === 'user.grantsUpdated');
    expect(grantsAudit.map((e) => e.targetLabel).sort()).toEqual(['ami', 'lecteur']);
    expect(JSON.stringify(grantsAudit.map((e) => e.details))).toContain(m2);
    expect(
      JSON.stringify(
        audit.find((e) => e.action === 'user.created' && e.targetLabel === 'ami')?.details,
      ),
    ).toContain('"scoped":true');
  });

  it('rôle effectif par route : 404 hors portée, 403 sous le rôle, machine accordée = serveurs futurs, listes filtrées', async () => {
    const ids = (res: Awaited<ReturnType<typeof api>>) =>
      res
        .json<{ servers: ServerDto[] }>()
        .servers.map((s) => s.id)
        .sort();
    // Listes : l'ami voit A (accordé) et C (couvert par M2), jamais B.
    expect(ids(await api('GET', '/api/servers', ami))).toEqual([a, c].sort());
    expect(ids(await api('GET', '/api/servers', lecteur))).toEqual([b]);
    // Comportement historique intact : un lecteur non limité voit tout.
    expect(ids(await api('GET', '/api/servers', reader))).toEqual([a, b, c].sort());

    // Routes `:id` : hors portée = introuvable, pas interdit (aucune énumération).
    expect((await api('GET', `/api/servers/${b}`, ami)).statusCode).toBe(404);
    expect((await api('GET', `/api/servers/${b}/backups`, ami)).statusCode).toBe(404);
    expect((await api('GET', `/api/servers/${a}`, ami)).statusCode).toBe(200);
    expect((await api('GET', `/api/servers/${a}`, lecteur)).statusCode).toBe(404);
    expect((await api('GET', `/api/servers/${b}`, reader)).statusCode).toBe(200);
    // Sous le rôle accordé : 403 (le serveur se voit, l'action non).
    let res = await api('POST', `/api/servers/${b}/start`, lecteur, {});
    expect(res.statusCode).toBe(403);
    // Au rôle accordé, la garde passe : l'agent hors ligne répond, pas le hook.
    res = await api('POST', `/api/servers/${a}/start`, ami, {});
    expect(res.statusCode).toBe(503);
    expect(res.json<Body>().code).toBe('E_AGENT_OFFLINE');
    res = await api('POST', `/api/servers/${c}/start`, ami, {});
    expect(res.json<Body>().code).toBe('E_AGENT_OFFLINE');
    // Un rôle admin reste inaccessible à un compte limité, même opérateur sur la portée.
    expect((await api('DELETE', `/api/servers/${a}`, ami)).statusCode).toBe(403);

    // Machines : M2 accordée (opérateur), M1 lisible parce qu'elle porte A — jamais opérable.
    const machines = (await api('GET', '/api/machines', ami)).json<{
      machines: { id: string }[];
    }>();
    expect(machines.machines.map((m) => m.id).sort()).toEqual([m1, m2].sort());
    expect((await api('GET', `/api/machines/${m1}`, ami)).statusCode).toBe(200);
    expect((await api('POST', `/api/machines/${m1}/scan`, ami, {})).statusCode).toBe(403);
    expect((await api('POST', `/api/machines/${m2}/scan`, ami, {})).json<Body>().code).toBe(
      'E_AGENT_OFFLINE',
    );
    // Le lecteur limité à B ne voit que M1, et pas M2.
    expect((await api('GET', `/api/machines/${m2}`, lecteur)).statusCode).toBe(404);

    // Un serveur détecté plus tard sur M2 est couvert d'office.
    const d = await server(m2, 'D', 25_004);
    expect(ids(await api('GET', '/api/servers', ami))).toEqual([a, c, d].sort());
    expect((await api('POST', `/api/servers/${d}/start`, ami, {})).json<Body>().code).toBe(
      'E_AGENT_OFFLINE',
    );
  });

  it('tasks, planifications, événements, cloche, actions groupées et de groupe suivent les portées', async () => {
    const taskA = panel.ctx.tasks.create({
      id: ulid(),
      kind: 'backup.create',
      machineId: m1,
      serverId: a,
    });
    const taskB = panel.ctx.tasks.create({
      id: ulid(),
      kind: 'backup.create',
      machineId: m1,
      serverId: b,
    });
    const taskM2 = panel.ctx.tasks.create({ id: ulid(), kind: 'java.install', machineId: m2 });
    const taskM1 = panel.ctx.tasks.create({ id: ulid(), kind: 'java.install', machineId: m1 });
    const listed = (await api('GET', '/api/tasks', ami)).json<{ tasks: { id: string }[] }>();
    // A (accordé), M2 (machine accordée), M1 (lisible via A) ; jamais B.
    expect(listed.tasks.map((t) => t.id).sort()).toEqual([taskA.id, taskM2.id, taskM1.id].sort());
    expect((await api('GET', `/api/tasks/${taskB.id}`, ami)).statusCode).toBe(404);
    expect((await api('GET', `/api/tasks/${taskA.id}`, ami)).statusCode).toBe(200);
    // Annuler : opérateur sur la portée exigé — M1 n'est que lisible.
    expect((await api('POST', `/api/tasks/${taskM1.id}/cancel`, ami, {})).statusCode).toBe(403);
    expect((await api('POST', `/api/tasks/${taskB.id}/cancel`, ami, {})).statusCode).toBe(404);
    expect((await api('POST', `/api/tasks/${taskA.id}/cancel`, ami, {})).json<Body>().code).toBe(
      'E_AGENT_OFFLINE',
    );
    expect((await api('POST', `/api/tasks/${taskB.id}/cancel`, lecteur, {})).statusCode).toBe(403);
    expect(
      (await api('GET', '/api/tasks', reader)).json<{ tasks: unknown[] }>().tasks,
    ).toHaveLength(4);

    panel.ctx.scheduler.create(a, { action: 'start', cron: '0 4 * * *' });
    panel.ctx.scheduler.create(b, { action: 'start', cron: '0 5 * * *' });
    const schedules = (await api('GET', '/api/schedules', ami)).json<{
      schedules: { serverId: string | null }[];
    }>();
    expect(schedules.schedules.map((s) => s.serverId)).toEqual([a]);

    // Événements : serveur accordé, machine lisible ; ni l'autre serveur ni le panel.
    panel.ctx.events.publish({
      type: 'task.failed',
      severity: 'error',
      serverId: b,
      machineId: m1,
      payload: { taskId: taskB.id },
    });
    panel.ctx.events.publish({
      type: 'task.failed',
      severity: 'error',
      serverId: a,
      machineId: m1,
      payload: { taskId: taskA.id },
    });
    panel.ctx.events.publish({
      type: 'agent.offline',
      severity: 'warning',
      machineId: m1,
      payload: {},
    });
    panel.ctx.events.publish({
      type: 'panel.backupFailed',
      severity: 'error',
      payload: { error: 'x' },
    });
    const events = (await api('GET', '/api/events?limit=50', ami)).json<{
      events: { type: string; serverId: string | null; machineId: string | null }[];
    }>();
    const seen = events.events.map((e) => `${e.type}:${e.serverId ?? ''}:${e.machineId ?? ''}`);
    expect(seen).toContain(`task.failed:${a}:${m1}`);
    expect(seen).toContain(`agent.offline::${m1}`);
    expect(seen).not.toContain(`task.failed:${b}:${m1}`);
    expect(seen.some((s) => s.startsWith('panel.backupFailed'))).toBe(false);
    // Le lecteur non limité lit tout, panel compris.
    const all = (await api('GET', '/api/events?limit=50', reader)).json<{
      events: { type: string }[];
    }>();
    expect(all.events.some((e) => e.type === 'panel.backupFailed')).toBe(true);
    // Centre de notifications : mêmes règles.
    const bell = panel.ctx.notifications.list(amiId).notifications;
    expect(bell.map((e) => e.serverId)).toContain(a);
    expect(bell.map((e) => e.serverId)).not.toContain(b);
    expect(bell.some((e) => e.type === 'panel.backupFailed')).toBe(false);

    // Actions groupées : serveur par serveur — hors portée = introuvable, sous le rôle = interdit.
    let res = await api('POST', '/api/servers/bulk-action', ami, {
      action: 'start',
      serverIds: [b, a],
      continueOnError: true,
    });
    expect(res.statusCode).toBe(200);
    const results = res.json<{ results: { serverId: string; status: string; error?: Body }[] }>()
      .results;
    expect(results.find((r) => r.serverId === b)?.error?.code).toBe('E_NOT_FOUND');
    expect(results.find((r) => r.serverId === a)?.error?.code).toBe('E_AGENT_OFFLINE');
    res = await api('POST', '/api/servers/bulk-action', lecteur, {
      action: 'start',
      serverIds: [b],
    });
    // Le lecteur n'a pas le rôle global opérateur : la route elle-même est fermée.
    expect(res.statusCode).toBe(403);

    // Groupe A+B : l'ami n'est pas opérateur sur B → interdit ; l'admin passe.
    res = await api('POST', '/api/groups', admin, { name: 'Duo' });
    const groupId = res.json<{ group: { id: string } }>().group.id;
    expect((await api('PATCH', `/api/servers/${a}`, admin, { groupId })).statusCode).toBe(200);
    expect((await api('PATCH', `/api/servers/${b}`, admin, { groupId })).statusCode).toBe(200);
    expect(
      (await api('POST', `/api/groups/${groupId}/action`, ami, { action: 'start' })).statusCode,
    ).toBe(403);
    // B accordé en lecture : visible, mais pas opérable → toujours interdit.
    await api('PUT', `/api/users/${amiId}/grants`, admin, {
      servers: [
        { serverId: a, role: 'operator' },
        { serverId: b, role: 'viewer' },
      ],
      machines: [{ machineId: m2, role: 'operator' }],
    });
    const amiAgain = await login(panel, 'ami', 'correct horse battery');
    expect(
      (await api('POST', `/api/groups/${groupId}/action`, amiAgain, { action: 'start' }))
        .statusCode,
    ).toBe(403);
    // B accordé en opérateur : la garde passe, c'est l'agent absent qui répond, pas un 403.
    await api('PUT', `/api/users/${amiId}/grants`, admin, {
      servers: [
        { serverId: a, role: 'operator' },
        { serverId: b, role: 'operator' },
      ],
      machines: [{ machineId: m2, role: 'operator' }],
    });
    res = await api('POST', `/api/groups/${groupId}/action`, amiAgain, { action: 'start' });
    expect(res.statusCode).not.toBe(403);
    expect(res.json<Body>().code).toBe('E_AGENT_OFFLINE');
    res = await api('POST', `/api/groups/${groupId}/action`, admin, { action: 'start' });
    expect(res.statusCode).not.toBe(403);
    expect(res.json<Body>().code).toBe('E_AGENT_OFFLINE');
  });

  it('temps réel : console hors portée refusée, diffusion filtrée, échantillon retaillé, 4002 quand les portées changent', async () => {
    const friend = await connectClient(panel.wsUrl, ami);
    const boss = await connectClient(panel.wsUrl, admin);
    const typed = (list: unknown[]) => list as ServerMessage[];
    friend.send({ type: 'subscribe', channels: [`console:${b}`, `console:${a}`] });
    await waitFor(() => typed(friend.messages).some((m) => m.type === 'console.snapshot'));
    const refused = typed(friend.messages).find((m) => m.type === 'error');
    expect(refused?.type === 'error' && refused.channel).toBe(`console:${b}`);
    expect(refused?.type === 'error' && refused.error.code).toBe('E_NOT_FOUND');
    const snapshot = typed(friend.messages).find((m) => m.type === 'console.snapshot');
    expect(snapshot?.type === 'console.snapshot' && snapshot.serverId).toBe(a);
    expect(panel.ctx.hub.subscriberCount(`console:${b}`)).toBe(0);

    const dto = (id: string) => panel.ctx.servers.toDto(panel.ctx.servers.require(id), false);
    panel.ctx.hub.broadcast({ type: 'server.state', server: dto(b) });
    panel.ctx.hub.broadcast({ type: 'server.state', server: dto(a) });
    panel.ctx.hub.broadcast({
      type: 'metrics.sample',
      machineId: m1,
      sample: {
        ts: panel.clock.now(),
        machine: { cpuPct: 1, ramUsedMb: 1, ramTotalMb: 2 },
        servers: [
          { serverId: a, cpuPct: 1 },
          { serverId: b, cpuPct: 2 },
        ],
      },
    });
    panel.ctx.events.publish({
      type: 'task.failed',
      severity: 'error',
      serverId: b,
      machineId: m1,
      payload: {},
    });
    panel.ctx.events.publish({
      type: 'task.failed',
      severity: 'error',
      serverId: a,
      machineId: m1,
      payload: {},
    });
    // L'admin reçoit tout : quand il a ses cinq messages, l'ami a eu le temps de recevoir les siens.
    await waitFor(() => {
      const types = typed(boss.messages).map((m) => m.type);
      return (
        types.filter((t) => t === 'server.state').length === 2 &&
        types.filter((t) => t === 'event').length === 2 &&
        types.includes('metrics.sample')
      );
    });
    const states = typed(friend.messages).filter((m) => m.type === 'server.state');
    expect(states.map((m) => m.server.id)).toEqual([a]);
    const events = typed(friend.messages).filter((m) => m.type === 'event');
    expect(events.map((m) => m.event.serverId)).toEqual([a]);
    const sample = typed(friend.messages).find((m) => m.type === 'metrics.sample');
    expect(
      sample?.type === 'metrics.sample' && sample.sample.servers.map((s) => s.serverId),
    ).toEqual([a]);
    const bossSample = typed(boss.messages).find((m) => m.type === 'metrics.sample');
    expect(bossSample?.type === 'metrics.sample' && bossSample.sample.servers).toHaveLength(2);

    // Les portées changent : la connexion de l'ami se ferme en 4002, l'admin reste ; la vue en
    // cache est bien invalidée (A devient introuvable, B se voit).
    const closed = new Promise<number>((resolve) => {
      friend.ws.once('close', (code) => {
        resolve(code);
      });
    });
    const res = await api('PUT', `/api/users/${amiId}/grants`, admin, {
      servers: [{ serverId: b, role: 'viewer' }],
    });
    expect(res.statusCode).toBe(200);
    expect(await closed).toBe(4002);
    expect(boss.ws.readyState).toBe(boss.ws.OPEN);
    expect((await api('GET', `/api/servers/${a}`, ami)).statusCode).toBe(404);
    expect((await api('GET', `/api/servers/${b}`, ami)).statusCode).toBe(200);
    // Toujours connecté : changer les portées ne révoque pas la session, l'accès si.
    expect((await api('GET', '/api/auth/me', ami)).statusCode).toBe(200);
    boss.close();
  });

  it('rétrogradation : les portées redescendent avec le rôle ; un serveur supprimé emporte sa ligne', async () => {
    let res = await api('PATCH', `/api/users/${amiId}`, admin, { role: 'viewer' });
    expect(res.statusCode).toBe(200);
    // Changement de rôle = sessions révoquées (inchangé).
    expect((await api('GET', '/api/auth/me', ami)).statusCode).toBe(401);
    res = await api('GET', `/api/users/${amiId}/grants`, admin);
    expect(res.json<{ grants: UserGrantsDto }>().grants).toEqual({
      servers: [{ serverId: a, role: 'viewer' }],
      machines: [{ machineId: m2, role: 'viewer' }],
    });
    const again = await login(panel, 'ami', 'correct horse battery');
    expect((await api('POST', `/api/servers/${c}/start`, again, {})).statusCode).toBe(403);
    expect((await api('GET', `/api/servers/${c}`, again)).statusCode).toBe(200);
    // Défense en profondeur : une ligne écrite au-dessus du rôle (base modifiée à la main) est
    // plafonnée à la lecture — un lecteur reste lecteur.
    panel.ctx.db
      .update(userMachinePermissions)
      .set({ role: 'operator' })
      .where(eq(userMachinePermissions.userId, amiId))
      .run();
    panel.ctx.permissions.invalidate(amiId);
    expect((await api('POST', `/api/servers/${c}/start`, again, {})).statusCode).toBe(403);

    // Changer l'accès révoque aussi : « tout le panel » rend B visible au lecteur non limité.
    res = await api('PATCH', `/api/users/${amiId}`, admin, { scoped: false });
    expect(res.statusCode).toBe(200);
    expect((await api('GET', '/api/auth/me', again)).statusCode).toBe(401);
    const whole = await login(panel, 'ami', 'correct horse battery');
    expect((await api('GET', `/api/servers/${b}`, whole)).statusCode).toBe(200);

    // Cascade : la ligne de A disparaît avec le serveur.
    panel.ctx.db.delete(serversTable).where(eq(serversTable.id, a)).run();
    res = await api('GET', `/api/users/${amiId}/grants`, admin);
    expect(res.json<{ grants: UserGrantsDto }>().grants.servers).toEqual([]);
  });
});
