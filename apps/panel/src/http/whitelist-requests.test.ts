/**
 * Lot 8 — demande de whitelist en libre-service : la surface anonyme (le jeton de la page de
 * statut, un limiteur serré, un formulaire), et le côté opérateur (accepter, refuser, oublier).
 *
 * Ce que ces tests protègent avant tout : **une demande est inerte**. La poster n'appelle ni
 * l'agent ni Mojang, n'écrit aucun fichier de serveur, ne crée pas de doublon quand on insiste.
 * Ce n'est qu'à l'acceptation, par un opérateur, que la chaîne whitelist existante se met en
 * marche — et si elle échoue, la demande reste en attente plutôt que de mentir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  PublicStatus,
  StatusPageDto,
  WhitelistRequestDto,
  WhitelistRequestStatus,
} from '@mmo/protocol/client';

import { runMaintenance } from '../services/maintenance.js';
import {
  connectFakeAgent,
  createTestPanel,
  createUser,
  helloPayload,
  login,
  pairPayload,
  setupAdmin,
  type FakeAgent,
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
    motd: 'Chez les copains',
    eulaAccepted: true,
    launch: { kind: 'jar' as const, jar: 'server.jar' },
    javaRequirement: { majorVersion: 17, strict: false, source: 'table' as const },
    confidence: 'high' as const,
    evidence: [],
  };
}

describe('lot 8 — demande de whitelist en libre-service', () => {
  let panel: TestPanel;
  let admin: string;
  let machineId: string;
  let serverId: string;
  let agent: FakeAgent | undefined;
  /** Tout ce que le panel demande à l'agent : doit rester vide tant que personne n'a accepté. */
  let agentCalls: { type: string; payload: unknown }[] = [];

  const api = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    cookie: string | undefined,
    payload?: unknown,
  ) =>
    panel.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });

  async function statusPage(payload: unknown): Promise<StatusPageDto> {
    const res = await api('PUT', `/api/servers/${serverId}/status-page`, admin, payload);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ statusPage: StatusPageDto }>().statusPage;
  }

  const ask = (token: string, payload: unknown, ip = '203.0.113.9') =>
    panel.app.inject({
      method: 'POST',
      url: `/api/status/${token}/whitelist`,
      payload: payload as Record<string, unknown>,
      remoteAddress: ip,
    });

  async function askOk(
    token: string,
    name: string,
    note?: string,
  ): Promise<WhitelistRequestStatus> {
    const res = await ask(token, { name, ...(note === undefined ? {} : { note }) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ state: WhitelistRequestStatus }>().state;
  }

  async function requests(cookie = admin): Promise<WhitelistRequestDto[]> {
    const res = await api('GET', `/api/servers/${serverId}/whitelist-requests`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ requests: WhitelistRequestDto[] }>().requests;
  }

  async function connectAgent(): Promise<FakeAgent> {
    const res = await api('POST', `/api/machines/${machineId}/pairing-codes`, admin);
    expect(res.statusCode, res.body).toBe(201);
    const { pairing } = res.json<{ pairing: { code: string } }>();
    const pairer = await connectFakeAgent(panel.wsUrl);
    const { secret } = await pairer.peer.request('pair.request', pairPayload(pairing.code));
    await pairer.close();
    const a = await connectFakeAgent(panel.wsUrl);
    a.peer.handle('agent.configure', () => ({ applied: true as const }));
    a.peer.handle('event.ack', () => ({}));
    a.peer.handle('task.ackResult', () => ({}));
    a.peer.handle('task.list', () => ({ tasks: [] }));
    a.peer.handle('backup.list', () => ({ backups: [] }));
    a.peer.handle('player.action', (payload) => {
      agentCalls.push({ type: 'player.action', payload });
      return { applied: 'commands' as const, response: 'Added Alice to the whitelist' };
    });
    a.peer.handle('player.resolve', (payload) => {
      agentCalls.push({ type: 'player.resolve', payload });
      return { players: [], onlineMode: true };
    });
    await a.peer.request(
      'auth.hello',
      helloPayload(machineId, secret, { capabilities: ['rcon', 'tasks', 'backups'] }),
    );
    return a;
  }

  beforeEach(async () => {
    agentCalls = [];
    panel = await createTestPanel();
    await panel.listen();
    admin = await setupAdmin(panel);
    const machine = await api('POST', '/api/machines', admin, { name: 'PC' });
    machineId = machine.json<{ machine: { id: string } }>().machine.id;
    const adopted = await panel.ctx.servers.adoptDetected(
      machineId,
      detected('/srv/copains', 'Copains', 25_565),
      undefined,
    );
    serverId = adopted.server!.id;
  });

  afterEach(async () => {
    if (agent !== undefined) await agent.close().catch(() => undefined);
    agent = undefined;
    await panel.close();
  });

  it('le formulaire n’existe que si l’opérateur l’a ouvert, et la demande ne réveille personne', async () => {
    const page = await statusPage({ enabled: true });
    agent = await connectAgent();

    // Page publiée mais demandes non autorisées : la surface n'existe pas, et elle le dit de la
    // même façon qu'un jeton inventé — un formulaire forgé n'apprend rien.
    const closed = await ask(page.token, { name: 'Alice' });
    expect(closed.statusCode).toBe(404);
    const bogus = await ask('jetoninexistantxxxxxxx', { name: 'Alice' });
    expect(bogus.body).toBe(closed.body);

    const opened = await statusPage({ allowWhitelist: true });
    expect(opened.allowWhitelist).toBe(true);
    const status = await panel.app.inject({ method: 'GET', url: `/api/status/${page.token}` });
    expect(status.json<{ status: PublicStatus }>().status.whitelist).toBe(true);

    expect(await askOk(page.token, 'Alice_42', 'Paul du lycée')).toBe('pending');

    // La demande est INERTE : rien n'a été demandé à l'agent, donc rien à Mojang.
    expect(agentCalls).toEqual([]);
    const list = await requests();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Alice_42', note: 'Paul du lycée', status: 'pending' });
    expect(list[0]?.decidedBy).toBeNull();

    // L'opérateur est prévenu : sans cet événement, l'ami attend indéfiniment.
    const event = panel.ctx.events
      .list({ limit: 20 })
      .find((e) => e.type === 'whitelist.requested');
    expect(event?.serverId).toBe(serverId);
    // Le mot laissé par un inconnu ne part pas en notification ni en webhook.
    expect(JSON.stringify(event?.payload)).toContain('Alice_42');
    expect(JSON.stringify(event?.payload)).not.toContain('lycée');

    // Un pseudo impossible et un mot trop long sont refusés par le schéma.
    expect((await ask(page.token, { name: 'a b' })).statusCode).toBe(400);
    expect((await ask(page.token, { name: 'ab' })).statusCode).toBe(400);
    expect((await ask(page.token, { name: 'Alice', note: 'x'.repeat(201) })).statusCode).toBe(400);
    expect(await requests()).toHaveLength(1);
  });

  it('insister ne crée pas de doublon : une ligne par pseudo, un seul événement', async () => {
    const page = await statusPage({ enabled: true, allowWhitelist: true });
    expect(await askOk(page.token, 'Alice')).toBe('pending');
    expect(await askOk(page.token, 'alice')).toBe('pending');
    expect(await askOk(page.token, 'ALICE')).toBe('pending');
    expect(await requests()).toHaveLength(1);
    expect(
      panel.ctx.events.list({ limit: 50 }).filter((e) => e.type === 'whitelist.requested'),
    ).toHaveLength(1);

    // Un autre pseudo est bien une autre demande.
    expect(await askOk(page.token, 'Bob')).toBe('pending');
    expect(await requests()).toHaveLength(2);
  });

  it('accepter passe par la chaîne whitelist existante ; sans agent, rien n’est promis', async () => {
    const page = await statusPage({ enabled: true, allowWhitelist: true });
    await askOk(page.token, 'Alice');
    const [pending] = await requests();

    // Agent absent : l'ajout ne peut pas avoir lieu, la demande reste en attente. Une ligne
    // « acceptée » sans personne sur la liste blanche ne se découvrirait qu'à la connexion.
    const offline = await api(
      'POST',
      `/api/servers/${serverId}/whitelist-requests/${pending!.id}/accept`,
      admin,
    );
    expect(offline.statusCode).toBe(503);
    expect((await requests())[0]?.status).toBe('pending');

    agent = await connectAgent();
    const accepted = await api(
      'POST',
      `/api/servers/${serverId}/whitelist-requests/${pending!.id}/accept`,
      admin,
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<{ applied: string }>().applied).toBe('commands');

    // L'action est celle de l'onglet Joueurs, pas une écriture de fichier improvisée.
    expect(agentCalls).toEqual([
      {
        type: 'player.action',
        payload: expect.objectContaining({
          serverId,
          action: 'whitelistAdd',
          target: 'Alice',
        }) as unknown,
      },
    ]);
    const list = await requests();
    expect(list[0]).toMatchObject({ status: 'accepted', decidedBy: 'admin' });
    expect(list[0]?.decidedAt).not.toBeNull();

    const entry = panel.ctx.audit.list(20).find((e) => e.action === 'whitelist.accepted');
    expect(entry?.targetId).toBe(serverId);
    expect(JSON.stringify(entry?.details)).toContain('Alice');

    // L'ami qui revient sur la page apprend qu'il peut se connecter : c'est la seule façon.
    expect(await askOk(page.token, 'Alice')).toBe('accepted');
  });

  it('refuser, puis oublier : la personne peut redemander', async () => {
    const page = await statusPage({ enabled: true, allowWhitelist: true });
    await askOk(page.token, 'Bob');
    const [pending] = await requests();

    // Refuser ne demande aucun agent : rien n'est à faire sur le serveur.
    const rejected = await api(
      'POST',
      `/api/servers/${serverId}/whitelist-requests/${pending!.id}/reject`,
      admin,
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect((await requests())[0]).toMatchObject({ status: 'rejected', decidedBy: 'admin' });
    expect(await askOk(page.token, 'Bob')).toBe('rejected');
    expect(panel.ctx.audit.list(20).some((e) => e.action === 'whitelist.rejected')).toBe(true);

    const deleted = await api(
      'DELETE',
      `/api/servers/${serverId}/whitelist-requests/${pending!.id}`,
      admin,
    );
    expect(deleted.statusCode).toBe(204);
    expect(await requests()).toHaveLength(0);
    // Oublier une demande refusée est le geste par lequel on dit « on en reparle ».
    expect(await askOk(page.token, 'Bob')).toBe('pending');
  });

  it('un lecteur regarde sans trancher, et un identifiant ne traverse pas les serveurs', async () => {
    const page = await statusPage({ enabled: true, allowWhitelist: true });
    await askOk(page.token, 'Alice');
    const [pending] = await requests();

    await createUser(panel, admin, {
      username: 'lecteur',
      password: 'correct horse battery',
      role: 'viewer',
    });
    const viewer = await login(panel, 'lecteur', 'correct horse battery');
    expect(await requests(viewer)).toHaveLength(1);
    expect(
      (
        await api(
          'POST',
          `/api/servers/${serverId}/whitelist-requests/${pending!.id}/accept`,
          viewer,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api(
          'POST',
          `/api/servers/${serverId}/whitelist-requests/${pending!.id}/reject`,
          viewer,
        )
      ).statusCode,
    ).toBe(403);

    // Une demande vue depuis un AUTRE serveur n'existe pas.
    const other = await panel.ctx.servers.adoptDetected(
      machineId,
      detected('/srv/autre', 'Autre', 25_566),
      undefined,
    );
    expect(
      (
        await api(
          'POST',
          `/api/servers/${other.server!.id}/whitelist-requests/${pending!.id}/reject`,
          admin,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('l’écriture anonyme est bien plus serrée que la lecture, et par adresse', async () => {
    const page = await statusPage({ enabled: true, allowWhitelist: true });
    let limited = 0;
    for (let i = 0; i < 20; i += 1) {
      const res = await ask(page.token, { name: `Ami${String(i)}` }, '198.51.100.7');
      if (res.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    // Le compteur de la lecture est distinct : consulter la page reste possible.
    expect(
      (
        await panel.app.inject({
          method: 'GET',
          url: `/api/status/${page.token}`,
          remoteAddress: '198.51.100.7',
        })
      ).statusCode,
    ).toBe(200);
    // Et une autre adresse n'est pas punie pour autant.
    expect(await askOk(page.token, 'Zoe', undefined)).toBe('pending');
  });

  it('la maintenance borne les demandes tranchées, jamais celles qui attendent', async () => {
    const server = { id: serverId, machineId };
    for (const name of ['A_un', 'B_deux', 'C_trois', 'D_quatre']) {
      panel.ctx.whitelistRequests.submit(server, { name });
    }
    const all = await requests();
    const adminId = panel.ctx.users.list()[0]!.id;
    for (const row of all.slice(0, 3)) {
      panel.ctx.whitelistRequests.decide(serverId, row.id, 'rejected', adminId);
      panel.clock.advance(1000);
    }
    // Le rapport de maintenance nomme la table : c'est ce qui prouve que la purge est branchée.
    expect(runMaintenance(panel.ctx).purged).toHaveProperty('whitelist_requests');

    expect(panel.ctx.whitelistRequests.purgeDecided(1)).toBe(2);
    const left = await requests();
    expect(left.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(left.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});
