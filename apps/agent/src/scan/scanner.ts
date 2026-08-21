/**
 * Scan des répertoires surveillés (doc 06 §2, doc 05 §6 « Détection ») : `scanForServers` de
 * `@mmo/shared` sur l'adaptateur Node ; diff avec le dernier passage → `server.detected` (nouveau
 * ou premier passage de la session), `server.removed` (dossier disparu), `server.updated`
 * (métadonnées changées d'un serveur connu du panel).
 */
import type { DetectedServer, Os } from '@mmo/protocol';
import { scanForServers, type DetectFs } from '@mmo/shared';
import { createNodeDetectFs } from '@mmo/shared/node';

import { errorMessage, type Logger } from '../log.js';

export interface ScanTarget {
  id: string | undefined;
  path: string;
}

export interface ScanDiff {
  scannedPaths: string[];
  servers: DetectedServer[];
  added: { directoryId: string | undefined; server: DetectedServer }[];
  removed: { path: string; serverId: string | undefined }[];
  updated: { directoryId: string | undefined; server: DetectedServer; serverId: string }[];
}

export interface ScannerOptions {
  logger: Logger;
  os: Os;
  fs?: DetectFs;
  /** Chemins exclus (destination de backups…). */
  excludePaths?: () => string[];
  /** ID panel connu pour un chemin (configuration poussée), pour `server.updated`/`removed`. */
  serverIdForPath?: (path: string) => string | undefined;
  /**
   * Publie le diff, **une seule fois par scan réel**. Les appels concurrents partagent le scan en
   * cours (et donc n'émettent pas en double) ; seul le scan qui s'exécute vraiment déclenche ceci.
   */
  onDiff?: (diff: ScanDiff) => void;
}

export class Scanner {
  private readonly fs: DetectFs;
  private readonly known = new Map<
    string,
    { server: DetectedServer; directoryId: string | undefined }
  >();
  private running: Promise<ScanDiff> | undefined;

  constructor(private readonly options: ScannerOptions) {
    this.fs = options.fs ?? createNodeDetectFs();
  }

  get knownServers(): DetectedServer[] {
    return [...this.known.values()].map((k) => k.server);
  }

  /** Scan (sérialisé : un appel concurrent attend le scan en cours). */
  scan(targets: ScanTarget[]): Promise<ScanDiff> {
    if (this.running) return this.running;
    this.running = this.doScan(targets).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async doScan(targets: ScanTarget[]): Promise<ScanDiff> {
    const seen = new Map<string, { server: DetectedServer; directoryId: string | undefined }>();
    const scannedPaths: string[] = [];
    for (const target of targets) {
      scannedPaths.push(target.path);
      try {
        const found = await scanForServers(this.fs, target.path, {
          os: this.options.os,
          excludePaths: this.options.excludePaths?.() ?? [],
        });
        for (const server of found)
          seen.set(normalizePath(server.path), { server, directoryId: target.id });
      } catch (error) {
        this.options.logger.warn('scan failed', { path: target.path, error: errorMessage(error) });
      }
    }

    const diff: ScanDiff = {
      scannedPaths,
      servers: [...seen.values()].map((s) => s.server),
      added: [],
      removed: [],
      updated: [],
    };
    const scannedRoots = targets.map((t) => normalizePath(t.path));
    for (const [key, entry] of seen) {
      const previous = this.known.get(key);
      if (!previous) {
        diff.added.push({ directoryId: entry.directoryId, server: entry.server });
      } else if (fingerprint(previous.server) !== fingerprint(entry.server)) {
        const serverId =
          entry.server.markerServerId ?? this.options.serverIdForPath?.(entry.server.path);
        if (serverId !== undefined) {
          diff.updated.push({ directoryId: entry.directoryId, server: entry.server, serverId });
        }
      }
      this.known.set(key, entry);
    }
    for (const [key, entry] of this.known) {
      if (seen.has(key)) continue;
      // Seuls les dossiers sous une racine scannée peuvent être déclarés disparus.
      if (!scannedRoots.some((root) => key === root || key.startsWith(`${root}/`))) continue;
      this.known.delete(key);
      diff.removed.push({
        path: entry.server.path,
        serverId: entry.server.markerServerId ?? this.options.serverIdForPath?.(entry.server.path),
      });
    }
    this.options.onDiff?.(diff);
    return diff;
  }
}

export function normalizePath(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function fingerprint(s: DetectedServer): string {
  return JSON.stringify([
    s.loader.value,
    s.mcVersion?.value,
    s.loaderVersion?.value,
    s.maxRamMb.value,
    s.gamePort,
    s.rconPort,
    s.eulaAccepted,
    s.launch,
    s.needsInstall,
    s.modCount,
    s.markerServerId,
  ]);
}
