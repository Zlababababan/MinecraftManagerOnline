/**
 * Scan d'un répertoire surveillé (doc 06 §2) : chaque sous-dossier jusqu'à la profondeur 2 est
 * qualifié ; un dossier qualifié n'est pas exploré plus loin (son `world/` n'est pas un serveur).
 * `.mmo-trash/` et les destinations de backups sont exclus.
 */
import type { DetectedServer } from '@mmo/protocol';

import { detectServer, type DetectOptions } from './detect.js';
import { joinPath, type DetectFs } from './fs.js';

export interface ScanOptions extends DetectOptions {
  /** Profondeur maximale (0 = la racine seule). Défaut 2. */
  maxDepth?: number;
  /** Noms de dossiers ignorés (en plus de `.mmo-trash`). */
  excludeNames?: string[];
  /** Chemins absolus exclus (destinations de backups…). */
  excludePaths?: string[];
}

/** `<nom>.migrated-<yyyymmdd-hhmm>` : renommage fait par `migration.finalize` (doc 05 §8). */
export const MIGRATED_DIR = /\.migrated-\d{8}-\d{4}$/i;

const DEFAULT_EXCLUDED = new Set([
  '.mmo-trash',
  '.git',
  'node_modules',
  '$recycle.bin',
  'system volume information',
]);

export async function scanForServers(
  fs: DetectFs,
  root: string,
  options: ScanOptions = {},
): Promise<DetectedServer[]> {
  const maxDepth = options.maxDepth ?? 2;
  const excludedNames = new Set([
    ...DEFAULT_EXCLUDED,
    ...(options.excludeNames ?? []).map((n) => n.toLowerCase()),
  ]);
  const excludedPaths = new Set((options.excludePaths ?? []).map(normalize));
  const found: DetectedServer[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    if (excludedPaths.has(normalize(dir))) return;
    const detected = await detectServer(fs, dir, options);
    if (detected) {
      found.push(detected);
      return;
    }
    if (depth >= maxDepth) return;
    const entries = await fs.readdir(dir);
    for (const e of entries) {
      if (e.kind !== 'dir' || excludedNames.has(e.name.toLowerCase())) continue;
      // Phase 9 : dossier source d'une migration terminée (purge différée par l'agent) — jamais redétecté.
      if (MIGRATED_DIR.test(e.name)) continue;
      await visit(joinPath(dir, e.name), depth + 1);
    }
  }

  await visit(root, 0);
  return found;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
