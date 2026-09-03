/**
 * Lot 8 — page de statut publique : réglage par serveur (opérateur), lien non devinable, contenu
 * publié (état, adresse, version, MOTD, joueurs, prochaine sauvegarde) et surtout ce qui NE sort
 * pas — chemin disque, machine, identifiants, pseudos sans opt-in. Repli par ping Minecraft quand
 * l'agent n'est plus là, cache court, rotation du lien, page désactivée, limiteur par adresse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ulid } from '@mmo/protocol';
import type { PublicStatus, ReachabilityResult, StatusPageDto } from '@mmo/protocol/client';

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

const OK_PING: ReachabilityResult = {
  address: '100.64.0.5:25565',
  ok: true,
  ms: 12,
  error: null,
  status: { version: '1.20.1', protocol: 763, online: 3, max: 20, motd: 'Ping MOTD' },
};

describe('lot 8 — page de statut publique', () => {
  let panel: TestPanel;
  let admin: string;
  let machineId: string;
  let serverId: string;
  let agent: FakeAgent | undefined;
  const ping = vi.fn<(address: string, timeoutMs: number) => Promise<ReachabilityResult>>();

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

  async function publicStatus(token: string, ip = '203.0.113.9'): Promise<PublicStatus> {
    const res = await panel.app.inject({
      method: 'GET',
      url: `/api/status/${token}`,
      remoteAddress: ip,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ status: PublicStatus }>().status;
  }

  /** Agent authentifié sur la machine : le panel se sert de ce qu'il sait, sans ping. */
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
    await a.peer.request(
      'auth.hello',
      helloPayload(machineId, secret, { capabilities: ['rcon', 'tasks', 'backups'] }),
    );
    return a;
  }

  beforeEach(async () => {
    ping.mockReset();
    ping.mockResolvedValue(OK_PING);
    panel = await createTestPanel({ statusPages: { ping, cacheMs: 15_000 } });
    await panel.listen();
    admin = await setupAdmin(panel);
    const machine = await api('POST', '/api/machines', admin, { name: 'PC' });
    machineId = machine.json<{ machine: { id: string } }>().machine.id;
    // Une adresse tailnet connue : c'est elle que la page publie et que le ping de repli vise.
    await api('PATCH', `/api/machines/${machineId}`, admin, { tailnetHost: '100.64.0.5' });
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

  it('publie un lien non devinable, sert la page sans compte, et ne dit rien du panel', async () => {
    // Pas de page tant qu'on n'en a pas demandé une.
    const before = await api('GET', `/api/servers/${serverId}/status-page`, admin);
    expect(before.json<{ statusPage: unknown }>().statusPage).toBeNull();

    const page = await statusPage({ enabled: true });
    expect(page.token).toHaveLength(22);
    expect(page.path).toBe(`/s/${page.token}`);
    // Sans URL publique réglée, le panel ne devine pas la sienne : c'est le front qui complète.
    expect(page.url).toBeNull();
    expect(page.showPlayers).toBe(false);

    agent = await connectAgent();
    const status = await publicStatus(page.token);
    expect(status.name).toBe('Copains');
    expect(status.state).toBe('offline');
    expect(status.address).toBe('100.64.0.5:25565');
    expect(status.version).toBe('1.20.1');
    expect(status.loader).toBe('vanilla');
    expect(status.motd).toBe('Chez les copains');
    expect(status.source).toBe('agent');
    // Ce qui ne doit JAMAIS sortir : chemin disque, machine, identifiants internes.
    const raw = JSON.stringify(status);
    expect(raw).not.toContain('/srv/copains');
    expect(raw).not.toContain(machineId);
    expect(raw).not.toContain(serverId);
    expect(raw).not.toContain('pid');

    // Le journal d'audit nomme l'action, jamais le lien.
    const entry = panel.ctx.audit.list(20).find((e) => e.action === 'server.statusPage');
    expect(entry?.targetId).toBe(serverId);
    expect(JSON.stringify(entry?.details)).toContain('"enabled":true');
    expect(JSON.stringify(entry)).not.toContain(page.token);

    // Désactivée : le lien meurt, sans dire qu'il a existé. Réactivée : le même lien revient.
    await statusPage({ enabled: false });
    const off = await panel.app.inject({ method: 'GET', url: `/api/status/${page.token}` });
    expect(off.statusCode).toBe(404);
    const unknown = await panel.app.inject({ method: 'GET', url: '/api/status/inconnu' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toBe(off.body);
    const again = await statusPage({ enabled: true });
    expect(again.token).toBe(page.token);

    // Un serveur archivé n'a plus de page : le lien retombe sur le même 404.
    await panel.ctx.servers.update(serverId, { provisioning: 'archived' });
    expect(
      (await panel.app.inject({ method: 'GET', url: `/api/status/${page.token}` })).statusCode,
    ).toBe(404);
  });

  it('ne publie les pseudos qu’avec l’opt-in, et compte les joueurs sans les nommer', async () => {
    const page = await statusPage({ enabled: true });
    agent = await connectAgent();
    panel.ctx.servers.applyStateChanged(
      { eventId: ulid(), serverId, ts: panel.clock.now(), state: 'running', pid: 4242 },
      machineId,
    );
    for (const name of ['Alice', 'Bob']) {
      panel.ctx.servers.applyPlayerEvent(
        { eventId: ulid(), serverId, ts: panel.clock.now(), kind: 'join', name, online: 2 },
        machineId,
      );
    }

    const anonymous = await publicStatus(page.token);
    expect(anonymous.state).toBe('online');
    expect(anonymous.players.online).toBe(2);
    expect(anonymous.players.named).toBe(false);
    expect(anonymous.players.names).toEqual([]);
    expect(JSON.stringify(anonymous)).not.toContain('Alice');

    // L'opt-in change ce qui est publié : le cache ne doit pas retenir l'ancienne version.
    await statusPage({ showPlayers: true });
    const named = await publicStatus(page.token);
    expect(named.players.named).toBe(true);
    expect(named.players.names).toEqual(['Alice', 'Bob']);

    // Prochaine sauvegarde : l'heure, jamais la destination.
    panel.ctx.backups.createPolicy(serverId, { cron: '0 4 * * *', keepLast: 7 });
    await statusPage({ showPlayers: true });
    const withBackup = await publicStatus(page.token);
    expect(withBackup.nextBackupAt).toBeGreaterThan(panel.clock.now());
    expect(JSON.stringify(withBackup)).not.toContain('destination');
  });

  it('interroge le serveur lui-même quand l’agent n’est plus là, une fois par fenêtre de cache', async () => {
    const page = await statusPage({ enabled: true, showPlayers: true });
    // Aucun agent connecté : le serveur Java, lui, survit à son agent.
    const first = await publicStatus(page.token);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(ping.mock.calls[0]?.[0]).toBe('100.64.0.5:25565');
    expect(first.source).toBe('ping');
    expect(first.state).toBe('online');
    expect(first.motd).toBe('Ping MOTD');
    expect(first.players).toEqual({ online: 3, max: 20, names: [], named: true });

    // Dix amis qui rafraîchissent = un seul ping.
    await publicStatus(page.token);
    await publicStatus(page.token);
    expect(ping).toHaveBeenCalledTimes(1);

    // Passé le cache, on redemande — et un serveur qui ne répond plus est « hors ligne ».
    panel.clock.advance(16_000);
    ping.mockResolvedValue({
      address: '100.64.0.5:25565',
      ok: false,
      ms: 3000,
      error: 'timeout',
      status: null,
    });
    const later = await publicStatus(page.token);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(later.state).toBe('offline');
    expect(later.source).toBe('ping');
    expect(later.players.online).toBeNull();

    // Un ping qui explose ne fait pas tomber la page.
    panel.clock.advance(16_000);
    ping.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await publicStatus(page.token)).state).toBe('offline');
  });

  it('change de lien, refuse un lecteur et limite les visiteurs trop pressés', async () => {
    const page = await statusPage({ enabled: true });
    const rotated = await api('POST', `/api/servers/${serverId}/status-page/rotate`, admin);
    expect(rotated.statusCode, rotated.body).toBe(200);
    const next = rotated.json<{ statusPage: StatusPageDto }>().statusPage;
    expect(next.token).not.toBe(page.token);
    expect(
      (await panel.app.inject({ method: 'GET', url: `/api/status/${page.token}` })).statusCode,
    ).toBe(404);
    await publicStatus(next.token);
    expect(panel.ctx.audit.list(20).some((e) => e.action === 'server.statusPageRotated')).toBe(
      true,
    );

    // Un lecteur ne publie rien.
    await createUser(panel, admin, {
      username: 'lecteur',
      password: 'correct horse battery',
      role: 'viewer',
    });
    const viewer = await login(panel, 'lecteur', 'correct horse battery');
    expect(
      (await api('PUT', `/api/servers/${serverId}/status-page`, viewer, { enabled: false }))
        .statusCode,
    ).toBe(403);
    expect(
      (await api('POST', `/api/servers/${serverId}/status-page/rotate`, viewer)).statusCode,
    ).toBe(403);

    // Limiteur public par adresse : un scan de jetons coûte, y compris sur des jetons mal formés.
    let limited = 0;
    for (let i = 0; i < 130; i += 1) {
      const res = await panel.app.inject({
        method: 'GET',
        url: `/api/status/x${String(i)}`,
        remoteAddress: '198.51.100.7',
      });
      if (res.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    // Une autre adresse n'est pas punie pour autant.
    await publicStatus(next.token, '203.0.113.4');
  });
});
