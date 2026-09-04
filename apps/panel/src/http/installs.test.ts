/**
 * Lot 5 — créer un serveur depuis le panel : catalogue servi par des fournisseurs simulés, plan
 * construit par le panel (l'agent n'en décide rien), ligne créée AVANT l'installation et arrêtée,
 * issue de la task, `install_failed` terminal, mode réparer, et le droit de créer — opérateur sur
 * la MACHINE, ce qui tranche le huitième chantier du lot 8.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProtocolError, ulid, type RequestPayload } from '@mmo/protocol';
import type { ServerDto } from '@mmo/protocol/client';

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

const MANIFEST = {
  latest: { release: '1.20.1', snapshot: '1.20.2-pre1' },
  versions: [
    {
      id: '1.20.2-pre1',
      type: 'snapshot',
      url: 'https://piston.invalid/1.20.2-pre1.json',
      releaseTime: '2023-09-01T10:00:00+00:00',
    },
    {
      id: '1.20.1',
      type: 'release',
      url: 'https://piston.invalid/1.20.1.json',
      releaseTime: '2023-06-12T13:25:51+00:00',
    },
    {
      id: '1.7.10',
      type: 'release',
      url: 'https://piston.invalid/1.7.10.json',
      releaseTime: '2014-05-14T17:29:23+00:00',
    },
  ],
};
const DETAIL = {
  javaVersion: { majorVersion: 17 },
  downloads: {
    server: {
      url: 'https://piston-data.invalid/server.jar',
      sha1: '84194a2f286ef7c14ed7ce0090dba59902951553',
      size: 47_791_053,
    },
  },
};

/** Fournisseurs simulés : aucune requête ne sort, mais tout le chemin réel est exercé. */
function fakeFetch(calls: string[]): typeof fetch {
  return ((input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (url.includes('version_manifest')) return json(MANIFEST);
    if (url.startsWith('https://piston.invalid/')) return json(DETAIL);
    if (url.endsWith('/versions/game')) {
      return json([
        { version: '1.20.1', stable: true },
        { version: '1.20.2-pre1', stable: false },
      ]);
    }
    if (url.endsWith('/versions/installer')) return json([{ version: '1.0.1', stable: true }]);
    if (url.includes('/versions/loader/1.20.1')) {
      return json([
        { loader: { version: '0.16.14', stable: true }, launcherMeta: { min_java_version: 8 } },
      ]);
    }
    if (url.includes('/versions/loader/')) return json([]);
    return Promise.resolve(new Response('nope', { status: 404 }));
  }) as typeof fetch;
}

describe('installation d’un serveur — routes et service du panel', () => {
  let panel: TestPanel;
  let admin: string;
  let calls: string[];
  const agents: FakeAgent[] = [];

  beforeEach(async () => {
    calls = [];
    panel = await createTestPanel({ fetch: fakeFetch(calls) });
    await panel.listen();
    admin = await setupAdmin(panel);
  });
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close().catch(() => undefined);
    await panel.close();
  });

  const api = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    cookie = admin,
  ) =>
    panel.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      headers: { cookie },
    });

  interface Machine {
    id: string;
    agent: FakeAgent;
    installs: RequestPayload<'server.install'>[];
    dirId: string;
    /** Réponse du pré-contrôle (défaut : tout va bien). */
    precheckOk: boolean;
  }

  async function online(
    name: string,
    capabilities = ['tasks', 'server-install'],
  ): Promise<Machine> {
    const res = await api('POST', '/api/machines', { name });
    const { machine, pairing } = res.json<{ machine: { id: string }; pairing: { code: string } }>();
    const pairer = await connectFakeAgent(panel.wsUrl);
    const { secret } = await pairer.peer.request('pair.request', pairPayload(pairing.code));
    await pairer.close();
    const a = await connectFakeAgent(panel.wsUrl);
    agents.push(a);
    const m: Machine = { id: machine.id, agent: a, installs: [], dirId: '', precheckOk: true };
    a.peer.handle('agent.configure', () => ({ applied: true as const }));
    a.peer.handle('event.ack', () => ({}));
    a.peer.handle('task.ackResult', () => ({}));
    a.peer.handle('task.list', () => ({ tasks: [] }));
    a.peer.handle('scan.run', () => ({ scannedPaths: [], servers: [] }));
    a.peer.handle('migration.precheck', () => ({
      ok: m.precheckOk,
      path: { ok: m.precheckOk, ...(m.precheckOk ? {} : { code: 'path_exists' }) },
      port: { ok: true },
      java: { ok: true },
      disk: { ok: true, freeBytes: 10 ** 11 },
    }));
    if (capabilities.includes('server-install')) {
      a.peer.handle('server.install', (req) => {
        m.installs.push(req);
        return { taskId: req.taskId };
      });
    }
    await a.peer.request('auth.hello', helloPayload(machine.id, secret, { capabilities }));
    const dirRes = await api('POST', `/api/machines/${machine.id}/directories`, {
      path: '/srv/minecraft',
    });
    m.dirId = dirRes.json<{ directory: { id: string } }>().directory.id;
    return m;
  }

  const body = (m: Machine, over: Record<string, unknown> = {}) => ({
    directoryId: m.dirId,
    folderName: 'survie',
    loader: 'vanilla',
    mcVersion: '1.20.1',
    maxRamMb: 4096,
    acceptEula: true,
    ...over,
  });

  /** Le faux agent annonce la fin de la task, comme le ferait une vraie installation. */
  function finish(m: Machine, req: RequestPayload<'server.install'>, ok = true): void {
    const common = {
      eventId: ulid(),
      taskId: req.taskId,
      kind: 'server.install',
      serverId: req.serverId,
      startedAt: Date.now() - 100,
      finishedAt: Date.now(),
    };
    if (!ok) {
      m.agent.peer.emit('task.failed', {
        ...common,
        error: { code: 'E_IO', message: 'installer returned a failure', retryable: false },
        cancelled: false,
      });
      return;
    }
    m.agent.peer.emit('task.completed', {
      ...common,
      result: {
        serverId: req.serverId,
        path: req.path,
        steps: req.steps.length,
        files: 3,
        bytes: 1234,
        eulaAccepted: true,
        durationMs: 100,
        detected: {
          path: req.path,
          name: 'survie',
          loader: { value: 'vanilla', confidence: 'high', source: 'jar_name' },
          mcVersion: { value: '1.20.1', confidence: 'high', source: 'jar_manifest' },
          maxRamMb: { value: 4096, confidence: 'medium', source: 'default' },
          eulaAccepted: true,
          launch: { kind: 'jar', jar: 'server.jar' },
          confidence: 'high',
          evidence: [],
        },
      },
    });
  }

  it('catalogue : vanilla depuis Mojang, Fabric restreint à ce que Fabric supporte, avec cache', async () => {
    await online('Tour');
    const vanilla = await api('GET', '/api/install/catalog?loader=vanilla');
    expect(vanilla.statusCode, vanilla.body).toBe(200);
    expect(vanilla.json<{ versions: { id: string }[] }>().versions.map((v) => v.id)).toEqual([
      '1.20.2-pre1',
      '1.20.1',
      '1.7.10',
    ]);
    const fabric = await api('GET', '/api/install/catalog?loader=fabric');
    // 1.7.10 n'est pas dans la liste de Fabric : il ne doit pas être proposé.
    expect(fabric.json<{ versions: { id: string }[] }>().versions.map((v) => v.id)).toEqual([
      '1.20.2-pre1',
      '1.20.1',
    ]);
    const before = calls.length;
    await api('GET', '/api/install/catalog?loader=vanilla');
    expect(calls.length).toBe(before);
  });

  it('vanilla : plan à une étape, ligne créée arrêtée avant l’installation, puis confirmée', async () => {
    const m = await online('Tour');
    const res = await api('POST', `/api/machines/${m.id}/install`, body(m));
    expect(res.statusCode, res.body).toBe(202);
    const server = res.json<{ server: ServerDto }>().server;
    expect(server.provisioning).toBe('installing');
    expect(server.detected).toBe(false);
    expect(server.desiredState).toBe('stopped');
    expect(server.path).toBe('/srv/minecraft/survie');
    expect(server.gamePort).toBe(25565);

    await waitFor(() => m.installs.length === 1, 5_000);
    const req = m.installs[0];
    if (req === undefined) throw new Error('aucune installation reçue');
    expect(req.path).toBe('/srv/minecraft/survie');
    expect(req.acceptEula).toBe(true);
    expect(req.repair).toBe(false);
    // Le téléchargement du serveur, puis les réglages — et JAMAIS d'étape qui écrirait l'EULA.
    expect(req.steps.map((s) => s.kind)).toEqual(['download', 'setProperties']);
    const download = req.steps[0];
    if (download?.kind !== 'download') throw new Error('première étape inattendue');
    expect(download.sha1).toBe('84194a2f286ef7c14ed7ce0090dba59902951553');
    expect(download.path).toBe('server.jar');
    const props = req.steps[1];
    if (props?.kind !== 'setProperties') throw new Error('seconde étape inattendue');
    expect(props.values['server-port']).toBe('25565');

    finish(m, req);
    await waitFor(() => panel.ctx.servers.require(server.id).provisioning === 'ready', 5_000);
    const row = panel.ctx.servers.require(server.id);
    expect(row.detected).toBe(1);
    expect(row.mcVersion).toBe('1.20.1');
    // L'audit garde qui a accepté l'EULA : c'est le seul endroit où cela se relit.
    const entry = panel.ctx.audit.list(20).find((e) => e.action === 'server.install');
    expect(entry?.details).toMatchObject({ eulaAcceptedBy: 'admin' });
  });

  it('fabric : le lanceur est téléchargé puis exécuté, sous le nom que la détection sait relire', async () => {
    const m = await online('Tour');
    const res = await api(
      'POST',
      `/api/machines/${m.id}/install`,
      body(m, { loader: 'fabric', folderName: 'moddé', motd: 'Chez nous' }),
    );
    expect(res.statusCode, res.body).toBe(400); // « moddé » : accent refusé par le motif
    const ok = await api(
      'POST',
      `/api/machines/${m.id}/install`,
      body(m, { loader: 'fabric', folderName: 'fab', motd: 'Chez nous' }),
    );
    expect(ok.statusCode, ok.body).toBe(202);
    await waitFor(() => m.installs.length === 1, 5_000);
    const req = m.installs[0];
    if (req === undefined) throw new Error('aucune installation reçue');
    expect(req.loader).toBe('fabric');
    expect(req.loaderVersion).toBe('0.16.14');
    expect(req.steps.map((s) => s.kind)).toEqual(['download', 'runJar', 'setProperties']);
    const jar = 'fabric-server-mc.1.20.1-loader.0.16.14-launcher.1.0.1.jar';
    const dl = req.steps[0];
    const run = req.steps[1];
    if (dl?.kind !== 'download' || run?.kind !== 'runJar') throw new Error('plan inattendu');
    expect(dl.path).toBe(jar);
    expect(run.jar).toBe(jar);
    expect(run.args).toEqual(['nogui']);
    // Un lanceur qui sort 0 sans avoir rien installé n'est pas un succès.
    expect(run.expect).toContain('libraries');
    const props = req.steps[2];
    if (props?.kind !== 'setProperties') throw new Error('plan inattendu');
    expect(props.values.motd).toBe('Chez nous');
  });

  it('une version que Fabric ne supporte pas est refusée avant toute écriture', async () => {
    const m = await online('Tour');
    const res = await api(
      'POST',
      `/api/machines/${m.id}/install`,
      body(m, { loader: 'fabric', mcVersion: '1.7.10' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json<{ details?: { reason?: string } }>().details?.reason).toBe('NO_LOADER');
    expect(panel.ctx.servers.list()).toHaveLength(0);
  });

  it('échec de l’installation : le serveur reste install_failed, et un scan ne le promeut jamais', async () => {
    const m = await online('Tour');
    const res = await api('POST', `/api/machines/${m.id}/install`, body(m));
    const server = res.json<{ server: ServerDto }>().server;
    await waitFor(() => m.installs.length === 1, 5_000);
    const req = m.installs[0];
    if (req === undefined) throw new Error('aucune installation reçue');
    finish(m, req, false);
    await waitFor(
      () => panel.ctx.servers.require(server.id).provisioning === 'install_failed',
      5_000,
    );

    // Le dossier existe et paraît complet : un scan ne doit pas le déclarer démarrable.
    await panel.ctx.servers.adoptDetected(
      m.id,
      {
        path: '/srv/minecraft/survie',
        name: 'survie',
        markerServerId: server.id,
        loader: { value: 'vanilla', confidence: 'high', source: 'jar_name' },
        mcVersion: { value: '1.20.1', confidence: 'high', source: 'jar_manifest' },
        maxRamMb: { value: 4096, confidence: 'medium', source: 'default' },
        eulaAccepted: true,
        launch: { kind: 'jar', jar: 'server.jar' },
        confidence: 'high',
        evidence: [],
      },
      undefined,
    );
    expect(panel.ctx.servers.require(server.id).provisioning).toBe('install_failed');

    // Réparer rejoue le même plan, cette fois dans un dossier qui existe.
    const retry = await api('POST', `/api/servers/${server.id}/install/retry`);
    expect(retry.statusCode, retry.body).toBe(202);
    await waitFor(() => m.installs.length === 2, 5_000);
    const again = m.installs[1];
    if (again === undefined) throw new Error('aucune reprise reçue');
    expect(again.repair).toBe(true);
    expect(again.steps.map((s) => s.kind)).toEqual(['download', 'setProperties']);
    expect(panel.ctx.servers.require(server.id).provisioning).toBe('installing');
    finish(m, again);
    await waitFor(() => panel.ctx.servers.require(server.id).provisioning === 'ready', 5_000);
    // Un serveur en règle n'a plus rien à réparer.
    const useless = await api('POST', `/api/servers/${server.id}/install/retry`);
    expect(useless.statusCode).toBe(409);
  });

  it('un refus de l’agent ne laisse aucune ligne derrière lui', async () => {
    const m = await online('Tour');
    m.agent.peer.handle('server.install', () => {
      throw new ProtocolError('E_CONFLICT', 'target directory is not empty', {
        details: { reason: 'PATH_NOT_EMPTY' },
      });
    });
    const res = await api('POST', `/api/machines/${m.id}/install`, body(m));
    expect(res.statusCode).toBe(409);
    expect(panel.ctx.servers.list()).toHaveLength(0);
  });

  it('agent N-1 : 501 lisible, et rien de créé', async () => {
    const m = await online('Vieille', ['tasks']);
    const res = await api('POST', `/api/machines/${m.id}/install`, body(m));
    expect(res.statusCode).toBe(501);
    expect(panel.ctx.servers.list()).toHaveLength(0);
  });

  it('pré-contrôle : chemin final, port et verdict de la machine', async () => {
    const m = await online('Tour');
    const res = await api('POST', `/api/machines/${m.id}/install/precheck`, {
      directoryId: m.dirId,
      folderName: 'survie',
      loader: 'vanilla',
      mcVersion: '1.20.1',
      maxRamMb: 4096,
    });
    expect(res.statusCode, res.body).toBe(200);
    const { precheck } = res.json<{
      precheck: { ok: boolean; target: { path: string; gamePort: number; javaMajor: number } };
    }>();
    expect(precheck.ok).toBe(true);
    expect(precheck.target).toMatchObject({
      path: '/srv/minecraft/survie',
      gamePort: 25565,
      javaMajor: 17,
    });
    m.precheckOk = false;
    const bad = await api('POST', `/api/machines/${m.id}/install/precheck`, {
      directoryId: m.dirId,
      folderName: 'survie',
      loader: 'vanilla',
      mcVersion: '1.20.1',
      maxRamMb: 4096,
    });
    expect(bad.json<{ precheck: { ok: boolean } }>().precheck.ok).toBe(false);
  });

  it('deux serveurs sur la même machine ne partagent pas le port, ni le dossier', async () => {
    const m = await online('Tour');
    const first = await api('POST', `/api/machines/${m.id}/install`, body(m));
    expect(first.statusCode).toBe(202);
    const second = await api('POST', `/api/machines/${m.id}/install`, body(m, { folderName: 'b' }));
    expect(second.statusCode).toBe(202);
    expect(second.json<{ server: ServerDto }>().server.gamePort).toBe(25566);
    // Le même dossier, en revanche, appartient déjà à quelqu'un.
    const again = await api('POST', `/api/machines/${m.id}/install`, body(m));
    expect(again.statusCode).toBe(409);
    expect(again.json<{ details?: { reason?: string } }>().details?.reason).toBe('PATH_TAKEN');
  });

  describe('qui a le droit de créer un serveur (8e chantier du lot 8)', () => {
    /** Compte limité : opérateur sur la machine, ou seulement sur un serveur. */
    async function limited(
      username: string,
      grants: { machines?: { machineId: string; role: string }[] },
    ): Promise<string> {
      const created = await api('POST', '/api/users', {
        username,
        password: 'Mot-de-passe-1234',
        role: 'operator',
        scoped: true,
      });
      const { user } = created.json<{ user: { id: string } }>();
      await api('PUT', `/api/users/${user.id}/grants`, { servers: [], ...grants });
      const login = await panel.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username, password: 'Mot-de-passe-1234' },
      });
      return login.headers['set-cookie']?.toString() ?? '';
    }

    it('opérateur sur la machine : il crée ; sans la machine : la machine n’existe pas pour lui', async () => {
      const m = await online('Tour');
      const other = await online('Grenier');
      const cookie = await limited('paul', {
        machines: [{ machineId: m.id, role: 'operator' }],
      });
      const ok = await api('POST', `/api/machines/${m.id}/install`, body(m), cookie);
      expect(ok.statusCode, ok.body).toBe(202);
      // Une machine hors de sa portée n'existe pas : 404, jamais 403 (pas d'énumération).
      const nope = await api('POST', `/api/machines/${other.id}/install`, body(other), cookie);
      expect(nope.statusCode).toBe(404);
    });

    it('lecteur sur la machine : il regarde, il ne crée pas', async () => {
      const m = await online('Tour');
      const cookie = await limited('lea', { machines: [{ machineId: m.id, role: 'viewer' }] });
      const res = await api('POST', `/api/machines/${m.id}/install`, body(m), cookie);
      expect(res.statusCode).toBe(403);
      expect(panel.ctx.servers.list()).toHaveLength(0);
    });
  });
});
