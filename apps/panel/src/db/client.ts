/**
 * Ouverture des bases SQLite (doc 04) : PRAGMAs par connexion (WAL, foreign_keys, busy_timeout,
 * synchronous), migrations Drizzle commitées rejouées from scratch. Un seul écrivain par fichier :
 * une connexion unique par base, better-sqlite3 synchrone (sérialisation naturelle par l'event loop).
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import * as schema from './schema.js';
import * as metricsSchema from './schema-metrics.js';

export type MmoDatabase = BetterSQLite3Database<typeof schema>;
export type MetricsDatabase = BetterSQLite3Database<typeof metricsSchema>;

const MIGRATIONS_ROOT = path.resolve(import.meta.dirname, '../../drizzle');

export interface OpenedDatabase<DB> {
  db: DB;
  sqlite: Database.Database;
  close(): void;
}

function openSqlite(file: string, autoVacuum?: 'INCREMENTAL'): Database.Database {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  // `auto_vacuum` doit être posé AVANT `journal_mode = WAL` : passer en WAL initialise l'en-tête
  // du fichier et fige la valeur (mesuré : 0 dans l'ordre inverse, même sur une base sans aucune
  // table). Sur une base déjà créée, seul un VACUUM complet la change — voir MetricsService.
  if (autoVacuum !== undefined) sqlite.pragma(`auto_vacuum = ${autoVacuum}`);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  return sqlite;
}

/** `mmo.db` : ouverture + migrations. `':memory:'` accepté (tests). */
export function openMmoDatabase(file: string): OpenedDatabase<MmoDatabase> {
  const sqlite = openSqlite(file);
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: path.join(MIGRATIONS_ROOT, 'mmo') });
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
  const sqlite = openSqlite(file, 'INCREMENTAL');
  const db = drizzle({ client: sqlite, schema: metricsSchema });
  migrate(db, { migrationsFolder: path.join(MIGRATIONS_ROOT, 'metrics') });
  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
    },
  };
}

/** Checkpoint WAL en période calme (doc 04 §8.3). */
export function checkpoint(sqlite: Database.Database): void {
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
}
