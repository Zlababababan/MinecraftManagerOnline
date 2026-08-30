/**
 * Adaptateur `node:sqlite` (Node 24) présentant la surface de better-sqlite3 réellement consommée
 * par le panel **et** par Drizzle. Raison d'être : better-sqlite3 est un module natif, donc un
 * `.node` lié à la glibc de la machine qui l'a construit. C'est ce qui a rendu l'installation du
 * panel impossible sur une VM Ubuntu 20.04 ARM64 (aucun prebuild pour Node 24/arm64 → node-gyp →
 * `build-essential` requis), puis, une fois l'archive produite par la CI, ce qui a rendu les
 * archives Linux des versions 1.0.2 et 1.0.3 inutilisables sur les distributions à glibc ancienne.
 * `node:sqlite` est embarqué dans le runtime : plus aucun `.node`, plus de plancher de glibc.
 *
 * Deux différences de `node:sqlite` sont rattrapées ici, et elles sont silencieuses si on les
 * oublie : les erreurs n'ont pas de code `SQLITE_*` (seulement `errcode` numérique), et il n'existe
 * ni `pragma()` ni `transaction()`. Voir doc 03 §3.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/** Retour de `INSERT`/`UPDATE`/`DELETE`, compatible avec le `RunResult` de better-sqlite3. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: unknown[]): RunResult;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  /** Mode « tableau » attendu par Drizzle (`setReturnArrays` côté node:sqlite). Rend `this`. */
  raw(toggle?: boolean): SqliteStatement;
}

/** Fonction rendue par `transaction()` : appelable, et déclinée par comportement comme better-sqlite3. */
export type SqliteTransaction<A extends unknown[], R> = ((...args: A) => R) & {
  deferred: (...args: A) => R;
  immediate: (...args: A) => R;
  exclusive: (...args: A) => R;
};

export interface SqliteHandle {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** `pragma('x')` rend les lignes ; `{ simple: true }` rend la première valeur de la première. */
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): SqliteTransaction<A, R>;
  close(): void;
}

/** Codes primaires SQLite (les 8 bits de poids faible d'`errcode`). */
const PRIMARY_CODES: Record<number, string> = {
  1: 'SQLITE_ERROR',
  2: 'SQLITE_INTERNAL',
  3: 'SQLITE_PERM',
  4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  7: 'SQLITE_NOMEM',
  8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT',
  10: 'SQLITE_IOERR',
  11: 'SQLITE_CORRUPT',
  12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL',
  14: 'SQLITE_CANTOPEN',
  15: 'SQLITE_PROTOCOL',
  16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA',
  18: 'SQLITE_TOOBIG',
  19: 'SQLITE_CONSTRAINT',
  20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE',
  22: 'SQLITE_NOLFS',
  23: 'SQLITE_AUTH',
  24: 'SQLITE_FORMAT',
  25: 'SQLITE_RANGE',
  26: 'SQLITE_NOTADB',
};

/**
 * Codes étendus dont le panel dépend. `SQLITE_CONSTRAINT_UNIQUE` (2067) est le seul réellement
 * décisif aujourd'hui (`servers.ts` : course d'adoption), mais toute la famille CONSTRAINT est
 * fournie pour que le prochain `error.code === 'SQLITE_CONSTRAINT_…'` fonctionne d'emblée.
 */
const EXTENDED_CODES: Record<number, string> = {
  275: 'SQLITE_CONSTRAINT_CHECK',
  531: 'SQLITE_CONSTRAINT_COMMITHOOK',
  787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  1043: 'SQLITE_CONSTRAINT_FUNCTION',
  1299: 'SQLITE_CONSTRAINT_NOTNULL',
  1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
  1811: 'SQLITE_CONSTRAINT_TRIGGER',
  2067: 'SQLITE_CONSTRAINT_UNIQUE',
  2323: 'SQLITE_CONSTRAINT_VTAB',
  2579: 'SQLITE_CONSTRAINT_ROWID',
};

/** Erreur portant le même `code` textuel que celle de better-sqlite3 (`SQLITE_CONSTRAINT_UNIQUE`…). */
export class SqliteError extends Error {
  override readonly name = 'SqliteError';
  readonly code: string;
  readonly errcode: number;

  constructor(message: string, code: string, errcode: number) {
    super(message);
    this.code = code;
    this.errcode = errcode;
  }
}

export function sqliteCodeOf(errcode: number): string {
  return EXTENDED_CODES[errcode] ?? PRIMARY_CODES[errcode & 0xff] ?? 'SQLITE_ERROR';
}

/**
 * `node:sqlite` rend `code: 'ERR_SQLITE_ERROR'` pour TOUTES les erreurs et range le vrai code dans
 * `errcode`. Sans cette traduction, les deux tests `error.code === 'SQLITE_…'` du panel deviennent
 * des `if` toujours faux — sans la moindre erreur visible.
 */
function rethrow(error: unknown): never {
  const errcode: unknown = (error as { errcode?: unknown }).errcode;
  if (error instanceof Error && typeof errcode === 'number') {
    const wrapped = new SqliteError(error.message, sqliteCodeOf(errcode), errcode);
    if (error.stack !== undefined) wrapped.stack = error.stack;
    throw wrapped;
  }
  throw error;
}

function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    rethrow(error);
  }
}

/** Les lignes de `node:sqlite` ont un prototype nul ; better-sqlite3 rendait des objets ordinaires. */
function plain(row: unknown): unknown {
  return row === undefined || row === null ? row : { ...(row as Record<string, unknown>) };
}

class Statement implements SqliteStatement {
  #arrays = false;

  constructor(private readonly stmt: StatementSync) {}

  run(...params: unknown[]): RunResult {
    return call(() => this.stmt.run(...(params as SQLInputValue[]))) as RunResult;
  }

  all(...params: unknown[]): unknown[] {
    const rows = call(() => this.stmt.all(...(params as SQLInputValue[]))) as unknown[];
    return this.#arrays ? rows : rows.map(plain);
  }

  get(...params: unknown[]): unknown {
    const row = call(() => this.stmt.get(...(params as SQLInputValue[])));
    return this.#arrays ? row : plain(row);
  }

  raw(toggle = true): SqliteStatement {
    this.stmt.setReturnArrays(toggle);
    this.#arrays = toggle;
    return this;
  }
}

class Handle implements SqliteHandle {
  #savepoint = 0;

  constructor(private readonly db: DatabaseSync) {}

  /**
   * Passe par une méthode et non par la propriété : `isTransaction` est déclarée `readonly`, donc
   * TypeScript la considère invariante et tient le ROLLBACK ci-dessous pour inatteignable — alors
   * que sa valeur change à chaque `exec`.
   */
  #inTransaction(): boolean {
    return this.db.isTransaction;
  }

  prepare(sql: string): SqliteStatement {
    return new Statement(call(() => this.db.prepare(sql)));
  }

  exec(sql: string): void {
    call(() => {
      this.db.exec(sql);
    });
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    const rows = this.prepare(`PRAGMA ${source}`).all() as Record<string, unknown>[];
    if (options?.simple !== true) return rows;
    return rows.length === 0 ? undefined : Object.values(rows[0] ?? {})[0];
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): SqliteTransaction<A, R> {
    const behave =
      (behavior: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') =>
      (...args: A): R => {
        // better-sqlite3 bascule automatiquement en SAVEPOINT quand une transaction est déjà
        // ouverte ; sans ça un BEGIN imbriqué lève « cannot start a transaction within a
        // transaction ». `isTransaction` est un accesseur d'instance (absent du prototype).
        if (this.#inTransaction()) {
          const name = `mmo_sp_${String(++this.#savepoint)}`;
          this.exec(`SAVEPOINT ${name}`);
          try {
            const result = fn(...args);
            this.exec(`RELEASE ${name}`);
            return result;
          } catch (error) {
            this.exec(`ROLLBACK TO ${name}`);
            this.exec(`RELEASE ${name}`);
            throw error;
          }
        }
        this.exec(`BEGIN ${behavior}`);
        try {
          const result = fn(...args);
          this.exec('COMMIT');
          return result;
        } catch (error) {
          // `fn` a pu faire son propre ROLLBACK : ne pas en émettre un second.
          if (this.#inTransaction()) this.exec('ROLLBACK');
          throw error;
        }
      };
    return Object.assign(behave('DEFERRED'), {
      deferred: behave('DEFERRED'),
      immediate: behave('IMMEDIATE'),
      exclusive: behave('EXCLUSIVE'),
    });
  }

  close(): void {
    call(() => {
      this.db.close();
    });
  }
}

/**
 * Ouvre une base. `autoVacuum` doit être posé AVANT `journal_mode = WAL` : passer en WAL initialise
 * l'en-tête du fichier et fige la valeur (mesuré : 0 dans l'ordre inverse, même sur une base sans
 * aucune table). Sur une base déjà créée, seul un VACUUM complet la change — voir MetricsService.
 */
export function openSqliteFile(file: string, autoVacuum?: 'INCREMENTAL'): SqliteHandle {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Handle(call(() => new DatabaseSync(file)));
  if (autoVacuum !== undefined) handle.exec(`PRAGMA auto_vacuum = ${autoVacuum}`);
  handle.exec('PRAGMA journal_mode = WAL');
  // `node:sqlite` active les clés étrangères par défaut, better-sqlite3 non : on les pose
  // explicitement dans les deux cas (elles sont **par connexion**, doc 04 §1).
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA synchronous = NORMAL');
  return handle;
}

/**
 * Ouverture en lecture seule (vérification d'une sauvegarde). ⚠ L'option s'écrit `readOnly` et
 * `node:sqlite` accepte silencieusement les options inconnues : une faute de casse ouvrirait la
 * base en écriture sans le moindre avertissement.
 */
export function openSqliteReadonly(file: string): SqliteHandle {
  return new Handle(call(() => new DatabaseSync(file, { readOnly: true })));
}
