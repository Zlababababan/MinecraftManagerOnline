/**
 * Schéma `metrics.db` (doc 04 §7) : brut 15 s (48 h), 1 min (14 j), 1 h (2 ans). Fichier séparé
 * de `mmo.db` (un écrivain par fichier). Rempli en phase 7 ; les migrations sont posées dès la phase 4.
 */
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Parcours UI (maintenance/diagnostic) : clics et navigations envoyés par lots par le front.
 * Volume faible, purge par rétention (`retention.uiEventsDays`, défaut 14 j) dans `runMaintenance`.
 */
export const uiEvents = sqliteTable(
  'ui_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    userId: text('user_id'),
    username: text('username'),
    /** `click` ou `nav`. */
    kind: text('kind').notNull(),
    page: text('page').notNull(),
    target: text('target'),
  },
  (t) => [index('ui_events_ts').on(t.ts)],
);

export const metricsServerRaw = sqliteTable(
  'metrics_server_raw',
  {
    serverId: text('server_id').notNull(),
    ts: integer('ts').notNull(),
    cpuPct: real('cpu_pct'),
    ramMb: integer('ram_mb'),
    tps: real('tps'),
    mspt: real('mspt'),
    players: integer('players'),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.ts] })],
);

export const metricsMachineRaw = sqliteTable(
  'metrics_machine_raw',
  {
    machineId: text('machine_id').notNull(),
    ts: integer('ts').notNull(),
    cpuPct: real('cpu_pct'),
    ramUsedMb: integer('ram_used_mb'),
    diskUsedGb: real('disk_used_gb'),
    diskTotalGb: real('disk_total_gb'),
  },
  (t) => [primaryKey({ columns: [t.machineId, t.ts] })],
);

const serverAggregateColumns = {
  serverId: text('server_id').notNull(),
  /** Début de tranche. */
  ts: integer('ts').notNull(),
  cpuAvg: real('cpu_avg'),
  cpuMax: real('cpu_max'),
  ramAvg: integer('ram_avg'),
  ramMax: integer('ram_max'),
  tpsAvg: real('tps_avg'),
  tpsMin: real('tps_min'),
  playersMax: integer('players_max'),
  samples: integer('samples').notNull(),
};

export const metricsServer1m = sqliteTable('metrics_server_1m', serverAggregateColumns, (t) => [
  primaryKey({ columns: [t.serverId, t.ts] }),
]);
export const metricsServer1h = sqliteTable('metrics_server_1h', serverAggregateColumns, (t) => [
  primaryKey({ columns: [t.serverId, t.ts] }),
]);

const machineAggregateColumns = {
  machineId: text('machine_id').notNull(),
  ts: integer('ts').notNull(),
  cpuAvg: real('cpu_avg'),
  cpuMax: real('cpu_max'),
  ramAvg: integer('ram_avg'),
  ramMax: integer('ram_max'),
  diskUsedGb: real('disk_used_gb'),
  diskTotalGb: real('disk_total_gb'),
  samples: integer('samples').notNull(),
};

export const metricsMachine1m = sqliteTable('metrics_machine_1m', machineAggregateColumns, (t) => [
  primaryKey({ columns: [t.machineId, t.ts] }),
]);
export const metricsMachine1h = sqliteTable('metrics_machine_1h', machineAggregateColumns, (t) => [
  primaryKey({ columns: [t.machineId, t.ts] }),
]);
