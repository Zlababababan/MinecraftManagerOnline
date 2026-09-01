/**
 * Lot 9 — maintenance horaire : purges par rétention **journalisées par table**, rétentions
 * configurables et validées, VACUUM hebdomadaire en fenêtre calme précédé du contrôle d'espace.
 *
 * Sur de VRAIS fichiers : un VACUUM ou une liste libre en `:memory:` ne prouvent rien (doc 04 §7).
 */
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { freelistCount } from '../db/compaction.js';
import { servers } from '../db/schema.js';
import { createTestPanel, setupAdmin, tmpDir, type TestPanel } from '../test/helpers.js';
import { COMMAND_HISTORY_MAX_PER_SERVER, runMaintenance } from './maintenance.js';
import { SETTING_KEYS } from './settings.js';

const DAY = 86_400_000;
/** 2026-09-02 12:00 UTC — hors fenêtre calme. */
const NOON = Date.UTC(2026, 8, 2, 12, 0, 0);
/** Le lendemain à 04:00 UTC — dans la fenêtre [3 h, 6 h). */
const QUIET = Date.UTC(2026, 8, 3, 4, 0, 0);

interface Fixture {
  panel: TestPanel;
  dataDir: string;
  admin: string;
  machineId: string;
  serverId: string;
  /** Lignes NDJSON du journal du panel. */
  lines: string[];
}

interface LogRecord {
  msg: string;
  purged?: Record<string, number>;
  durationMs?: number;
  file?: string;
  needData?: number;
}

describe('maintenance horaire — purges, rétentions, VACUUM', () => {
  const panels: TestPanel[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const p of panels.splice(0)) await p.close();
    for (const c of cleanups.splice(0)) await c();
  });

  async function openPanel(files: 'disk' | 'memory' = 'disk'): Promise<Fixture> {
    const data = await tmpDir('mmo-maint-');
    cleanups.push(data.cleanup);
    const lines: string[] = [];
    const panel = await createTestPanel({
      config: { dataDir: data.dir },
      ...(files === 'disk'
        ? { dbFile: path.join(data.dir, 'mmo.db'), metricsFile: path.join(data.dir, 'metrics.db') }
        : {}),
      logger: {
        level: 'debug',
        stream: {
          write: (chunk: string) => {
            lines.push(chunk);
          },
        },
      },
    });
    panels.push(panel);
    panel.clock.set(NOON);
    const admin = await setupAdmin(panel);
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Tour' },
      headers: { cookie: admin },
    });
    const { machine } = res.json<{ machine: { id: string } }>();
    panel.ctx.db
      .insert(servers)
      .values({
        id: 'srv-a',
        machineId: machine.id,
        path: 'C:/mc/a',
        name: 'A',
        createdAt: NOON,
        updatedAt: NOON,
      })
      .run();
    return { panel, dataDir: data.dir, admin, machineId: machine.id, serverId: 'srv-a', lines };
  }

  const records = (lines: string[], msg: string): LogRecord[] =>
    lines.map((l) => JSON.parse(l) as LogRecord).filter((r) => r.msg === msg);
  const count = (panel: TestPanel, table: string): number =>
    (panel.ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it('borne chaque table et journalise le nombre de lignes supprimées, table par table', async () => {
    const f = await openPanel();
    const { sqlite } = f.panel.ctx;
    const t = NOON;

    // command_history : 2 500 lignes récentes (plafond 2 000 par serveur) + 10 de plus de 90 j.
    const cmd = sqlite.prepare(
      'INSERT INTO command_history (server_id, command, via, ts) VALUES (?, ?, ?, ?)',
    );
    sqlite.transaction(() => {
      for (let i = 0; i < 2500; i++) cmd.run(f.serverId, `say ${String(i)}`, 'stdin', t - i);
      for (let i = 0; i < 10; i++) cmd.run(f.serverId, 'old', 'rcon', t - 100 * DAY - i);
    })();

    // player_sessions : une session close de 400 j (part), une OUVERTE de 400 j (reste : joueur
    // en ligne), une close de 10 j (reste).
    sqlite.exec(
      `INSERT INTO players (uuid, last_name, first_seen_at, last_seen_at) VALUES ('u1', 'Steve', ${String(t)}, ${String(t)})`,
    );
    const sess = sqlite.prepare(
      "INSERT INTO player_sessions (server_id, player_uuid, player_name, joined_at, left_at) VALUES (?, 'u1', 'Steve', ?, ?)",
    );
    sess.run(f.serverId, t - 400 * DAY, t - 400 * DAY + 3_600_000);
    sess.run(f.serverId, t - 400 * DAY, null);
    sess.run(f.serverId, t - 10 * DAY, t - 10 * DAY + 3_600_000);

    // backups : une fiche `deleted` de 40 j (part), une `deleted` de 40 j encore référencée par
    // une migration (reste), une `success` de 40 j (reste), une `deleted` d'hier (reste).
    const bk = sqlite.prepare(
      'INSERT INTO backups (id, server_id, kind, status, machine_id, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    bk.run(
      'b-old-deleted',
      f.serverId,
      'manual',
      'deleted',
      f.machineId,
      t - 41 * DAY,
      t - 40 * DAY,
    );
    bk.run(
      'b-ref',
      f.serverId,
      'pre_migration',
      'deleted',
      f.machineId,
      t - 41 * DAY,
      t - 40 * DAY,
    );
    bk.run(
      'b-old-success',
      f.serverId,
      'manual',
      'success',
      f.machineId,
      t - 41 * DAY,
      t - 40 * DAY,
    );
    bk.run('b-recent-deleted', f.serverId, 'manual', 'deleted', f.machineId, t - 2 * DAY, t - DAY);

    // server_migrations : done de 100 j (part), failed de 100 j sans finished_at (part), pending
    // de 100 j (reste : active), done d'hier référençant b-ref (reste, et protège b-ref).
    const mig = sqlite.prepare(
      'INSERT INTO server_migrations (id, server_id, from_machine_id, to_machine_id, status, started_at, finished_at, backup_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    mig.run(
      'm-old-done',
      f.serverId,
      f.machineId,
      f.machineId,
      'done',
      t - 101 * DAY,
      t - 100 * DAY,
      null,
    );
    mig.run(
      'm-old-failed',
      f.serverId,
      f.machineId,
      f.machineId,
      'failed',
      t - 100 * DAY,
      null,
      null,
    );
    mig.run(
      'm-pending',
      f.serverId,
      f.machineId,
      f.machineId,
      'pending',
      t - 100 * DAY,
      null,
      null,
    );
    mig.run(
      'm-recent',
      f.serverId,
      f.machineId,
      f.machineId,
      'done',
      t - 2 * DAY,
      t - DAY,
      'b-ref',
    );

    // tasks : une terminée depuis 40 j (part), une en attente (reste).
    f.panel.ctx.tasks.create({ id: 't-old', kind: 'backup.create', machineId: f.machineId });
    f.panel.ctx.tasks.complete('t-old', {}, t - 40 * DAY);
    f.panel.ctx.tasks.create({ id: 't-pending', kind: 'backup.create', machineId: f.machineId });

    // events : trois de 100 j (rétention 90 j).
    for (let i = 0; i < 3; i++) {
      f.panel.ctx.events.publish({
        type: 'machine.online',
        machineId: f.machineId,
        severity: 'info',
        ts: t - 100 * DAY,
      });
    }

    // Journaux du panel : un de 20 j (part), un d'hier (reste), un fichier étranger (ignoré).
    const logs = path.join(f.dataDir, 'logs');
    mkdirSync(logs, { recursive: true });
    const aged = (name: string, ageMs: number) => {
      const file = path.join(logs, name);
      writeFileSync(file, 'x');
      utimesSync(file, new Date(t - ageMs), new Date(t - ageMs));
    };
    aged('panel-2026-08-13.log', 20 * DAY);
    aged('panel-2026-09-01.log', DAY);
    aged('notes.txt', 20 * DAY);

    const report = runMaintenance(f.panel.ctx);
    const expected = {
      command_history: 500 + 10,
      player_sessions: 1,
      server_migrations: 2,
      backups: 1,
      tasks: 1,
      events: 3,
      panel_logs: 1,
    };
    expect(report.purged).toMatchObject(expected);
    expect(count(f.panel, 'command_history')).toBe(COMMAND_HISTORY_MAX_PER_SERVER);
    expect(count(f.panel, 'player_sessions')).toBe(2);
    expect(count(f.panel, 'server_migrations')).toBe(2);
    expect(count(f.panel, 'backups')).toBe(3);
    expect(count(f.panel, 'tasks')).toBe(1);
    expect(readdirSync(logs).sort()).toEqual(['notes.txt', 'panel-2026-09-01.log']);

    // Le journal dit exactement ce qui est parti, et seulement ce qui est parti.
    const [line, ...others] = records(f.lines, 'maintenance: rows purged');
    expect(others).toHaveLength(0);
    expect(line?.purged).toEqual(expected);
    expect(line?.durationMs).toBeTypeOf('number');

    // Second passage : plus rien à purger — pas de ligne « rows purged », une ligne debug.
    runMaintenance(f.panel.ctx);
    expect(records(f.lines, 'maintenance: rows purged')).toHaveLength(1);
    expect(records(f.lines, 'maintenance: nothing to purge')).toHaveLength(1);
  });

  it('rétentions réglables : appliquées telles quelles, refusées par l’API ou ignorées si absurdes', async () => {
    const f = await openPanel();
    const patch = (body: Record<string, string>) =>
      f.panel.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: body,
        headers: { cookie: f.admin },
      });
    for (const bad of ['0', '-3', 'abc', '1.5', '5000', '']) {
      const res = await patch({ 'retention.commandHistoryDays': bad });
      expect(res.statusCode, `valeur « ${bad} »`).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('E_VALIDATION');
      expect(res.body).toContain('retention.commandHistoryDays');
    }
    const ok = await patch({ 'retention.playerSessionsDays': ' 2 ' });
    expect(ok.statusCode).toBe(200);
    expect(
      ok.json<{ settings: Record<string, string> }>().settings['retention.playerSessionsDays'],
    ).toBe('2');

    // Appliquée : une session close depuis 3 j part avec 2 j de rétention (365 par défaut).
    const t = NOON;
    f.panel.ctx.sqlite.exec(
      `INSERT INTO players (uuid, last_name, first_seen_at, last_seen_at) VALUES ('u1', 'Steve', ${String(t)}, ${String(t)})`,
    );
    f.panel.ctx.sqlite
      .prepare(
        "INSERT INTO player_sessions (server_id, player_uuid, player_name, joined_at, left_at) VALUES (?, 'u1', 'Steve', ?, ?)",
      )
      .run(f.serverId, t - 3 * DAY, t - 3 * DAY + 60_000);
    expect(runMaintenance(f.panel.ctx).purged.player_sessions).toBe(1);

    // Bricolée en base à « 0 » : le défaut s'applique, la table n'est pas vidée.
    f.panel.ctx.settings.set(SETTING_KEYS.eventsRetentionDays, '0');
    expect(f.panel.ctx.settings.positiveInt(SETTING_KEYS.eventsRetentionDays)).toBe(90);
    f.panel.ctx.events.publish({
      type: 'machine.online',
      machineId: f.machineId,
      severity: 'info',
      ts: t - 10 * DAY,
    });
    const before = count(f.panel, 'events');
    expect(runMaintenance(f.panel.ctx).purged.events).toBe(0);
    expect(count(f.panel, 'events')).toBe(before);
  });

  it('VACUUM hebdomadaire : fenêtre calme, activité, espace disque, cadence — et le fichier rétrécit', async () => {
    const f = await openPanel();
    const { ctx } = f.panel;
    ctx.settings.set(SETTING_KEYS.scheduleTimezone, 'UTC');
    const mmo = ctx.files.mmo;
    const plenty = () => Number.MAX_SAFE_INTEGER;

    // Remplir puis vider mmo.db : des pages libres que rien ne rend sans VACUUM (pas d'auto_vacuum).
    const rec = ctx.sqlite.prepare(
      "INSERT INTO audit_log (ts, action, details) VALUES (?, 'fill', ?)",
    );
    const filler = 'x'.repeat(200);
    ctx.sqlite.transaction(() => {
      for (let i = 0; i < 30_000; i++) rec.run(NOON - 2 * DAY, filler);
    })();
    ctx.sqlite.exec("DELETE FROM audit_log WHERE action = 'fill'");
    ctx.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    expect(freelistCount(ctx.sqlite)).toBeGreaterThan(256);
    const sizeBefore = statSync(mmo).size;

    // 1. Midi : hors fenêtre.
    let outcomes = runMaintenance(ctx, { diskFree: plenty }).vacuum;
    expect(outcomes.map((o) => o.reason)).toEqual(['window', 'window']);

    // 2. 04:00 mais disque plein : avertissement nommant le fichier, rien n'est écrit, la cadence
    //    n'avance pas.
    f.panel.clock.set(QUIET);
    outcomes = runMaintenance(ctx, { diskFree: () => 0 }).vacuum;
    expect(outcomes.map((o) => o.reason)).toEqual(['disk', 'disk']);
    const warns = records(f.lines, 'vacuum skipped: not enough free disk space');
    expect(warns.map((w) => w.file)).toEqual([mmo, ctx.files.metrics]);
    expect(warns[0]?.needData).toBeGreaterThan(sizeBefore);
    expect(ctx.settings.get(SETTING_KEYS.vacuumAt)).toBeUndefined();
    expect(statSync(mmo).size).toBe(sizeBefore);

    // 3. 04:00, disque OK, mais une task est en cours.
    ctx.tasks.create({ id: 't-run', kind: 'backup.create', machineId: f.machineId });
    outcomes = runMaintenance(ctx, { diskFree: plenty }).vacuum;
    expect(outcomes.map((o) => o.reason)).toEqual(['busy', 'busy']);
    ctx.sqlite.exec("DELETE FROM tasks WHERE id = 't-run'");

    // 4. Toutes les gardes passent : mmo.db est réécrit et rétrécit ; metrics.db n'a rien à rendre
    //    (sa liste libre est vidée chaque heure par la compaction incrémentale).
    const report = runMaintenance(ctx, { diskFree: plenty });
    const done = report.vacuum.find((o) => o.file === mmo);
    expect(done?.status).toBe('done');
    expect(done?.afterBytes).toBeLessThan(done?.beforeBytes ?? 0);
    expect(statSync(mmo).size).toBeLessThan(sizeBefore);
    expect(report.vacuum.find((o) => o.file === ctx.files.metrics)?.reason).toBe('nothing');
    expect(ctx.settings.get(SETTING_KEYS.vacuumAt)).toBe(String(QUIET));
    expect(records(f.lines, 'database vacuumed').map((r) => r.file)).toEqual([mmo]);

    // 5. Le lendemain à la même heure : trop récent. 6. Une semaine plus tard : réévalué.
    f.panel.clock.advance(DAY);
    expect(runMaintenance(ctx, { diskFree: plenty }).vacuum.map((o) => o.reason)).toEqual([
      'recent',
      'recent',
    ]);
    f.panel.clock.advance(7 * DAY);
    expect(runMaintenance(ctx, { diskFree: plenty }).vacuum.map((o) => o.reason)).toEqual([
      'nothing',
      'nothing',
    ]);
  });

  it('en mémoire (tests) : le VACUUM est sans objet, quelle que soit l’heure', async () => {
    const f = await openPanel('memory');
    f.panel.ctx.settings.set(SETTING_KEYS.scheduleTimezone, 'UTC');
    f.panel.clock.set(QUIET);
    const outcomes = runMaintenance(f.panel.ctx, { diskFree: () => 0 }).vacuum;
    expect(outcomes.map((o) => o.reason)).toEqual(['memory', 'memory']);
    expect(records(f.lines, 'vacuum skipped: not enough free disk space')).toHaveLength(0);
  });
});
