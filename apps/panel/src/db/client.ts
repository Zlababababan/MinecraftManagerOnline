/**
 * Ouverture des bases SQLite (doc 04) : PRAGMAs par connexion (WAL, foreign_keys, busy_timeout,
 * synchronous), migrations Drizzle commitées rejouées from scratch. Un seul écrivain par fichier :
 * une connexion unique par base, accès synchrone (sérialisation naturelle par l'event loop).
 *
 * Le driver est `node:sqlite`, embarqué dans le runtime (voir `./sqlite.ts` — plus aucun module
 * natif dans le panel). Drizzle n'a pas de driver `node:sqlite` en 0.45.2, et son driver
 * `drizzle-orm/better-sqlite3` importe le module natif dès la première ligne : on assemble donc la
 * base nous-mêmes à partir de `BetterSQLiteSession`, qui, lui, n'importe rien de natif (vérifié :
 * `process.moduleLoadList` ne contient aucun `.node` après import). C'est la recopie du
 * `construct()` de `better-sqlite3/driver.js`. Doc 03 §3.
 */
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3/session';
import { BaseSQLiteDatabase, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import path from 'node:path';

import * as metricsSchema from './schema-metrics.js';
import * as schema from './schema.js';
import { openSqliteFile, type RunResult, type SqliteHandle } from './sqlite.js';

export type MmoDatabase = BaseSQLiteDatabase<'sync', RunResult, typeof schema>;
export type MetricsDatabase = BaseSQLiteDatabase<'sync', RunResult, typeof metricsSchema>;

const MIGRATIONS_ROOT = path.resolve(import.meta.dirname, '../../drizzle');

export interface OpenedDatabase<DB> {
  db: DB;
  sqlite: SqliteHandle;
  close(): void;
}

/**
 * Équivalent de `drizzle({ client, schema })` sans passer par le driver better-sqlite3.
 * Le cast du client est le seul point de perte de sûreté de type de la bascule : la signature de
 * `BetterSQLiteSession` annonce un handle better-sqlite3, alors que seul le contrat
 * `prepare/run/all/get/raw` + `transaction` est réellement utilisé (cf. `./sqlite.ts`).
 */
function createDrizzle(client: SqliteHandle, tables: Record<string, unknown>): unknown {
  const dialect = new SQLiteSyncDialect({});
  const tablesConfig = extractTablesRelationalConfig(tables, createTableRelationsHelpers);
  const relational = {
    fullSchema: tables,
    schema: tablesConfig.tables,
    tableNamesMap: tablesConfig.tableNamesMap,
  };
  const session = new BetterSQLiteSession(client as never, dialect, relational, {});
  return new BaseSQLiteDatabase('sync', dialect, session, relational);
}

/**
 * Migrations avec clés étrangères coupées HORS transaction (procédure canonique SQLite pour les
 * recréations de table) : le migrateur Drizzle enveloppe chaque lot dans une transaction, où le
 * `PRAGMA foreign_keys=OFF` émis par drizzle-kit est un no-op — un `DROP TABLE servers` y
 * déclencherait les cascades des tables dépendantes (backups, planifications, migrations…).
 * `foreign_key_check` vérifie l'intégrité avant de réarmer l'application des FK.
 */
function migrateWithForeignKeysOff(
  db: MmoDatabase | MetricsDatabase,
  sqlite: SqliteHandle,
  folder: string,
): void {
  sqlite.exec('PRAGMA foreign_keys = OFF');
  try {
    migrate(db as MmoDatabase, { migrationsFolder: folder });
    const violations = sqlite.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(`migration left ${String(violations.length)} foreign key violation(s)`);
    }
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON');
  }
}

/** `mmo.db` : ouverture + migrations. `':memory:'` accepté (tests). */
export function openMmoDatabase(file: string): OpenedDatabase<MmoDatabase> {
  const sqlite = openSqliteFile(file);
  const db = createDrizzle(sqlite, schema) as MmoDatabase;
  migrateWithForeignKeysOff(db, sqlite, path.join(MIGRATIONS_ROOT, 'mmo'));
  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
    },
  };
}

/** `metrics.db` : `auto_vacuum=INCREMENTAL` (doc 04 §7), posé avant le passage en WAL. */
export function openMetricsDatabase(file: string): OpenedDatabase<MetricsDatabase> {
  const sqlite = openSqliteFile(file, 'INCREMENTAL');
  const db = createDrizzle(sqlite, metricsSchema) as MetricsDatabase;
  migrateWithForeignKeysOff(db, sqlite, path.join(MIGRATIONS_ROOT, 'metrics'));
  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
    },
  };
}

/** Checkpoint WAL en période calme (doc 04 §8.3). */
export function checkpoint(sqlite: SqliteHandle): void {
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
}
