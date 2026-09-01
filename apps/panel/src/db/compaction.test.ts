/**
 * Compaction incrémentale bornée (lot 9). Sur de VRAIS fichiers : en `:memory:` la liste libre
 * existe mais rien n'est rendu à un système de fichiers, et c'est précisément ce qu'on vérifie.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openMetricsDatabase, openMmoDatabase, type OpenedDatabase } from './client.js';
import { freelistCount, incrementalVacuum } from './compaction.js';
import type { SqliteHandle } from './sqlite.js';

describe('incrementalVacuum — boucle bornée en temps', () => {
  let dir: string;
  let opened: OpenedDatabase<unknown> | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mmo-compaction-'));
  });
  afterEach(() => {
    opened?.close();
    opened = undefined;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('rend les pages libres dans le budget, puis reprend là où elle s’est arrêtée', () => {
    const file = path.join(dir, 'metrics.db');
    opened = openMetricsDatabase(file);
    const s = opened.sqlite;
    fillThenDelete(s, 'metrics_server_raw');
    const free = freelistCount(s);
    expect(free).toBeGreaterThan(64);

    // Budget nul avec une horloge factice : exactement un pas, le reste attend le passage suivant.
    let ticks = 0;
    const clock = () => ticks++ * 1000;
    const first = incrementalVacuum(s, { budgetMs: 0, pagesPerStep: 16, clock });
    expect(first.steps).toBe(1);
    expect(first.freedPages).toBe(16);
    expect(first.remainingPages).toBe(free - 16);

    // Budget large, même petit pas : tout est rendu en plusieurs pas et le fichier rétrécit
    // réellement (après checkpoint du WAL, qui porte la troncature).
    s.pragma('wal_checkpoint(TRUNCATE)');
    const before = statSync(file).size;
    const rest = incrementalVacuum(s, { budgetMs: 10_000, pagesPerStep: 16 });
    expect(rest.remainingPages).toBe(0);
    expect(rest.freedPages).toBe(free - 16);
    expect(rest.steps).toBe(Math.ceil((free - 16) / 16));
    s.pragma('wal_checkpoint(TRUNCATE)');
    expect(statSync(file).size).toBeLessThan(before);
  });

  it('sort au premier pas sans progrès : sans auto_vacuum, le PRAGMA est un no-op', () => {
    opened = openMmoDatabase(path.join(dir, 'mmo.db'));
    const s = opened.sqlite;
    fillThenDelete(s, 'audit_log');
    const free = freelistCount(s);
    expect(free).toBeGreaterThan(0);
    const r = incrementalVacuum(s, { budgetMs: 10_000 });
    expect(r.steps).toBe(1);
    expect(r.freedPages).toBe(0);
    expect(r.remainingPages).toBe(free);
  });
});

/** Remplit une table de quelques Mio puis la vide : la liste libre est alors bien garnie. */
function fillThenDelete(s: SqliteHandle, table: 'metrics_server_raw' | 'audit_log'): void {
  const insert =
    table === 'metrics_server_raw'
      ? s.prepare(
          'INSERT INTO metrics_server_raw (server_id, ts, cpu_pct, ram_mb, tps, mspt, players) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
      : s.prepare("INSERT INTO audit_log (ts, action, details) VALUES (?, 'test', ?)");
  const filler = 'x'.repeat(200);
  const tx = s.transaction(() => {
    for (let i = 0; i < 20_000; i++) {
      if (table === 'metrics_server_raw')
        insert.run(`srv-${String(i % 8)}`, i * 1000, 12.5, 2048, 20, 40, 3);
      else insert.run(i, filler);
    }
  });
  tx();
  s.exec(`DELETE FROM ${table}`);
}
