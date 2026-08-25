/**
 * Phase 9 avec panel + **deux agents réels** in-process :
 * - migration d'un serveur (en marche) de la machine A vers la machine B : pré-checks, export
 *   `pre_migration` (table `backups`), import en **direct** (listener one-shot), bascule de propriété
 *   en base, configurations poussées, `migration.finalize` (`.migrated-<date>`), relance sur la cible,
 *   diffusion `migration.update` ; puis migration retour en **relais** (adresses directes neutralisées) ;
 * - `java.install` : chaîne de sources décidée par le panel (API fournisseur simulée : Temurin 404 →
 *   Zulu) et mode **relais** (archive mise en cache et servie par `/api/relay/:token` avec `Range`) ;
 * - releases d'agent : publication d'un bundle signé (clé de test), `POST /api/machines/:id/update`
 *   → `agent.update` accepté (versions/<v>/agent.js + next.json, sortie 75 injectée), signature
 *   invalide refusée, `agent.updateResult` (rollback) journalisé en événement + audit, `autoUpdate`.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JavaRuntimeDto, MigrationDto, ServerDto, TaskDto } from '@mmo/protocol/client';

import { Agent, AGENT_VERSION } from '../../../agent/src/agent.js';
import { Logger } from '../../../agent/src/log.js';
import { probeJavaVersion } from '../../../agent/src/platform/java.js';
import { buildTarGz, buildZip } from '../../../agent/src/test/helpers.js';
import {
  connectClient,
  createTestPanel,
  freePort,
  setupAdmin,
  tmpDir,
  waitFor,
  type TestPanel,
} from '../test/helpers.js';

const FAKE_SERVER = path.resolve(import.meta.dirname, '../../../agent/test/fake-java-server.mjs');
const EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface Msg {
  type: string;
  [k: string]: unknown;
}

describe('phase 9 — panel ↔ deux agents réels', () => {
  let panel: TestPanel;
  let admin: string;
  let cleanups: (() => Promise<void>)[] = [];
  let agents: Agent[] = [];
  let machineA: string;
  let machineB: string;
  let rootA: string;
  let rootB: string;
  let server: ServerDto;
  /** Faux fournisseur Java + hébergement de fichiers (API Temurin/Zulu simulées). */
  let vendor: http.Server;
  let vendorOrigin: string;
  let vendorFiles: Map<string, Buffer>;
  let vendorHits: string[];
  let exits: { agentId: string; code: number }[];
  /** Adresses annoncées par `transfer.serve` par machine (test du repli relais). */
  let serveAddrs: Record<string, string[]>;
  let client: Awaited<ReturnType<typeof connectClient>> | undefined;

  beforeEach(async () => {
    exits = [];
    serveAddrs = {};
    vendorFiles = new Map();
    vendorHits = [];
    vendor = http.createServer((req, res) => {
      const url = req.url ?? '';
      vendorHits.push(url);
      const key = url.split('?')[0] ?? '';
      const data = vendorFiles.get(key);
      if (!data) {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Length': String(data.byteLength) }).end(data);
    });
    const vport = await freePort();
    await new Promise<void>((r) => {
      vendor.listen(vport, '127.0.0.1', r);
    });
    vendorOrigin = `http://127.0.0.1:${String(vport)}`;

    const d = await tmpDir('mmo-p9-data-');
    panel = await createTestPanel({
      now: () => Date.now(),
      // Warns visibles : un échec intermittent CI (« critical event handler failed ») n'est
      // diagnosticable que si le panel raconte pourquoi le handler a levé.
      logger: { level: 'warn' },
      config: { heartbeatIntervalSec: 1, offlineAfterMs: 10_000, dataDir: d.dir },
      schedulerTickMs: 0,
      transferReconnectWaitMs: 3000,
      migrationTtlMs: 120_000,
      // Les appels sortants du panel (API fournisseurs) sont redirigés vers le faux fournisseur.
      fetch: (input, init) => {
        const url = new URL(typeof input === 'string' ? input : (input as URL).toString());
        if (url.hostname === '127.0.0.1') return fetch(input, init);
        const rewritten = `${vendorOrigin}/vendor${url.pathname}${url.search}`;
        return fetch(rewritten, init);
      },
    });
    await panel.listen();
    admin = await setupAdmin(panel);
    const a = await tmpDir('mmo-p9-a-');
    const b = await tmpDir('mmo-p9-b-');
    cleanups = [d.cleanup, a.cleanup, b.cleanup];
    rootA = path.join(a.dir, 'servers');
    rootB = path.join(b.dir, 'servers');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });

    const dir = path.join(rootA, 'Survie');
    await mkdir(path.join(dir, 'world', 'region'), { recursive: true });
    await mkdir(path.join(dir, 'logs'), { recursive: true });
    await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
    await writeFile(
      path.join(dir, 'server.properties'),
      `server-port=${String(await freePort())}\n`,
    );
    await writeFile(path.join(dir, 'server.jar'), '');
    await writeFile(path.join(dir, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(300_000, 7));
    await writeFile(
      path.join(dir, 'logs', 'latest.log'),
      '[10:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.1\n',
    );

    machineA = await createMachineWithAgent('Tour', path.join(a.dir, 'state'), rootA);
    machineB = await createMachineWithAgent('Pi', path.join(b.dir, 'state'), rootB);
    const res = await api('POST', `/api/machines/${machineA}/scan`, {});
    server = res.json<{ servers: ServerDto[] }>().servers[0]!;
    await waitFor(() => agents[0]!.store.get().servers[server.id] !== undefined, 10_000);
  });
  afterEach(async () => {
    client?.close();
    client = undefined;
    for (const agent of agents) await agent.stop();
    agents = [];
    await panel.close();
    await new Promise<void>((r) => {
      vendor.close(() => {
        r();
      });
    });
    for (const c of cleanups) await c();
  });

  async function createMachineWithAgent(name: string, stateDir: string, root: string) {
    let res = await api('POST', '/api/machines', { name });
    const { machine, pairing } = res.json<{ machine: { id: string }; pairing: { code: string } }>();
    const rconFrom = await freePort();
    const agent = new Agent({
      stateDir,
      panelUrl: `${panel.wsUrl}/ws/agent`,
      pairCode: pairing.code,
      logger: new Logger('agent', { stderr: false }),
      scanIntervalMs: 0,
      trashPurgeIntervalMs: 0,
      metricsIntervalMs: 0,
      backupSchedulerTickMs: 0,
      saveSettleMs: 200,
      restrictPermissions: false,
      backoff: { baseMs: 50, maxMs: 200 },
      serveAddresses: () => serveAddrs[machine.id] ?? ['127.0.0.1'],
      agentHome: path.join(stateDir, 'home'),
      updatePublicKeys: [signing.pub],
      exit: (code) => {
        exits.push({ agentId: machine.id, code });
      },
      // Faux JRE (fichier texte `major=N`) ; sinon vraie sonde (JDK de la machine de test).
      javaProbe: async (p) => {
        const content = await readFile(p, 'utf8').catch(() => '');
        const m = /major=(\d+)/.exec(content);
        return m
          ? { majorVersion: Number(m[1]), fullVersion: `${m[1] ?? ''}.0.1`, vendor: 'zulu' }
          : probeJavaVersion(p);
      },
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
        rconProbeIntervalMs: 200,
        exitPollMs: 100,
      },
    });
    await mkdir(path.join(stateDir, 'home'), { recursive: true });
    agents.push(agent);
    await agent.start();
    await waitFor(() => panel.ctx.registry.isConnected(machine.id), 10_000);
    res = await api('POST', `/api/machines/${machine.id}/directories`, { path: root });
    expect(res.statusCode).toBe(201);
    return machine.id;
  }

  const signing = (() => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      signOf: (data: Buffer) => sign(null, data, privateKey).toString('base64'),
    };
  })();

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

  async function waitMigration(id: string): Promise<MigrationDto> {
    await waitFor(() => {
      const m = panel.ctx.migrations.get(id);
      return m !== undefined && (m.status === 'done' || m.status === 'failed');
    }, 60_000);
    return panel.ctx.migrations.toDto(panel.ctx.migrations.require(id));
  }

  it('migration A → B en direct (serveur en marche), puis retour B → A en relais', async () => {
    client = await connectClient(panel.wsUrl, admin);
    const msgs = client.messages as Msg[];
    await api('POST', `/api/servers/${server.id}/start`);
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'running', 15_000);

    // Pré-checks : dossier libre, port libre, Java (fake) présent.
    let res = await api('POST', `/api/servers/${server.id}/migrations/precheck`, {
      toMachineId: machineB,
    });
    expect(res.statusCode).toBe(200);
    const pre = res.json<{ precheck: { ok: boolean; toPath: string } }>().precheck;
    expect(pre.toPath).toBe(path.join(rootB, 'Survie'));
    expect(pre, JSON.stringify(pre)).toMatchObject({ ok: true });

    res = await api('POST', `/api/servers/${server.id}/migrations`, {
      toMachineId: machineB,
      restartAfter: true,
      announce: 'Migration !',
    });
    expect(res.statusCode).toBe(202);
    const started = res.json<{ migration: MigrationDto }>().migration;
    expect(['pending', 'backing_up']).toContain(started.status);
    expect(panel.ctx.servers.require(server.id).provisioning).toBe('migrating');
    // Un démarrage pendant la migration est refusé.
    res = await api('POST', `/api/servers/${server.id}/start`);
    expect(res.statusCode).toBe(409);

    const done = await waitMigration(started.id);
    expect(done.status).toBe('done');
    expect(done.mode).toBe('direct');
    expect(done.sourcePath).toMatch(/Survie\.migrated-\d{8}-\d{4}$/);
    expect(done.toPath).toBe(path.join(rootB, 'Survie'));

    // Bascule en base : le serveur appartient à B, au nouveau chemin, `ready`, relancé.
    const moved = panel.ctx.servers.require(server.id);
    expect(moved.machineId).toBe(machineB);
    expect(moved.path).toBe(path.join(rootB, 'Survie'));
    expect(moved.provisioning).toBe('ready');
    expect(moved.desiredState).toBe('running');
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'running', 15_000);
    expect(agents[1]!.manager.get(server.id)?.isRunning).toBe(true);
    expect(agents[0]!.store.getServer(server.id)).toBeUndefined();
    // Données : le monde est sur B, le dossier source renommé sans marqueur.
    expect(
      (await readFile(path.join(rootB, 'Survie', 'world', 'region', 'r.0.0.mca'))).byteLength,
    ).toBe(300_000);
    expect((await readdir(done.sourcePath!)).includes('.mmo-server.json')).toBe(false);
    await expect(stat(path.join(rootA, 'Survie'))).rejects.toThrow();
    // Backup pre_migration enregistré côté panel (machine A).
    const backups = panel.ctx.backups.list(server.id);
    expect(backups.some((b) => b.kind === 'pre_migration' && b.status === 'success')).toBe(true);
    // Tasks export + import terminées, diffusion WS des étapes.
    expect(panel.ctx.tasks.require(done.exportTaskId!).status).toBe('done');
    expect(panel.ctx.tasks.require(done.importTaskId!).status).toBe('done');
    await waitFor(() =>
      msgs.some(
        (m) => m.type === 'migration.update' && (m.migration as MigrationDto).status === 'done',
      ),
    );
    const statuses = new Set(
      msgs
        .filter((m) => m.type === 'migration.update')
        .map((m) => (m.migration as MigrationDto).status),
    );
    expect(statuses.has('backing_up')).toBe(true);
    expect(statuses.has('transferring')).toBe(true);
    res = await api('GET', `/api/servers/${server.id}/migrations`);
    expect(res.json<{ migrations: MigrationDto[] }>().migrations[0]?.id).toBe(started.id);

    // Retour B → A en **relais** : l'agent source n'annonce aucune adresse directe.
    await api('POST', `/api/servers/${server.id}/stop`, {});
    await waitFor(() => panel.ctx.servers.require(server.id).runState === 'stopped', 15_000);
    serveAddrs[machineB] = ['203.0.113.1'];
    res = await api('POST', `/api/servers/${server.id}/migrations`, {
      toMachineId: machineA,
      restartAfter: true,
    });
    expect(res.statusCode).toBe(202);
    const back = await waitMigration(res.json<{ migration: MigrationDto }>().migration.id);
    expect(back.status).toBe('done');
    expect(back.mode).toBe('relay');
    expect(panel.ctx.servers.require(server.id).machineId).toBe(machineA);
    expect(panel.ctx.servers.require(server.id).path).toBe(path.join(rootA, 'Survie'));
    // Le serveur était arrêté : pas relancé.
    expect(panel.ctx.servers.require(server.id).desiredState).toBe('stopped');
    expect(agents[0]!.store.getServer(server.id)?.config.path).toBe(path.join(rootA, 'Survie'));
    expect(panel.ctx.relayTokens.size).toBe(0);
  }, 120_000);

  it('java.install : chaîne Temurin (404) → Zulu, puis relais panel avec Range', async () => {
    // L'agent extrait selon `archiveFor(os)` : zip sous Windows, tar.gz ailleurs (CI Linux/macOS).
    const buildArchive = process.platform === 'win32' ? buildZip : buildTarGz;
    const zip = buildArchive([
      { name: 'zulu17-jre/', data: Buffer.alloc(0) },
      { name: `zulu17-jre/bin/${EXE}`, data: Buffer.from('#!fake major=17'), deflate: true },
      { name: 'zulu17-jre/lib/modules', data: Buffer.alloc(20_000, 3), deflate: true },
    ]);
    vendorFiles.set('/zulu.zip', zip);
    vendorFiles.set(
      '/vendor/metadata/v1/zulu/packages/',
      Buffer.from(
        JSON.stringify([
          {
            package_uuid: 'u1',
            download_url: `${vendorOrigin}/zulu.zip`,
            java_version: [17, 0, 12],
          },
        ]),
      ),
    );
    vendorFiles.set(
      '/vendor/metadata/v1/zulu/packages/u1',
      Buffer.from(JSON.stringify({ sha256_hash: sha256(zip) })),
    );

    let res = await api('POST', `/api/machines/${machineB}/java/install`, { majorVersion: 17 });
    expect(res.statusCode).toBe(202);
    const first = res.json<{
      task: TaskDto;
      sources: { vendor: string; relay: boolean; emulated: boolean }[];
    }>();
    // Sur hôte ARM, le mock (aveugle à l'arch) répond aussi au candidat « x64 émulé » : il s'ajoute
    // en dernier recours derrière la source native, conformément à la chaîne de doc 03.
    expect(first.sources[0]).toEqual({
      vendor: 'zulu',
      emulated: false,
      relay: false,
      fullVersion: '17.0.12',
    });
    for (const s of first.sources.slice(1)) expect(s.emulated).toBe(true);
    expect(vendorHits.some((h) => h.startsWith('/vendor/v3/assets/latest/17/hotspot'))).toBe(true);
    await waitFor(() => panel.ctx.tasks.require(first.task.id).status === 'done', 30_000);
    const result = panel.ctx.tasks.toDto(panel.ctx.tasks.require(first.task.id)).result!;
    expect(result.vendor).toBe('zulu');
    const runtime = result.runtime as { path: string; managed: boolean };
    expect(runtime.managed).toBe(true);
    expect(runtime.path).toContain(path.join('java', '17-zulu'));
    // L'inventaire du panel reflète le JRE géré.
    res = await api('GET', `/api/machines/${machineB}/java`);
    const runtimes = res.json<{ runtimes: JavaRuntimeDto[] }>().runtimes;
    const managed = runtimes.find((r) => r.managed);
    expect(managed).toMatchObject({ majorVersion: 17, vendor: 'zulu', path: runtime.path });

    // Suppression (gérée seulement).
    res = await api('DELETE', `/api/machines/${machineB}/java/${managed!.id}`);
    expect(res.statusCode).toBe(204);
    await expect(stat(path.dirname(path.dirname(runtime.path)))).rejects.toThrow();

    // Mode relais : le panel met l'archive en cache et l'agent la télécharge via /api/relay avec Range.
    res = await api('POST', `/api/machines/${machineB}/java/install`, {
      majorVersion: 17,
      relay: true,
    });
    expect(res.statusCode).toBe(202);
    const relayed = res.json<{ task: TaskDto; sources: { relay: boolean }[] }>();
    expect(relayed.sources[0]?.relay).toBe(true);
    await waitFor(() => panel.ctx.tasks.require(relayed.task.id).status === 'done', 30_000);
    // L'extension du cache suit archiveFor(os) : .zip sous Windows, .tar.gz ailleurs.
    expect(
      (await readdir(panel.ctx.javaRuntimes.cacheDir)).some((f) => /\.(zip|tar\.gz)$/.test(f)),
    ).toBe(true);
    // Le jeton relais répond aux requêtes partielles (reprise).
    const token = [
      ...(panel.ctx.relayTokens as unknown as { entries: Map<string, unknown> }).entries.keys(),
    ][0]!;
    const partial = await fetch(`${panel.baseUrl}/api/relay/${token}`, {
      headers: { range: 'bytes=100-199' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 100-199/${String(zip.byteLength)}`);
    expect((await partial.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch(`${panel.baseUrl}/api/relay/${'0'.repeat(32)}`)).status).toBe(404);
  }, 60_000);

  it('releases : publication signée, agent.update accepté, signature invalide refusée, updateResult', async () => {
    const bundle = Buffer.from('console.log("mmo agent 9.9.9");\n');
    let res = await panel.app.inject({
      method: 'PUT',
      url: `/api/admin/agent-releases?version=9.9.9&signature=${encodeURIComponent(signing.signOf(bundle))}&notes=test`,
      headers: { cookie: admin, 'content-type': 'application/octet-stream' },
      payload: bundle,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ release: { sha256: string; size: number } }>().release).toMatchObject({
      sha256: sha256(bundle),
      size: bundle.byteLength,
    });
    res = await api('GET', `/api/machines/${machineA}`);
    expect(
      res.json<{
        machine: { updateAvailable: boolean; latestRelease: string; runtimeVersion: string };
      }>().machine,
    ).toMatchObject({
      updateAvailable: true,
      latestRelease: '9.9.9',
      runtimeVersion: process.version.replace(/^v/, ''),
    });

    res = await api('POST', `/api/machines/${machineA}/update`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: '9.9.9', alreadyCurrent: false });
    await waitFor(() => exits.some((e) => e.agentId === machineA && e.code === 75), 15_000);
    const home = agents[0]!.updater.home!;
    expect(await readFile(path.join(home, 'versions', '9.9.9', 'agent.js'))).toEqual(bundle);
    expect(JSON.parse(await readFile(path.join(home, 'next.json'), 'utf8'))).toMatchObject({
      version: '9.9.9',
      previous: AGENT_VERSION,
    });

    // Bundle signé avec une autre clé : refusé par l'agent (E_SIGNATURE_INVALID), rien d'écrit.
    const other = generateKeyPairSync('ed25519').privateKey;
    const evil = Buffer.from('evil');
    res = await panel.app.inject({
      method: 'PUT',
      url: `/api/admin/agent-releases?version=9.9.10&signature=${encodeURIComponent(sign(null, evil, other).toString('base64'))}`,
      headers: { cookie: admin, 'content-type': 'application/octet-stream' },
      payload: evil,
    });
    expect(res.statusCode).toBe(201);
    res = await api('POST', `/api/machines/${machineB}/update`, { version: '9.9.10' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('E_SIGNATURE_INVALID');
    await expect(stat(path.join(agents[1]!.updater.home!, 'next.json'))).rejects.toThrow();

    // Rollback signalé par le launcher → événement + audit à la reconnexion.
    const homeB = agents[1]!.updater.home!;
    await writeFile(
      path.join(homeB, 'update-result.json'),
      JSON.stringify({
        kind: 'agent',
        status: 'rolled_back',
        version: '0.10.0',
        otherVersion: '9.9.10',
        reason: 'crash_loop',
        ts: Date.now(),
      }),
    );
    await agents[1]!.stop();
    const restarted = new Agent({
      stateDir: path.dirname(homeB),
      panelUrl: `${panel.wsUrl}/ws/agent`,
      // stderr visible : sur un échec CI intermittent (rollback jamais signalé), les warns de
      // l'agent (persist, consume, connexion) sont la seule trace exploitable.
      logger: new Logger('agent', { stderr: true }),
      scanIntervalMs: 0,
      trashPurgeIntervalMs: 0,
      metricsIntervalMs: 0,
      backupSchedulerTickMs: 0,
      restrictPermissions: false,
      backoff: { baseMs: 50, maxMs: 200 },
      agentHome: homeB,
    });
    agents[1] = restarted;
    await restarted.start();
    try {
      await waitFor(
        () => panel.ctx.events.list({ type: 'agent.updateRolledBack', limit: 5 }).length > 0,
        30_000, // reconnexion + relectures updateResult (0/1/5 s) : large pour les runners CI lents
      );
    } catch (cause) {
      // Diagnostic CI (échec intermittent observé sur les runners Linux) : connexion, derniers
      // événements, fichier update-result restant, et file pendingEvents de l'agent.
      const recent = panel.ctx.events
        .list({ limit: 15 })
        .map((e) => `${e.type}=${JSON.stringify(e.payload).slice(0, 100)}`);
      const resultLeft = await stat(path.join(homeB, 'update-result.json')).then(
        () => true,
        () => false,
      );
      const stateRaw = await readFile(
        path.join(path.dirname(homeB), 'agent-state.json'),
        'utf8',
      ).catch(() => '{}');
      const pending = (
        JSON.parse(stateRaw) as { pendingEvents?: { type: string; payload?: unknown }[] }
      ).pendingEvents;
      const updateAudit = panel.ctx.audit
        .list(50)
        .filter((a) => a.action.startsWith('agent.update.'))
        .map((a) => `${a.action}:${a.details ?? ''}`);
      throw new Error(
        `agent.updateRolledBack jamais reçu — machineB connectée=${String(panel.ctx.registry.isConnected(machineB))} ; update-result.json présent=${String(resultLeft)} ; pendingEvents=${JSON.stringify(pending?.map((p) => p.type) ?? null)} ; audit=${JSON.stringify(updateAudit)} ; derniers événements : ${recent.join(' | ')}`,
        { cause },
      );
    }
    const ev = panel.ctx.events.list({ type: 'agent.updateRolledBack', limit: 5 })[0]!;
    expect(ev.payload).toMatchObject({
      version: '0.10.0',
      otherVersion: '9.9.10',
      reason: 'crash_loop',
    });
    await expect(stat(path.join(homeB, 'update-result.json'))).rejects.toThrow();

    // Suppression d'une release.
    res = await api('DELETE', '/api/admin/agent-releases/9.9.10');
    expect(res.statusCode).toBe(204);
    res = await api('GET', '/api/agent-releases');
    expect(res.json<{ releases: { version: string }[]; latest: string }>()).toMatchObject({
      latest: '9.9.9',
    });
  }, 60_000);
});
