/**
 * Adaptateur `node:sqlite` : les comportements de better-sqlite3 dont le panel dépend et que
 * `node:sqlite` ne fournit pas. Chacun de ces tests couvre une régression qui serait SILENCIEUSE —
 * pas d'exception, pas de log, juste un `if` devenu toujours faux ou une transaction qui n'en est
 * plus une.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteFile, openSqliteReadonly, sqliteCodeOf, type SqliteHandle } from './sqlite.js';

describe('adaptateur node:sqlite', () => {
  let dir: string;
  let db: SqliteHandle;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mmo-sqlite-'));
    db = openSqliteFile(path.join(dir, 'test.db'));
    db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)');
    db.exec(
      `CREATE TABLE t (
         id TEXT PRIMARY KEY,
         parent_id TEXT REFERENCES parent(id),
         a TEXT NOT NULL,
         b TEXT,
         UNIQUE (a, b)
       )`,
    );
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('codes d’erreur', () => {
    // `node:sqlite` rend `code: 'ERR_SQLITE_ERROR'` pour TOUT et met le vrai code dans `errcode`.
    // Deux gardes du panel comparent `error.code` à une chaîne `SQLITE_*` : sans traduction elles
    // deviennent des `if` toujours faux. Celle-ci protège la course d'adoption (329c7e7) — son
    // symptôme était une SqliteError brute affichée en « Erreur interne ».
    it('une violation UNIQUE porte code SQLITE_CONSTRAINT_UNIQUE et le message SQLite', () => {
      db.prepare('INSERT INTO t (id, a, b) VALUES (?, ?, ?)').run('1', 'x', 'y');
      let caught: unknown;
      try {
        db.prepare('INSERT INTO t (id, a, b) VALUES (?, ?, ?)').run('2', 'x', 'y');
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe('SQLITE_CONSTRAINT_UNIQUE');
      expect((caught as Error).message).toContain('UNIQUE constraint failed: t.a, t.b');
    });

    it('une violation de clé étrangère porte code SQLITE_CONSTRAINT_FOREIGNKEY', () => {
      // Les FK sont **par connexion** : le PRAGMA posé à l'ouverture doit être effectif.
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(() =>
        db.prepare('INSERT INTO t (id, parent_id, a) VALUES (?, ?, ?)').run('1', 'absent', 'x'),
      ).toThrow(expect.objectContaining({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }));
    });

    // Le message clair « chown » de `main.ts` repose sur ce code (installation Linux en sudo).
    it('une base inouvrable porte code SQLITE_CANTOPEN', () => {
      let caught: unknown;
      try {
        openSqliteReadonly(path.join(dir, 'absente.db'));
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe('SQLITE_CANTOPEN');
    });

    it('un code étendu inconnu retombe sur sa famille primaire', () => {
      expect(sqliteCodeOf(2067)).toBe('SQLITE_CONSTRAINT_UNIQUE');
      expect(sqliteCodeOf(14)).toBe('SQLITE_CANTOPEN');
      expect(sqliteCodeOf(526)).toBe('SQLITE_CANTOPEN'); // CANTOPEN_ISDIR
      expect(sqliteCodeOf(517)).toBe('SQLITE_BUSY'); // BUSY_SNAPSHOT
    });
  });

  describe('transaction()', () => {
    const insert = (h: SqliteHandle, id: string, a: string): void => {
      h.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run(id, a);
    };
    const count = (h: SqliteHandle): number =>
      (h.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;

    // Drizzle appelle `client.transaction(fn)` puis `nativeTx[behavior](tx)` en passant `tx` :
    // une transaction qui ignorerait ses arguments casserait `db.transaction((tx) => …)` en
    // silence — `tx` serait `undefined`.
    it('relaie ses arguments et rend la valeur de la fonction', () => {
      const tx = db.transaction((id: string, a: string) => {
        insert(db, id, a);
        return `${id}:${a}`;
      });
      expect(tx('1', 'x')).toBe('1:x');
      expect(count(db)).toBe(1);
    });

    it('annule tout sur exception', () => {
      const tx = db.transaction(() => {
        insert(db, '1', 'x');
        throw new Error('boom');
      });
      expect(() => {
        tx();
      }).toThrow('boom');
      expect(count(db)).toBe(0);
    });

    // Sans bascule en SAVEPOINT, un BEGIN imbriqué lève « cannot start a transaction within a
    // transaction » : c'est ce que fait better-sqlite3 automatiquement.
    it('une transaction imbriquée devient un savepoint, annulable indépendamment', () => {
      const inner = db.transaction(() => {
        insert(db, '2', 'y');
        throw new Error('inner');
      });
      const outer = db.transaction(() => {
        insert(db, '1', 'x');
        try {
          inner();
        } catch {
          /* l'échec interne ne doit pas emporter l'externe */
        }
        insert(db, '3', 'z');
      });
      outer();
      expect(count(db)).toBe(2);
      expect(db.prepare('SELECT id FROM t ORDER BY id').all()).toEqual([{ id: '1' }, { id: '3' }]);
    });

    it('expose les trois comportements de better-sqlite3', () => {
      const tx = db.transaction(() => {
        insert(db, '1', 'x');
      });
      expect(typeof tx.deferred).toBe('function');
      expect(typeof tx.immediate).toBe('function');
      expect(typeof tx.exclusive).toBe('function');
      tx.immediate();
      expect(count(db)).toBe(1);
    });
  });

  // SQLite ouvre paresseusement : sur un fichier qui n'est pas une base, c'est le premier PRAGMA
  // qui échoue. Le handle doit être refermé avant que l'erreur ne remonte, sinon le fichier reste
  // verrouillé et l'appelant n'a rien à fermer — il n'a jamais reçu l'objet.
  it('une ouverture qui échoue ne laisse pas le fichier verrouillé', () => {
    const file = path.join(dir, 'pas-une-base.db');
    writeFileSync(file, 'ceci est du texte, pas du SQLite');
    expect(() => openSqliteFile(file)).toThrow();
    // Sous Windows, un handle resté ouvert ferait échouer la suppression avec EPERM.
    expect(() => {
      rmSync(file);
    }).not.toThrow();
  });

  describe('pragma() et lignes', () => {
    it('rend les lignes, ou la première valeur avec { simple: true }', () => {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }]);
      // Un PRAGMA d'écriture ne rend aucune ligne : `simple` doit valoir undefined, pas planter.
      expect(db.pragma('synchronous = NORMAL', { simple: true })).toBeUndefined();
    });

    // Les lignes de node:sqlite ont un prototype NUL : `row.hasOwnProperty(...)` jette, et une
    // comparaison stricte de test échoue. L'adaptateur rend des objets ordinaires.
    it('les lignes ont un prototype ordinaire', () => {
      db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('1', 'x');
      const row = db.prepare('SELECT id, a FROM t').get() as Record<string, unknown>;
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(row, 'id')).toBe(true);
      expect(row).toStrictEqual({ id: '1', a: 'x' });
    });

    // `raw()` est le mode « tableau » que Drizzle utilise pour TOUS les `db.select()`. Côté
    // node:sqlite c'est `setReturnArrays`, qui rend `undefined` : sans le `return this`,
    // `stmt.raw().all()` planterait.
    it('raw() rend le statement et bascule en lignes-tableaux', () => {
      db.prepare('INSERT INTO t (id, a) VALUES (?, ?)').run('1', 'x');
      const stmt = db.prepare('SELECT id, a FROM t');
      expect(stmt.raw().all()).toEqual([['1', 'x']]);
      expect(stmt.raw(false).all()).toEqual([{ id: '1', a: 'x' }]);
    });
  });
});
