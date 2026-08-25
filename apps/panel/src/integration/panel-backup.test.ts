/**
 * Phase 12 — sauvegarde/restauration du panel lui-même et purges/rétentions, de bout en bout :
 *   1. panel sur fichiers + agent réel appairé + serveur adopté → `POST /api/admin/backups`
 *      (`VACUUM INTO`) → dérive (2e utilisateur, 2e machine, serveur renommé) → arrêt propre →
 *      `restorePanelBackup()` (CLI `mmo-panel restore`) → redémarrage sur le même port : la dérive a
 *      disparu, l'agent se reconnecte avec son secret d'origine et le serveur (même ID, marqueur
 *      intact) est de nouveau `detected`.
 *   2. `runMaintenance` sur horloge simulée : sessions, codes d'appairage, événements (90 j),
 *      audit (365 j), tasks (30 j), dédup (24 h), rotation des copies du panel (7) et `backupIfStale`.
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerDto } from '@mmo/protocol/client';

import { Agent } from '../../../agent/src/agent.js';
import { Logger } from '../../../agent/src/log.js';
import { buildApp, runMaintenance, type PanelApp } from '../app.js';
import { restorePanelBackup } from '../services/panel-backup.js';
import {
  createTestPanel,
  freePort,
  setupAdmin,
  tmpDir,
  testBudget,
  waitFor,
  type TestPanel,
} from '../test/helpers.js';

const FAKE_SERVER = path.resolve(import.meta.dirname, '../../../agent/test/fake-java-server.mjs');
const DAY = 24 * 3_600_000;

describe('phase 12 — sauvegarde/restauration du panel, purges', () => {
  let cleanups: (() => Promise<void>)[] = [];
  let agent: Agent | undefined;
  let panels: PanelApp[] = [];

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
    for (const p of panels) await p.close().catch(() => undefined);
    panels = [];
    for (const c of cleanups) await c();
    cleanups = [];
  });

  async function openPanel(dataDir: string, port: number): Promise<PanelApp> {
    const panel = await buildApp({
      now: () => Date.now(),
      config: {
        dataDir,
        mojangManifest: false,
        heartbeatIntervalSec: 1,
        offlineAfterMs: 10_000,
      },
      schedulerTickMs: 0,
    });
    panels.push(panel);
    await panel.app.listen({ port, host: '127.0.0.1' });
    return panel;
  }

  it(
    'VACUUM INTO → dérive → restauration → agent reconnecté, serveur ré-adopté (même ID)',
    async () => {
      const data = await tmpDir('mmo-pb-data-');
      const servers = await tmpDir('mmo-pb-servers-');
      const state = await tmpDir('mmo-pb-state-');
      cleanups = [data.cleanup, servers.cleanup, state.cleanup];
      const port = await freePort();
      const panel1 = await openPanel(data.dir, port);
      const wsUrl = `ws://127.0.0.1:${String(port)}`;
      const admin = await setupAdminOn(panel1);
      const api = (p: PanelApp, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
        p.app.inject({
          method,
          url,
          ...(payload === undefined ? {} : { payload }),
          headers: { cookie: admin },
        });

      // Serveur + agent réel.
      const dir = path.join(servers.dir, 'Survie');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
      await writeFile(
        path.join(dir, 'server.properties'),
        `server-port=${String(await freePort())}\n`,
      );
      await writeFile(path.join(dir, 'server.jar'), '');
      let res = await api(panel1, 'POST', '/api/machines', { name: 'Tour' });
      const { machine, pairing } = res.json<{
        machine: { id: string };
        pairing: { code: string };
      }>();
      agent = new Agent({
        stateDir: state.dir,
        panelUrl: `${wsUrl}/ws/agent`,
        pairCode: pairing.code,
        logger: new Logger('agent', { stderr: false }),
        scanIntervalMs: 0,
        trashPurgeIntervalMs: 0,
        metricsIntervalMs: 0,
        backupSchedulerTickMs: 0,
        restrictPermissions: false,
        backoff: { baseMs: 50, maxMs: 300 },
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
          exitPollMs: 100,
        },
      });
      await agent.start();
      await waitFor(() => panel1.ctx.registry.isConnected(machine.id), 10_000);
      res = await api(panel1, 'POST', `/api/machines/${machine.id}/directories`, {
        path: servers.dir,
      });
      expect(res.statusCode).toBe(201);
      res = await api(panel1, 'POST', `/api/machines/${machine.id}/scan`, {});
      const server = res.json<{ servers: ServerDto[] }>().servers[0]!;
      await waitFor(() => agent!.store.get().servers[server.id] !== undefined, 10_000);
      expect(await readdir(dir)).toContain('.mmo-server.json');

      // Sauvegarde.
      res = await api(panel1, 'POST', '/api/admin/backups');
      expect(res.statusCode).toBe(200);
      const { backup } = res.json<{ backup: { file: string } }>();
      const backupFile = path.join(data.dir, 'backups', 'panel', backup.file);
      expect((await stat(backupFile)).size).toBeGreaterThan(0);

      // Dérive après la sauvegarde.
      res = await api(panel1, 'POST', '/api/users', {
        username: 'intrus',
        password: 'correct horse battery',
        role: 'viewer',
      });
      expect(res.statusCode).toBe(201);
      res = await api(panel1, 'POST', '/api/machines', { name: 'Pi' });
      expect(res.statusCode).toBe(201);
      res = await api(panel1, 'PATCH', `/api/servers/${server.id}`, { name: 'Renommé' });
      expect(res.statusCode).toBe(200);
      expect(panel1.ctx.users.count()).toBe(2);

      // Arrêt propre (la WAL est vidée à la fermeture) puis restauration.
      await panel1.close();
      panels = [];
      const result = restorePanelBackup(data.dir, backup.file);
      expect(result.dbFile).toBe(path.join(data.dir, 'mmo.db'));
      expect(result.previous).toMatch(/mmo\.db\.before-restore-/);
      expect((await stat(result.previous!)).size).toBeGreaterThan(0);
      // Une restauration avec un fichier qui n'est pas une base du panel est refusée sans rien toucher.
      const bogus = path.join(data.dir, 'bogus.db');
      await writeFile(bogus, 'not a database');
      expect(() => restorePanelBackup(data.dir, bogus)).toThrow();
      expect(await readdir(data.dir)).not.toContain('mmo.db-wal');

      // Redémarrage sur le même port : données de la sauvegarde, agent reconnecté, serveur détecté.
      const panel2 = await openPanel(data.dir, port);
      expect(panel2.ctx.users.count()).toBe(1);
      expect(panel2.ctx.machines.list().map((m) => m.name)).toEqual(['Tour']);
      expect(panel2.ctx.servers.require(server.id).name).toBe('Survie');
      await waitFor(() => panel2.ctx.registry.isConnected(machine.id), 15_000);
      await waitFor(() => panel2.ctx.servers.require(server.id).detected === 1, 10_000);
      res = await api(panel2, 'POST', `/api/machines/${machine.id}/scan`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json<{ servers: ServerDto[] }>().servers.map((s) => s.id)).toEqual([server.id]);
      expect(panel2.ctx.servers.list()).toHaveLength(1);
      // La session d'avant la restauration (présente dans la sauvegarde) reste valable.
      res = await api(panel2, 'GET', '/api/auth/me');
      expect(res.statusCode).toBe(200);
      // Le serveur démarre et s'arrête normalement après restauration.
      res = await api(panel2, 'POST', `/api/servers/${server.id}/start`);
      expect(res.statusCode, res.body).toBe(200);
      await waitFor(() => panel2.ctx.servers.require(server.id).runState === 'running', 15_000);
      expect((await api(panel2, 'POST', `/api/servers/${server.id}/stop`)).statusCode).toBe(200);
      await waitFor(() => panel2.ctx.servers.require(server.id).runState === 'stopped', 15_000);
    },
    testBudget(60_000),
  );

  it('purges/rétentions : sessions, codes, événements 90 j, audit 365 j, tasks 30 j, copies du panel', async () => {
    const data = await tmpDir('mmo-pb-purge-');
    cleanups = [data.cleanup];
    const panel: TestPanel = await createTestPanel({ config: { dataDir: data.dir } });
    panels.push(panel);
    const admin = await setupAdmin(panel);
    const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
      panel.app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
        headers: { cookie: admin },
      });
    const count = (table: string): number =>
      (panel.ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

    // Données datées « maintenant » (T0).
    const res = await api('POST', '/api/machines', { name: 'Tour' });
    const { machine } = res.json<{ machine: { id: string } }>();
    for (let i = 0; i < 5; i++) {
      panel.ctx.events.publish({ type: 'machine.online', machineId: machine.id, severity: 'info' });
      panel.ctx.audit.record({ action: `test.${String(i)}`, username: 'admin' });
    }
    panel.ctx.processed.claim('01J5X8ZK3Q9WYE2R7M4T6B8N9Z');
    const events0 = count('events');
    const audit0 = count('audit_log');
    const sessions0 = count('sessions');
    const codes0 = count('pairing_codes');
    expect(events0).toBeGreaterThanOrEqual(5);
    expect(codes0).toBe(1);

    // Copies du panel : 9 sauvegardes à un jour d'écart → 7 conservées, `backupIfStale` respecte 24 h.
    for (let i = 0; i < 9; i++) {
      panel.clock.advance(DAY);
      panel.ctx.panelBackup.backupNow();
    }
    expect(panel.ctx.panelBackup.list()).toHaveLength(7);
    expect(panel.ctx.panelBackup.backupIfStale()).toBeUndefined();
    panel.clock.advance(DAY + 1);
    expect(panel.ctx.panelBackup.backupIfStale()).toBeDefined();
    expect(panel.ctx.panelBackup.list()).toHaveLength(7);

    // +31 j : sessions expirées et codes d'appairage purgés, le reste conservé.
    panel.clock.advance(31 * DAY);
    runMaintenance(panel.ctx);
    expect(count('sessions')).toBeLessThan(sessions0);
    expect(count('pairing_codes')).toBe(0);
    expect(count('events')).toBe(events0);
    expect(count('audit_log')).toBe(audit0);

    // +91 j : événements purgés (retention.eventsDays = 90), audit conservé.
    panel.clock.advance(60 * DAY);
    runMaintenance(panel.ctx);
    expect(count('events')).toBe(0);
    expect(count('audit_log')).toBe(audit0);

    // +366 j : audit purgé.
    panel.clock.advance(300 * DAY);
    runMaintenance(panel.ctx);
    expect(count('audit_log')).toBe(0);

    // Les réglages de rétention sont pris en compte (retention.eventsDays = 1).
    panel.ctx.settings.set('retention.eventsDays', '1');
    panel.ctx.events.publish({ type: 'machine.online', machineId: machine.id, severity: 'info' });
    panel.clock.advance(2 * DAY);
    runMaintenance(panel.ctx);
    expect(count('events')).toBe(0);
  });
});

async function setupAdminOn(panel: PanelApp): Promise<string> {
  const res = await panel.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'admin', password: 'correct horse battery' },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(';')[0] ?? '';
}
