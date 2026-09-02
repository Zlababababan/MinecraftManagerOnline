/**
 * Lot 9 — `SqliteHandle.stats.statements` : le compteur qui rend les budgets de performance
 * mesurables (« combien d'instructions pour rendre la liste »). Chaque `run`, `get`, `all` et
 * `exec` compte une fois ; préparer une instruction sans l'exécuter ne compte pas.
 */
import { describe, expect, it } from 'vitest';

import { openSqliteFile } from './sqlite.js';

describe('SqliteHandle.stats', () => {
  it('compte run/get/all/exec, pas la préparation', () => {
    const db = openSqliteFile(':memory:');
    const opened = db.stats.statements;
    // L'ouverture pose ses PRAGMAs par `exec` : le compteur ne part pas de zéro, il part d'un état connu.
    expect(opened).toBeGreaterThan(0);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    expect(db.stats.statements).toBe(opened + 1);
    insert.run('a');
    insert.run('b');
    expect(db.stats.statements).toBe(opened + 3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT v FROM t ORDER BY id').all()).toHaveLength(2);
    expect(db.stats.statements).toBe(opened + 5);
    // Un `pragma()` passe par prepare().all() : il compte aussi.
    db.pragma('user_version');
    expect(db.stats.statements).toBe(opened + 6);
    db.close();
  });
});
