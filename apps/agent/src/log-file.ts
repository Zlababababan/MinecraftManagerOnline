/**
 * Journal fichier de l'agent (lot 9) : `<stateDir>/logs/agent-<date>.log`, même ligne que stderr,
 * 14 jours conservés, 32 Mio par fichier puis suffixe numéroté (`@mmo/shared/node`, la mécanique
 * du journal du panel).
 *
 * Jusqu'ici l'agent n'écrivait que sur stderr — capturé ou non par le gestionnaire de service
 * (journald, shawl, launchd), jamais au même endroit — et relayait deux niveaux au panel : sur un
 * incident chez un tiers, il n'y avait littéralement rien à lire. Le panel demande la fin de ce
 * journal par `agent.diagnostics`, bornée en lignes et en octets.
 */
import path from 'node:path';

import {
  DEFAULT_LOG_RETENTION_DAYS,
  createRotatingLog,
  purgeRotatedLogs,
  tailRotatedLog,
  type LogTail,
} from '@mmo/shared/node';

import { formatEntry, type LogSink } from './log.js';

export const AGENT_LOG_PREFIX = 'agent';

export interface AgentLogSink {
  sink: LogSink;
  /** Chemin du fichier courant ; `undefined` si l'écriture fichier est indisponible. */
  readonly file: string | undefined;
  close(): void;
}

export function agentLogDir(stateDir: string): string {
  return path.join(stateDir, 'logs');
}

export function createAgentLogSink(stateDir: string, now: () => number = Date.now): AgentLogSink {
  const log = createRotatingLog({ dir: agentLogDir(stateDir), prefix: AGENT_LOG_PREFIX, now });
  return {
    sink: (entry) => {
      log.write(formatEntry(entry));
    },
    get file() {
      return log.file;
    },
    close: () => {
      log.close();
    },
  };
}

/** Fin du journal le plus récent, bornée en lignes ET en octets (`agent.diagnostics`). */
export function tailAgentLog(
  stateDir: string,
  options: { lines: number; maxBytes: number },
): LogTail {
  return tailRotatedLog(agentLogDir(stateDir), AGENT_LOG_PREFIX, options);
}

/** Purge par rétention, aussi hors bascule : un agent silencieux n'écrit pas, donc ne bascule pas. */
export function purgeAgentLogs(stateDir: string, now: number = Date.now()): number {
  return purgeRotatedLogs(agentLogDir(stateDir), AGENT_LOG_PREFIX, DEFAULT_LOG_RETENTION_DAYS, now);
}
