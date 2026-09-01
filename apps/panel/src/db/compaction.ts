/**
 * Compaction incrémentale **bornée en temps** (doc 04 §7 et §8.3).
 *
 * `PRAGMA incremental_vacuum(N)` rend N pages de la liste libre au système de fichiers. L'appel
 * unique de 200 pages par jour qu'il remplace plafonnait la récupération à ~800 Kio/jour, très en
 * dessous de ce qu'une purge de rétention libère en une fois : `metrics.db` ne rétrécissait qu'en
 * apparence. La boucle rend tout ce qu'elle peut dans un budget de temps, puis s'arrête — le reste
 * attend le passage suivant. Le budget existe parce que la connexion est unique et synchrone :
 * chaque pas bloque la boucle d'événements du panel.
 */
import type { SqliteHandle } from './sqlite.js';

export interface IncrementalVacuumOptions {
  /** Temps maximal passé dans la boucle (défaut 250 ms). Au moins un pas est toujours tenté. */
  budgetMs?: number;
  /** Pages rendues par pas (défaut 256, soit 1 Mio en pages de 4 Kio). */
  pagesPerStep?: number;
  /** Horloge monotone en millisecondes, injectable (tests). */
  clock?: () => number;
}

export interface IncrementalVacuumResult {
  freedPages: number;
  steps: number;
  durationMs: number;
  /** Pages encore libres à la sortie : > 0 = budget épuisé, la reprise a lieu au passage suivant. */
  remainingPages: number;
}

/** Nombre de pages de la liste libre (`PRAGMA freelist_count`), tous modes `auto_vacuum` confondus. */
export function freelistCount(sqlite: SqliteHandle): number {
  return Number(sqlite.pragma('freelist_count', { simple: true }));
}

export function pageSize(sqlite: SqliteHandle): number {
  return Number(sqlite.pragma('page_size', { simple: true }));
}

export function incrementalVacuum(
  sqlite: SqliteHandle,
  options: IncrementalVacuumOptions = {},
): IncrementalVacuumResult {
  const budgetMs = options.budgetMs ?? 250;
  const step = options.pagesPerStep ?? 256;
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  const before = freelistCount(sqlite);
  let remaining = before;
  let steps = 0;
  while (remaining > 0) {
    sqlite.pragma(`incremental_vacuum(${String(step)})`);
    steps += 1;
    const after = freelistCount(sqlite);
    // Base sans `auto_vacuum` : le PRAGMA est un no-op et la liste libre ne bouge pas — sortir
    // plutôt que de consommer tout le budget pour rien.
    const progressed = after < remaining;
    remaining = after;
    if (!progressed || clock() - started >= budgetMs) break;
  }
  return {
    freedPages: before - remaining,
    steps,
    durationMs: Math.round(clock() - started),
    remainingPages: remaining,
  };
}
